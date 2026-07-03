/**
 * Live-preview server (gimpish serve).
 *
 * Watches the scene file's directory (covers scene.json + .scene_cache writes);
 * on any change it pushes {type:"reload"} over WebSocket so every client
 * re-fetches the freshly composited preview. HTTP surface mirrors the original
 * Python server: scene JSON, composite preview, per-layer geometry/sprites, and
 * delta-based transform commits.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { EncodeFormat, Layer, LayerBox, SceneDoc, Size } from "@gimpish/core";
import {
  applyMove,
  applyRotate,
  applyScale,
  encodeRaster,
  findLayer,
  imageSize,
  layerBox,
  loadScene,
  moveLayerTo,
  rasterToPng,
  removeLayer,
  renderLayerSprite,
  renderPreview,
  renderScene,
  saveScene,
  sceneRoot,
  textBounds,
} from "@gimpish/core";
import { watch } from "chokidar";
import fastify, { type FastifyInstance } from "fastify";
import { BUNDLE_EXT, createBundle, extractBundle } from "../bundle.ts";
import { SceneHistory } from "./history.ts";
import { importImage } from "./imports.ts";

/** Built web client, served when present (repo: packages/web/dist). */
const WEB_DIST = path.resolve(import.meta.dirname, "../../../web/dist");

const WATCH_DEBOUNCE_MS = 80;

/** Minimal surface of the ws socket we use (repo doesn't ship @types/ws). */
interface WsSocket {
  send(data: string): void;
  on(event: "close" | "error", listener: () => void): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Python-parity coercion: missing/null/0/"" fall back (`float(body.get(k, d) or d)`). */
function toNumber(value: unknown, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseHide(hide: string | undefined): ReadonlySet<string> | undefined {
  const ids = new Set((hide ?? "").split(",").filter((id) => id));
  return ids.size > 0 ? ids : undefined;
}

/**
 * Selection box for one layer, resolving the measurements layerBox needs:
 * natural size for images, rendered alpha bounds for text. Layers whose
 * measurement fails are skipped (no box), matching the Python server.
 */
async function boxFor(doc: SceneDoc, layer: Layer): Promise<LayerBox | null> {
  if (layer.type === "image") {
    try {
      const naturalSize = await imageSize(path.join(sceneRoot(doc), layer.source));
      return layerBox(doc.scene, layer, { naturalSize });
    } catch {
      return null;
    }
  }
  if (layer.type === "text") {
    try {
      const bounds = await textBounds(doc, layer);
      if (!bounds) return null;
      return layerBox(doc.scene, layer, { textBounds: bounds });
    } catch {
      return null;
    }
  }
  return layerBox(doc.scene, layer);
}

const EXPORT_FORMATS: Record<string, { format: EncodeFormat; mime: string }> = {
  png: { format: "png", mime: "image/png" },
  jpg: { format: "jpg", mime: "image/jpeg" },
  jpeg: { format: "jpg", mime: "image/jpeg" },
  webp: { format: "webp", mime: "image/webp" },
};

/** Raised body limit so full-resolution photo uploads fit (fastify default is 1 MB). */
const BODY_LIMIT = 256 * 1024 * 1024;

export function createApp(scenePath: string): FastifyInstance {
  const scene = path.resolve(scenePath);
  const app = fastify({ bodyLimit: BODY_LIMIT });
  const sockets = new Set<WsSocket>();
  const history = new SceneHistory(scene);

  // Uploads arrive as raw bytes (application/octet-stream), not multipart.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );

  // One error shape for every route: {error} (scene-load failures, render
  // failures, bad requests all surface the same way to the UI).
  app.setErrorHandler((err: unknown, _req, reply) => {
    const statusCode =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
    reply.code(statusCode).send({ error: errorMessage(err) });
  });

  // ---- websocket + file watching ------------------------------------------------

  app.register(fastifyWebsocket);
  app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket: WsSocket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    });
  });

  // Watch the scene file's directory (covers scene.json + .scene_cache writes),
  // collapsing event bursts into one reload broadcast. Heavy unrelated trees
  // are excluded so serving from a project root doesn't watch node_modules.
  const watcher = watch(path.dirname(scene), {
    ignoreInitial: true,
    ignored: (watchedPath: string) =>
      /(?:^|\/)(?:node_modules|\.git|\.venv|dist)(?:\/|$)/.test(watchedPath),
  });
  let pending: NodeJS.Timeout | undefined;
  watcher.on("all", (_event: string, changedPath: string) => {
    // Scene changes from any writer (CLI, agent, editor) become undo steps.
    if (path.resolve(changedPath) === scene) history.sync();
    clearTimeout(pending);
    pending = setTimeout(() => {
      const message = JSON.stringify({ type: "reload" });
      for (const socket of sockets) {
        try {
          socket.send(message);
        } catch {
          sockets.delete(socket);
        }
      }
    }, WATCH_DEBOUNCE_MS);
  });
  app.addHook("onClose", async () => {
    clearTimeout(pending);
    await watcher.close();
  });

  // ---- static client --------------------------------------------------------------

  if (existsSync(path.join(WEB_DIST, "index.html"))) {
    app.register(fastifyStatic, { root: WEB_DIST });
  } else {
    app.get("/", async (_req, reply) =>
      reply.type("text/plain").send("web app not built — run `npm run build` first."),
    );
  }

  app.get("/favicon.ico", async (_req, reply) => reply.code(204).send()); // silence the browser's auto-request

  // ---- scene API -------------------------------------------------------------------

  app.get("/api/scene", async () => loadScene(scene).scene);

  app.get<{ Querystring: { max?: string; hide?: string } }>(
    "/api/preview.png",
    async (req, reply) => {
      const doc = loadScene(scene);
      const img = await renderPreview(
        doc,
        toNumber(req.query.max, 1400),
        parseHide(req.query.hide),
      );
      return reply
        .header("Cache-Control", "no-store")
        .type("image/png")
        .send(await rasterToPng(img));
    },
  );

  app.get("/api/geometry", async () => {
    const doc = loadScene(scene);
    const boxes: LayerBox[] = [];
    for (const layer of doc.scene.layers) {
      if (!layer.visible) continue;
      const box = await boxFor(doc, layer);
      if (box) boxes.push(box);
    }
    const { width, height } = doc.scene.canvas;
    return { canvas: { width, height }, boxes };
  });

  app.get<{ Params: { id: string }; Querystring: { max?: string } }>(
    "/api/layer/:id/sprite.png",
    async (req, reply) => {
      const doc = loadScene(scene);
      let layer: Layer;
      try {
        layer = findLayer(doc.scene, req.params.id);
      } catch (err) {
        return reply.code(404).send({ error: errorMessage(err) });
      }
      const img = await renderLayerSprite(doc, layer, toNumber(req.query.max, 1400));
      return reply
        .header("Cache-Control", "no-store")
        .type("image/png")
        .send(await rasterToPng(img));
    },
  );

  /**
   * Translate/rotate/scale a layer and persist. Body: {dx?, dy?, drot?, scale?}
   * where scale is a multiplicative factor. The file write trips the watcher,
   * which pushes a reload to every connected client.
   */
  app.post<{
    Params: { id: string };
    Body: { dx?: unknown; dy?: unknown; drot?: unknown; scale?: unknown } | null;
  }>("/api/layer/:id/transform", async (req, reply) => {
    const doc = loadScene(scene);
    let layer: Layer;
    try {
      layer = findLayer(doc.scene, req.params.id);
    } catch {
      return reply.code(404).send({ error: `no layer ${JSON.stringify(req.params.id)}` });
    }

    const body = req.body ?? {};
    const dx = toNumber(body.dx, 0);
    const dy = toNumber(body.dy, 0);
    const drot = toNumber(body.drot, 0);
    const scaleFactor = toNumber(body.scale, 1);

    if (dx || dy) applyMove(doc.scene, layer, dx, dy);
    if (drot) applyRotate(doc.scene, layer, drot);
    if (scaleFactor !== 1) {
      let naturalSize: Size | undefined;
      if (layer.type === "image") {
        try {
          naturalSize = await imageSize(path.join(sceneRoot(doc), layer.source));
        } catch {
          naturalSize = undefined; // applyScale is a no-op for images without it
        }
      }
      applyScale(layer, scaleFactor, naturalSize);
    }
    saveScene(doc);
    history.sync();
    return { ok: true };
  });

  /** Reorder a layer to an absolute paint-order index (0 = back), `layer move --to` semantics. */
  app.post<{ Params: { id: string }; Body: { index?: unknown } | null }>(
    "/api/layer/:id/order",
    async (req, reply) => {
      const doc = loadScene(scene);
      const index = Number(req.body?.index);
      if (!Number.isFinite(index)) {
        return reply.code(400).send({ error: "body must be {index: <number>}" });
      }
      let moved: number;
      try {
        moved = moveLayerTo(doc.scene, req.params.id, index);
      } catch {
        return reply.code(404).send({ error: `no layer ${JSON.stringify(req.params.id)}` });
      }
      saveScene(doc);
      history.sync();
      return { ok: true, index: moved };
    },
  );

  /** Delete a layer. Asset files are left on disk (scene sources are never destroyed). */
  app.delete<{ Params: { id: string } }>("/api/layer/:id", async (req, reply) => {
    const doc = loadScene(scene);
    try {
      removeLayer(doc.scene, req.params.id);
    } catch {
      return reply.code(404).send({ error: `no layer ${JSON.stringify(req.params.id)}` });
    }
    saveScene(doc);
    history.sync();
    return { ok: true };
  });

  // ---- undo / redo -------------------------------------------------------------------

  app.get("/api/history", async () => history.depths());

  app.post("/api/undo", async (_req, reply) => {
    const depths = history.undo();
    if (!depths) return reply.code(409).send({ error: "nothing to undo" });
    return { ok: true, ...depths };
  });

  app.post("/api/redo", async (_req, reply) => {
    const depths = history.redo();
    if (!depths) return reply.code(409).send({ error: "nothing to redo" });
    return { ok: true, ...depths };
  });

  // ---- export / import ---------------------------------------------------------------

  const downloadName = (ext: string) => `${path.parse(scene).name}${ext}`;

  /** Positive pixel dimension from a query param, clamped; undefined if absent/invalid. */
  const sizeParam = (value: string | undefined): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(10000, Math.round(n)) : undefined;
  };

  /**
   * Render as a browser download (png/jpg/webp). Optional width/height scale
   * the output; one alone preserves aspect, both together may stretch.
   */
  app.get<{ Querystring: { format?: string; quality?: string; width?: string; height?: string } }>(
    "/api/export",
    async (req, reply) => {
      const spec = EXPORT_FORMATS[req.query.format ?? "png"];
      if (!spec) {
        return reply.code(400).send({
          error: `unknown format ${JSON.stringify(req.query.format)}; use png, jpg, or webp`,
        });
      }
      const doc = loadScene(scene);
      const img = await renderScene(doc, {
        width: sizeParam(req.query.width),
        height: sizeParam(req.query.height),
      });
      const bytes = await encodeRaster(img, spec.format, toNumber(req.query.quality, 90));
      return reply
        .header("Content-Disposition", `attachment; filename="${downloadName(`.${spec.format}`)}"`)
        .type(spec.mime)
        .send(bytes);
    },
  );

  /** Scene + every referenced asset, zipped as a relocatable .gimpish bundle. */
  app.get("/api/bundle", async (_req, reply) => {
    const doc = loadScene(scene);
    const zip = createBundle(doc);
    return reply
      .header("Content-Disposition", `attachment; filename="${downloadName(BUNDLE_EXT)}"`)
      .type("application/zip")
      .send(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength));
  });

  /**
   * Upload: raw file bytes, original filename in ?name=. Images land in
   * assets/ and become a top layer; a .gimpish bundle replaces the whole scene
   * (previous scene file kept as .bak). The scene write trips the watcher, so
   * every client reloads.
   */
  app.post<{ Querystring: { name?: string }; Body: Buffer }>("/api/import", async (req, reply) => {
    const name = req.query.name;
    if (!name) return reply.code(400).send({ error: "missing ?name=<original filename>" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: "send raw file bytes as application/octet-stream" });
    }

    if (name.toLowerCase().endsWith(BUNDLE_EXT)) {
      try {
        const loaded = extractBundle(req.body, scene);
        history.sync();
        return { ok: true, kind: "bundle", layers: loaded.layers.length };
      } catch (err) {
        return reply.code(400).send({ error: `bundle import failed: ${errorMessage(err)}` });
      }
    }

    try {
      const imported = await importImage(scene, name, req.body);
      history.sync();
      return { ok: true, kind: "image", ...imported };
    } catch (err) {
      return reply.code(400).send({ error: `not an importable image: ${errorMessage(err)}` });
    }
  });

  return app;
}

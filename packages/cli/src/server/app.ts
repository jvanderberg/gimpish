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
import type { Layer, LayerBox, SceneDoc, Size } from "@gimpish/core";
import {
  applyMove,
  applyRotate,
  applyScale,
  findLayer,
  imageSize,
  layerBox,
  loadScene,
  rasterToPng,
  renderLayerSprite,
  renderPreview,
  saveScene,
  sceneRoot,
  textBounds,
} from "@gimpish/core";
import { watch } from "chokidar";
import fastify, { type FastifyInstance } from "fastify";

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

export function createApp(scenePath: string): FastifyInstance {
  const scene = path.resolve(scenePath);
  const app = fastify();
  const sockets = new Set<WsSocket>();

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
  // collapsing event bursts into one reload broadcast.
  const watcher = watch(path.dirname(scene), { ignoreInitial: true });
  let pending: NodeJS.Timeout | undefined;
  watcher.on("all", () => {
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

  app.get("/api/scene", async (_req, reply) => {
    try {
      return loadScene(scene).scene;
    } catch (err) {
      // surface scene-read errors to the UI
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

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

  app.get("/api/geometry", async (_req, reply) => {
    let doc: SceneDoc;
    try {
      doc = loadScene(scene);
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
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
    let doc: SceneDoc;
    try {
      doc = loadScene(scene);
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
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
    return { ok: true };
  });

  return app;
}

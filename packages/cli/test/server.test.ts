/**
 * Live-preview server tests. Each test gets a fresh scene.json in a temp dir
 * (one shape, radial + linear gradients, text, arrow, and a tiny generated
 * image layer) and a fresh app; routes are exercised via fastify inject.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArrowLayer, ImageLayer, LayerBox, Scene, ShapeLayer } from "@gimpish/core";
import type { FastifyInstance } from "fastify";
import { unzipSync, zipSync } from "fflate";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "gimpish-server-"));
const scenePath = path.join(tmp, "scene.json");
let app: FastifyInstance;

const IMG_W = 8;
const IMG_H = 6;

function makeScene(): Record<string, unknown> {
  return {
    version: 1,
    canvas: { width: 200, height: 120, background: "#101018ff" },
    layers: [
      {
        id: "panel",
        type: "shape",
        shape: "rect",
        rect: { x: 10, y: 10, w: 60, h: 40 },
        fill: "#3068b0ff",
      },
      {
        id: "glow",
        type: "gradient",
        gradient: {
          kind: "radial",
          center: [0.5, 0.5],
          stops: [
            { at: 0, color: "#ffffffff" },
            { at: 1, color: "#ffffff00" },
          ],
        },
      },
      {
        id: "wash",
        type: "gradient",
        gradient: {
          kind: "linear",
          angle: 30,
          stops: [
            { at: 0, color: "#00000000" },
            { at: 1, color: "#000000aa" },
          ],
        },
      },
      { id: "title", type: "text", text: { content: "Hi", x: 100, y: 60, size: 24 } },
      {
        id: "point",
        type: "arrow",
        arrow: { from_x: 20, from_y: 100, to_x: 120, to_y: 80, width: 6 },
      },
      {
        id: "photo",
        type: "image",
        source: "tiny.png",
        transform: { x: 5, y: 5, scale: 2, rotation: 0 },
      },
    ],
  };
}

function readSceneFromDisk(): Scene {
  return JSON.parse(readFileSync(scenePath, "utf8")) as Scene;
}

function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function expectPng(buf: Buffer): void {
  expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
}

beforeAll(async () => {
  await sharp({
    create: {
      width: IMG_W,
      height: IMG_H,
      channels: 4,
      background: { r: 220, g: 40, b: 40, alpha: 1 },
    },
  })
    .png()
    .toFile(path.join(tmp, "tiny.png"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  writeFileSync(scenePath, `${JSON.stringify(makeScene(), null, 2)}\n`);
  app = createApp(scenePath);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("basic routes", () => {
  it("GET / responds 200 (web app or build hint)", async () => {
    const res = await app.inject({ url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("GET /favicon.ico returns 204 with no body", async () => {
    const res = await app.inject({ url: "/favicon.ico" });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });
});

describe("GET /api/scene", () => {
  it("returns the scene with all layers", async () => {
    const res = await app.inject({ url: "/api/scene" });
    expect(res.statusCode).toBe(200);
    const scene = res.json() as Scene;
    expect(scene.canvas).toMatchObject({ width: 200, height: 120 });
    expect(scene.layers.map((l) => l.id)).toEqual([
      "panel",
      "glow",
      "wash",
      "title",
      "point",
      "photo",
    ]);
  });

  it("returns 500 with an error message for an unreadable scene", async () => {
    writeFileSync(scenePath, "{not json");
    const res = await app.inject({ url: "/api/scene" });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

describe("GET /api/preview.png", () => {
  it("returns a PNG capped at max", async () => {
    const res = await app.inject({ url: "/api/preview.png?max=100" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("no-store");
    expectPng(res.rawPayload);
    expect(pngSize(res.rawPayload)).toEqual({ width: 100, height: 60 }); // 200x120 → max 100
  });

  it("hide=<id> still renders and produces different bytes", async () => {
    const full = await app.inject({ url: "/api/preview.png" });
    const hidden = await app.inject({ url: "/api/preview.png?hide=photo" });
    expect(hidden.statusCode).toBe(200);
    expectPng(hidden.rawPayload);
    expect(Buffer.compare(hidden.rawPayload, full.rawPayload)).not.toBe(0);
  });
});

describe("GET /api/geometry", () => {
  it("returns boxes for all visible layers with capability flags", async () => {
    const res = await app.inject({ url: "/api/geometry" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { canvas: { width: number; height: number }; boxes: LayerBox[] };
    expect(body.canvas).toEqual({ width: 200, height: 120 });
    expect(body.boxes.map((b) => b.id)).toEqual([
      "panel",
      "glow",
      "wash",
      "title",
      "point",
      "photo",
    ]);

    const byId = new Map(body.boxes.map((b) => [b.id, b]));
    const flags = (id: string) => {
      const b = byId.get(id);
      if (!b) throw new Error(`no box for ${id}`);
      return { move: b.move, rotate: b.rotate, scale: b.scale };
    };
    expect(flags("glow")).toEqual({ move: true, rotate: false, scale: false }); // radial gradient
    expect(flags("wash")).toEqual({ move: false, rotate: true, scale: false }); // linear gradient
    for (const id of ["panel", "title", "point", "photo"]) {
      expect(flags(id)).toEqual({ move: true, rotate: true, scale: true });
    }

    // Image box math: natural 8x6 at scale 2, top-left (5, 5).
    const photo = byId.get("photo");
    expect(photo?.w).toBeCloseTo(IMG_W * 2);
    expect(photo?.h).toBeCloseTo(IMG_H * 2);
    expect(photo?.cx).toBeCloseTo(5 + (IMG_W * 2) / 2);
    expect(photo?.cy).toBeCloseTo(5 + (IMG_H * 2) / 2);

    // Linear gradient indicator carries the gradient angle.
    expect(byId.get("wash")?.rotation).toBeCloseTo(30);
  });

  it("excludes invisible layers", async () => {
    const scene = readSceneFromDisk();
    const panel = scene.layers.find((l) => l.id === "panel");
    if (!panel) throw new Error("missing panel layer");
    panel.visible = false;
    writeFileSync(scenePath, JSON.stringify(scene));

    const res = await app.inject({ url: "/api/geometry" });
    const body = res.json() as { boxes: LayerBox[] };
    expect(body.boxes.map((b) => b.id)).not.toContain("panel");
    expect(body.boxes.map((b) => b.id)).toContain("glow");
  });
});

describe("GET /api/layer/:id/sprite.png", () => {
  it("returns a canvas-sized PNG for a known layer", async () => {
    const res = await app.inject({ url: "/api/layer/panel/sprite.png" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expectPng(res.rawPayload);
    expect(pngSize(res.rawPayload)).toEqual({ width: 200, height: 120 });
  });

  it("404s for an unknown layer id", async () => {
    const res = await app.inject({ url: "/api/layer/nope/sprite.png" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain("nope");
  });
});

describe("POST /api/layer/:id/transform", () => {
  it("moves a shape rect and persists to disk", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/layer/panel/transform",
      payload: { dx: 5, dy: -3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const panel = readSceneFromDisk().layers.find((l) => l.id === "panel") as ShapeLayer;
    expect(panel.rect.x).toBeCloseTo(15);
    expect(panel.rect.y).toBeCloseTo(7);
  });

  it("rotates an arrow's endpoints about its midpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/layer/point/transform",
      payload: { drot: 90 },
    });
    expect(res.statusCode).toBe(200);

    // Midpoint (70, 90); 90° clockwise: (20,100)→(60,40), (120,80)→(80,140).
    const arrow = (readSceneFromDisk().layers.find((l) => l.id === "point") as ArrowLayer).arrow;
    expect(arrow.from_x).toBeCloseTo(60);
    expect(arrow.from_y).toBeCloseTo(40);
    expect(arrow.to_x).toBeCloseTo(80);
    expect(arrow.to_y).toBeCloseTo(140);
  });

  it("scales an image about its center, adjusting transform.scale and x/y", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/layer/photo/transform",
      payload: { scale: 0.5 },
    });
    expect(res.statusCode).toBe(200);

    // Center (13, 11) held fixed: scale 2→1, top-left (5,5)→(9,8).
    const t = (readSceneFromDisk().layers.find((l) => l.id === "photo") as ImageLayer).transform;
    expect(t.scale).toBeCloseTo(1);
    expect(t.x).toBeCloseTo(9);
    expect(t.y).toBeCloseTo(8);
  });

  it("404s for an unknown layer id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/layer/nope/transform",
      payload: { dx: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain("nope");
  });
});

describe("undo/redo", () => {
  function panelX(): number {
    return (readSceneFromDisk().layers.find((l) => l.id === "panel") as ShapeLayer).rect.x;
  }

  it("undoes and redoes an editor mutation", async () => {
    await app.inject({ method: "POST", url: "/api/layer/panel/transform", payload: { dx: 5 } });
    expect(panelX()).toBeCloseTo(15);

    const undo = await app.inject({ method: "POST", url: "/api/undo" });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toEqual({ ok: true, undo: 0, redo: 1 });
    expect(panelX()).toBeCloseTo(10);

    const redo = await app.inject({ method: "POST", url: "/api/redo" });
    expect(redo.statusCode).toBe(200);
    expect(redo.json()).toEqual({ ok: true, undo: 1, redo: 0 });
    expect(panelX()).toBeCloseTo(15);
  });

  it("captures external scene writes (CLI / agent edits) as undo steps", async () => {
    const scene = readSceneFromDisk();
    const panel = scene.layers.find((l) => l.id === "panel") as ShapeLayer;
    panel.rect.x = 77;
    writeFileSync(scenePath, JSON.stringify(scene)); // no watcher wait needed: undo() syncs first

    const undo = await app.inject({ method: "POST", url: "/api/undo" });
    expect(undo.statusCode).toBe(200);
    expect(panelX()).toBeCloseTo(10);
  });

  it("clears redo on a new edit and 409s when history is empty", async () => {
    const empty = await app.inject({ method: "POST", url: "/api/undo" });
    expect(empty.statusCode).toBe(409);

    await app.inject({ method: "POST", url: "/api/layer/panel/transform", payload: { dx: 1 } });
    await app.inject({ method: "POST", url: "/api/undo" });
    await app.inject({ method: "POST", url: "/api/layer/panel/transform", payload: { dx: 2 } });
    const redo = await app.inject({ method: "POST", url: "/api/redo" });
    expect(redo.statusCode).toBe(409);
  });

  it("stacks multiple steps and reports depths via GET /api/history", async () => {
    for (const dx of [1, 1, 1]) {
      await app.inject({ method: "POST", url: "/api/layer/panel/transform", payload: { dx } });
    }
    expect((await app.inject({ url: "/api/history" })).json()).toEqual({ undo: 3, redo: 0 });

    await app.inject({ method: "POST", url: "/api/undo" });
    await app.inject({ method: "POST", url: "/api/undo" });
    expect((await app.inject({ url: "/api/history" })).json()).toEqual({ undo: 1, redo: 2 });
    expect(panelX()).toBeCloseTo(11);
  });

  it("undoes a delete, restoring the layer", async () => {
    await app.inject({ method: "DELETE", url: "/api/layer/photo" });
    expect(readSceneFromDisk().layers.map((l) => l.id)).not.toContain("photo");
    await app.inject({ method: "POST", url: "/api/undo" });
    expect(readSceneFromDisk().layers.map((l) => l.id)).toContain("photo");
  });
});

describe("POST /api/layer/:id/order", () => {
  it("moves a layer to an absolute paint index and persists", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/layer/photo/order",
      payload: { index: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, index: 0 });
    expect(readSceneFromDisk().layers.map((l) => l.id)).toEqual([
      "photo",
      "panel",
      "glow",
      "wash",
      "title",
      "point",
    ]);
  });

  it("clamps out-of-range indices to the top", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/layer/panel/order",
      payload: { index: 99 },
    });
    expect(res.json()).toEqual({ ok: true, index: 5 });
    expect(readSceneFromDisk().layers.at(-1)?.id).toBe("panel");
  });

  it("400s without a numeric index and 404s for unknown layers", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/layer/panel/order", payload: {} });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/api/layer/nope/order",
      payload: { index: 1 },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/layer/:id/visible", () => {
  it("hides and re-shows a layer and persists", async () => {
    const hide = await app.inject({
      method: "POST",
      url: "/api/layer/photo/visible",
      payload: { visible: false },
    });
    expect(hide.statusCode).toBe(200);
    expect(hide.json()).toEqual({ ok: true });
    expect(readSceneFromDisk().layers.find((l) => l.id === "photo")?.visible).toBe(false);

    const show = await app.inject({
      method: "POST",
      url: "/api/layer/photo/visible",
      payload: { visible: true },
    });
    expect(show.statusCode).toBe(200);
    expect(readSceneFromDisk().layers.find((l) => l.id === "photo")?.visible).toBe(true);
  });

  it("400s without a boolean and 404s for unknown layers", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/layer/photo/visible",
      payload: {},
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/api/layer/nope/visible",
      payload: { visible: false },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("DELETE /api/layer/:id", () => {
  it("removes the layer and persists", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/layer/photo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(readSceneFromDisk().layers.map((l) => l.id)).not.toContain("photo");
    expect(readSceneFromDisk().layers).toHaveLength(5);
  });

  it("404s for an unknown layer id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/layer/nope" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain("nope");
  });
});

describe("GET /api/export", () => {
  it("returns a full-resolution PNG attachment by default", async () => {
    const res = await app.inject({ url: "/api/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="scene.png"');
    expectPng(res.rawPayload);
    expect(pngSize(res.rawPayload)).toEqual({ width: 200, height: 120 }); // full res, not preview-capped
  });

  it("encodes jpg and webp", async () => {
    const jpg = await app.inject({ url: "/api/export?format=jpg" });
    expect(jpg.statusCode).toBe(200);
    expect(jpg.headers["content-type"]).toBe("image/jpeg");
    expect([...jpg.rawPayload.subarray(0, 2)]).toEqual([0xff, 0xd8]);

    const webp = await app.inject({ url: "/api/export?format=webp" });
    expect(webp.statusCode).toBe(200);
    expect(webp.headers["content-type"]).toBe("image/webp");
    expect(webp.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("400s on an unknown format", async () => {
    const res = await app.inject({ url: "/api/export?format=gif" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("gif");
  });

  it("scales output by width (aspect preserved) or width+height (stretch)", async () => {
    const half = await app.inject({ url: "/api/export?width=100" });
    expect(half.statusCode).toBe(200);
    expect(pngSize(half.rawPayload)).toEqual({ width: 100, height: 60 });

    const stretched = await app.inject({ url: "/api/export?width=100&height=100" });
    expect(pngSize(stretched.rawPayload)).toEqual({ width: 100, height: 100 });
  });

  it("ignores invalid sizes and clamps huge ones", async () => {
    const bad = await app.inject({ url: "/api/export?width=banana" });
    expect(pngSize(bad.rawPayload)).toEqual({ width: 200, height: 120 }); // native

    const huge = await app.inject({ url: "/api/export?width=999999&height=60" });
    expect(pngSize(huge.rawPayload).width).toBe(10000);
  });
});

describe("GET /api/bundle", () => {
  it("zips scene.json plus referenced assets, flattened into assets/", async () => {
    const res = await app.inject({ url: "/api/bundle" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="scene.gimpish"');

    const entries = unzipSync(res.rawPayload);
    expect(Object.keys(entries).sort()).toEqual(["assets/tiny.png", "scene.json"]);
    const scene = JSON.parse(new TextDecoder().decode(entries["scene.json"])) as Scene;
    const photo = scene.layers.find((l) => l.id === "photo") as ImageLayer;
    expect(photo.source).toBe("assets/tiny.png");
  });

  it("never encodes source directory layout — nested and absolute paths flatten alike", async () => {
    const nested = path.join(tmp, "downloads/deep");
    mkdirSync(nested, { recursive: true });
    copyFileSync(path.join(tmp, "tiny.png"), path.join(nested, "My Pic.png"));

    const scene = readSceneFromDisk();
    const photo = scene.layers.find((l) => l.id === "photo") as ImageLayer;
    photo.source = "downloads/deep/My Pic.png"; // in-root but nested
    scene.layers.push({
      ...photo,
      id: "photo2",
      source: path.join(tmp, "tiny.png"), // absolute
    });
    writeFileSync(scenePath, JSON.stringify(scene));

    const res = await app.inject({ url: "/api/bundle" });
    const entries = unzipSync(res.rawPayload);
    expect(Object.keys(entries).sort()).toEqual([
      "assets/my-pic.png",
      "assets/tiny.png",
      "scene.json",
    ]);
    const bundled = JSON.parse(new TextDecoder().decode(entries["scene.json"])) as Scene;
    const sources = bundled.layers.filter((l) => l.type === "image").map((l) => l.source);
    expect(sources).toEqual(["assets/my-pic.png", "assets/tiny.png"]);
  });

  it("keeps cutout caches under .scene_cache/ by basename", async () => {
    const cacheSrc = path.join(tmp, "elsewhere");
    mkdirSync(cacheSrc, { recursive: true });
    copyFileSync(path.join(tmp, "tiny.png"), path.join(cacheSrc, "photo_cutout.png"));

    const scene = readSceneFromDisk();
    const photo = scene.layers.find((l) => l.id === "photo") as ImageLayer;
    photo.mask = {
      kind: "cutout",
      cache: "elsewhere/photo_cutout.png",
      feather: 0,
      invert: false,
    };
    writeFileSync(scenePath, JSON.stringify(scene));

    const res = await app.inject({ url: "/api/bundle" });
    const entries = unzipSync(res.rawPayload);
    expect(Object.keys(entries).sort()).toEqual([
      ".scene_cache/photo_cutout.png",
      "assets/tiny.png",
      "scene.json",
    ]);
    const bundled = JSON.parse(new TextDecoder().decode(entries["scene.json"])) as Scene;
    const bundledPhoto = bundled.layers.find((l) => l.id === "photo") as ImageLayer;
    expect(bundledPhoto.mask?.cache).toBe(".scene_cache/photo_cutout.png");
  });

  it("500s with the missing path when a referenced asset does not exist", async () => {
    const scene = readSceneFromDisk();
    const photo = scene.layers.find((l) => l.id === "photo") as ImageLayer;
    photo.source = "gone.png";
    writeFileSync(scenePath, JSON.stringify(scene));

    const res = await app.inject({ url: "/api/bundle" });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: string }).error).toContain("gone.png");
  });
});

describe("POST /api/import", () => {
  async function makeUpload(w: number, h: number): Promise<Buffer> {
    return sharp({
      create: { width: w, height: h, channels: 4, background: { r: 20, g: 200, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer();
  }

  function post(name: string, body: Buffer) {
    return app.inject({
      method: "POST",
      url: `/api/import?name=${encodeURIComponent(name)}`,
      headers: { "content-type": "application/octet-stream" },
      body,
    });
  }

  it("saves the image under assets/ and adds a fitted, centered top layer", async () => {
    const res = await post("My Photo.PNG", await makeUpload(400, 120));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      kind: "image",
      id: "my-photo",
      source: "assets/my-photo.png",
      width: 400,
      height: 120,
    });
    expect(existsSync(path.join(tmp, "assets/my-photo.png"))).toBe(true);

    const layers = readSceneFromDisk().layers;
    const added = layers[layers.length - 1] as ImageLayer;
    expect(added.id).toBe("my-photo");
    // 400x120 into 200x120: scale 0.5, centered → x=0, y=30.
    expect(added.transform.scale).toBeCloseTo(0.5);
    expect(added.transform.x).toBe(0);
    expect(added.transform.y).toBe(30);
  });

  it("reuses identical asset bytes but still creates a distinct layer id", async () => {
    const bytes = await makeUpload(40, 40);
    await post("dup.png", bytes);
    const res = await post("dup.png", bytes);
    expect(res.json()).toMatchObject({ id: "dup2", source: "assets/dup.png" });
    expect(existsSync(path.join(tmp, "assets/dup-2.png"))).toBe(false);
  });

  it("suffixes the asset file when the same name arrives with different content", async () => {
    await post("clash.png", await makeUpload(30, 30));
    const res = await post("clash.png", await makeUpload(31, 31));
    expect(res.json()).toMatchObject({ id: "clash2", source: "assets/clash-2.png" });
  });

  it("400s on non-image bytes and on a missing name", async () => {
    const bad = await post("notes.txt", Buffer.from("hello"));
    expect(bad.statusCode).toBe(400);

    const unnamed = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { "content-type": "application/octet-stream" },
      body: await makeUpload(10, 10),
    });
    expect(unnamed.statusCode).toBe(400);
  });

  it("round-trips a .gimpish bundle, replacing the scene and backing up the old one", async () => {
    const bundle = await app.inject({ url: "/api/bundle" });

    // Wipe the scene, then restore it from the bundle.
    writeFileSync(
      scenePath,
      JSON.stringify({ version: 1, canvas: { width: 10, height: 10 }, layers: [] }),
    );
    const res = await post("scene.gimpish", bundle.rawPayload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, kind: "bundle", layers: 6 });

    const restored = readSceneFromDisk();
    expect(restored.canvas).toMatchObject({ width: 200, height: 120 });
    expect(restored.layers).toHaveLength(6);
    expect(existsSync(`${scenePath}.bak`)).toBe(true);

    const render = await app.inject({ url: "/api/preview.png" });
    expect(render.statusCode).toBe(200); // assets extracted where the scene expects them
  });

  it("rejects bundles with path-escaping entries", async () => {
    const evil = zipSync({
      "scene.json": new TextEncoder().encode(
        JSON.stringify({ version: 1, canvas: { width: 10, height: 10 }, layers: [] }),
      ),
      "../evil.txt": new TextEncoder().encode("nope"),
    });
    const res = await post("evil.gimpish", Buffer.from(evil));
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("unsafe path");
    expect(existsSync(path.join(tmp, "..", "evil.txt"))).toBe(false);
  });
});

describe("websocket /ws", () => {
  it("broadcasts {type:'reload'} when the scene file changes", async () => {
    const ws = await app.injectWS("/ws");
    try {
      const message = new Promise<string>((resolve, reject) => {
        ws.on("message", (data: Buffer) => resolve(data.toString()));
        setTimeout(() => reject(new Error("no reload within 10s")), 10_000);
      });
      // Touch the scene until the (async-started) watcher picks it up.
      const touch = setInterval(() => {
        writeFileSync(scenePath, readFileSync(scenePath, "utf8"));
      }, 200);
      try {
        expect(JSON.parse(await message)).toEqual({ type: "reload" });
      } finally {
        clearInterval(touch);
      }
    } finally {
      ws.terminate();
    }
  }, 15_000);
});

describe("serve advertisement (.scene_cache/serve.json)", () => {
  it("reports a live server and ignores stale or malformed entries", async () => {
    const { readLiveServer, serveInfoPath } = await import("../src/server/run.ts");
    const dir = mkdtempSync(path.join(tmpdir(), "gimpish-serveinfo-"));
    const scene = path.join(dir, "scene.json");
    try {
      expect(readLiveServer(scene)).toBeNull(); // no advertisement

      const file = serveInfoPath(scene);
      mkdirSync(path.dirname(file), { recursive: true });
      const info = {
        pid: process.pid, // this test process: definitely alive
        port: 1234,
        url: "http://127.0.0.1:1234",
        scene,
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      writeFileSync(file, JSON.stringify(info));
      expect(readLiveServer(scene)?.port).toBe(1234);

      writeFileSync(file, JSON.stringify({ ...info, pid: 2 ** 30 })); // dead pid
      expect(readLiveServer(scene)).toBeNull();

      writeFileSync(file, "not json");
      expect(readLiveServer(scene)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

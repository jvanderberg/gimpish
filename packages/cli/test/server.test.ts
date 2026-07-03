/**
 * Live-preview server tests. Each test gets a fresh scene.json in a temp dir
 * (one shape, radial + linear gradients, text, arrow, and a tiny generated
 * image layer) and a fresh app; routes are exercised via fastify inject.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArrowLayer, ImageLayer, LayerBox, Scene, ShapeLayer } from "@gimpish/core";
import type { FastifyInstance } from "fastify";
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

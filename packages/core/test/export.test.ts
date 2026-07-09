import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Canvas, ExportSettings, SceneDoc } from "../src/index.ts";
import { clampCrop, coverCrop, parseScene, renderExport, resolveExportCrop } from "../src/index.ts";

const CANVAS: Canvas = { width: 2000, height: 1000, background: "#3355aaff" };

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return { width: 640, height: 360, format: "png", quality: 90, crop: null, preset: null, ...over };
}

function boxScene(): SceneDoc {
  return {
    path: "/tmp/export-test/scene.json", // no file IO for shape-only scenes
    scene: parseScene({
      canvas: CANVAS,
      layers: [
        {
          id: "box",
          type: "shape",
          shape: "rect",
          rect: { x: 200, y: 200, w: 400, h: 400 },
          fill: "#ff0000ff",
        },
      ],
    }),
  };
}

describe("coverCrop", () => {
  it("fills full height when the target is narrower than the canvas", () => {
    const c = coverCrop(2000, 1000, 1280, 720); // 1.78 < 2.0
    expect(c.h).toBe(1000);
    expect(Math.round(c.w)).toBe(1778);
    expect(c.y).toBe(0);
    expect(Math.round(c.x)).toBe(111);
  });

  it("fills full width when the target is wider than the canvas", () => {
    const c = coverCrop(1000, 1000, 1600, 900); // 1.78 > 1.0
    expect(c.w).toBe(1000);
    expect(Math.round(c.h)).toBe(563);
    expect(c.x).toBe(0);
  });
});

describe("clampCrop", () => {
  it("keeps the crop inside the canvas and rounds to whole pixels", () => {
    const c = clampCrop({ x: -50, y: 10.6, w: 5000, h: 200.4 }, 2000, 1000);
    expect(c).toEqual({ x: 0, y: 11, w: 2000, h: 200 });
  });
});

describe("resolveExportCrop", () => {
  it("uses a stored crop (clamped) when present", () => {
    const crop = resolveExportCrop(CANVAS, settings({ crop: { x: 10, y: 20, w: 300, h: 300 } }));
    expect(crop).toEqual({ x: 10, y: 20, w: 300, h: 300 });
  });

  it("derives a centered cover crop when none is stored", () => {
    // square target on a 2:1 canvas -> full-height 1000×1000, centered.
    const crop = resolveExportCrop(CANVAS, settings({ width: 1000, height: 1000 }));
    expect(crop).toEqual({ x: 500, y: 0, w: 1000, h: 1000 });
  });
});

describe("renderExport", () => {
  it("outputs exactly the target pixels", async () => {
    const buf = await renderExport(boxScene(), settings({ width: 640, height: 360 }));
    const meta = await sharp(buf).metadata();
    expect([meta.width, meta.height]).toEqual([640, 360]);
    expect(meta.format).toBe("png");
  });

  it("encodes jpg (flattened, no alpha) at the target size", async () => {
    const buf = await renderExport(
      boxScene(),
      settings({ width: 200, height: 200, format: "jpg", crop: { x: 0, y: 0, w: 1000, h: 1000 } }),
    );
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false);
    expect([meta.width, meta.height]).toEqual([200, 200]);
  });
});

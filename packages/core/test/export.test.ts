import { describe, expect, it } from "vitest";
import type { Canvas, ExportSettings } from "../src/index.ts";
import {
  clampCrop,
  coverCrop,
  EXPORT_PRESETS,
  isExportPreset,
  resolveExportCrop,
} from "../src/index.ts";

const CANVAS: Canvas = { width: 2000, height: 1000, background: "#3355aaff" };

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return { width: 640, height: 360, format: "png", quality: 90, crop: null, preset: null, ...over };
}

describe("EXPORT_PRESETS", () => {
  it("includes high-resolution screen and print targets", () => {
    expect(EXPORT_PRESETS["square-2x"]).toMatchObject({ width: 2160, height: 2160 });
    expect(EXPORT_PRESETS["4k"]).toMatchObject({ width: 3840, height: 2160 });
    expect(EXPORT_PRESETS["print-12x9"]).toMatchObject({ width: 3600, height: 2700 });
    expect(EXPORT_PRESETS["print-16x12"]).toMatchObject({ width: 4800, height: 3600 });
    expect(isExportPreset("print-16x12")).toBe(true);
  });
});

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

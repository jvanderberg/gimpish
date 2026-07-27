import {
  arrowPolygonPoints,
  linearGradientGeometry,
  parseScene,
  radialGradientGeometry,
} from "@gimpish/core/model";
import { describe, expect, it } from "vitest";
import { sceneRendersResolutionIndependently } from "../src/render";
import { arcGlyphLayout, type TextContext } from "../src/render/text";
import { canvasFontFamily, premultiplyBlendPixels } from "../src/render/vector";

describe("browser vector parity", () => {
  it("leaves CSS generic font families unquoted", () => {
    expect(canvasFontFamily("sans-serif")).toBe("sans-serif");
    expect(canvasFontFamily("system-ui")).toBe("system-ui");
    expect(canvasFontFamily("Helvetica Neue")).toBe('"Helvetica Neue"');
  });

  it("builds a single shaft-and-head arrow polygon", () => {
    expect(
      arrowPolygonPoints({
        from_x: 0,
        from_y: 0,
        to_x: 100,
        to_y: 0,
        width: 20,
        head_length: 30,
        head_width: 40,
      }),
    ).toEqual([
      [0, 10],
      [70, 10],
      [70, 20],
      [100, 0],
      [70, -20],
      [70, -10],
      [0, -10],
    ]);
  });

  it("matches farthest-corner radial and projected linear geometry", () => {
    expect(radialGradientGeometry(100, 50, [0, 0])).toEqual({
      cx: 0,
      cy: 0,
      radius: Math.hypot(100, 50),
    });
    expect(linearGradientGeometry(100, 50, 0)).toEqual({ x1: 0, y1: 0, x2: 100, y2: 0 });
  });

  it("prepares translucent pixels for libvips-compatible blend modes", () => {
    const pixels = new Uint8ClampedArray([43, 182, 115, 112, 200, 100, 50, 0]);
    premultiplyBlendPixels(pixels, 0.85);
    expect([...pixels]).toEqual([16, 68, 43, 95, 0, 0, 0, 0]);
  });

  it("centers glyph advances clockwise around a text arc", () => {
    const scene = parseScene({
      canvas: { width: 200, height: 200 },
      layers: [
        {
          id: "arc",
          type: "text",
          text: {
            content: "AB",
            x: 100,
            y: 100,
            align: "center",
            arc: { radius: 100, angle: -90, direction: "clockwise" },
          },
        },
      ],
    });
    const layer = scene.layers[0];
    if (layer?.type !== "text") throw new Error("expected text");
    const context = { measureText: () => ({ width: 10 }) } as unknown as TextContext;
    const glyphs = arcGlyphLayout(context, layer.text);
    expect(glyphs.map((glyph) => glyph.text)).toEqual(["A", "B"]);
    expect(glyphs[0]?.x).toBeCloseTo(-4.998, 2);
    expect(glyphs[1]?.x).toBeCloseTo(4.998, 2);
    expect(glyphs[0]?.y).toBeCloseTo(-99.875, 2);
    expect(glyphs[0]?.rotation).toBeCloseTo(-0.05, 3);
    expect(glyphs[1]?.rotation).toBeCloseTo(0.05, 3);
  });

  it("recognizes vector-only scenes without counting hidden raster references", () => {
    const scene = parseScene({
      canvas: { width: 2000, height: 1500, background: "transparent" },
      layers: [
        { id: "reference", type: "image", source: "shirt.jpeg", visible: false },
        { id: "tree", type: "image", source: "tree.svg" },
        { id: "initials", type: "text", text: { content: "MSR", x: 100, y: 100 } },
      ],
    });
    expect(sceneRendersResolutionIndependently(scene)).toBe(true);
  });

  it("flags visible raster layers as resolution-dependent", () => {
    const scene = parseScene({
      canvas: { width: 2000, height: 1500, background: "transparent" },
      layers: [{ id: "photo", type: "image", source: "shirt.jpeg" }],
    });
    expect(sceneRendersResolutionIndependently(scene)).toBe(false);
  });
});

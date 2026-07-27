import type { Adjust } from "@gimpish/core/model";
import { describe, expect, it } from "vitest";
import { applyBrowserAdjustments, isBrowserAdjustNeutral } from "../src/render/adjust";

function adjustment(values: Partial<Adjust> = {}): Adjust {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    exposure: 0,
    warmth: 0,
    hue: 0,
    shadows: 0,
    highlights: 0,
    clarity: 0,
    sharpen: 0,
    ...values,
  };
}

function pixel(r: number, g = r, b = r, a = 255): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a]);
}

describe("browser adjustment pipeline", () => {
  it("recognizes neutral values", () => {
    expect(isBrowserAdjustNeutral(undefined)).toBe(true);
    expect(isBrowserAdjustNeutral(adjustment())).toBe(true);
    expect(isBrowserAdjustNeutral(adjustment({ exposure: 1 }))).toBe(false);
  });

  it("matches additive brightness and pivoted contrast semantics", () => {
    const bright = pixel(128, 128, 128, 77);
    applyBrowserAdjustments(bright, 1, 1, adjustment({ brightness: 50 }));
    expect([...bright]).toEqual([255, 255, 255, 77]);

    const contrast = pixel(64);
    applyBrowserAdjustments(contrast, 1, 1, adjustment({ contrast: 50 }));
    expect(contrast[0]).toBe(32);
  });

  it("supports exposure, warmth, saturation, and hue while preserving alpha", () => {
    const exposed = pixel(128, 128, 128, 91);
    applyBrowserAdjustments(exposed, 1, 1, adjustment({ exposure: 50 }));
    expect([...exposed]).toEqual([199, 199, 199, 91]);

    const warm = pixel(128);
    applyBrowserAdjustments(warm, 1, 1, adjustment({ warmth: 100 }));
    expect(warm[0]).toBeGreaterThan(warm[2] ?? 0);

    const gray = pixel(255, 136, 0);
    applyBrowserAdjustments(gray, 1, 1, adjustment({ saturation: -100 }));
    expect(gray[0]).toBe(gray[1]);
    expect(gray[1]).toBe(gray[2]);

    const shifted = pixel(255, 0, 0);
    applyBrowserAdjustments(shifted, 1, 1, adjustment({ hue: 120 }));
    expect([...shifted]).toEqual([0, 158, 59, 255]);
  });

  it("weights shadow and highlight corrections by luminance", () => {
    const shadows = new Uint8ClampedArray([16, 16, 16, 255, 128, 128, 128, 255]);
    applyBrowserAdjustments(shadows, 2, 1, adjustment({ shadows: 50 }));
    expect((shadows[0] ?? 0) - 16).toBeGreaterThan((shadows[4] ?? 0) - 128);

    const highlights = new Uint8ClampedArray([128, 128, 128, 255, 240, 240, 240, 255]);
    applyBrowserAdjustments(highlights, 2, 1, adjustment({ highlights: -30 }));
    expect(240 - (highlights[4] ?? 0)).toBeGreaterThan(128 - (highlights[0] ?? 0));
  });

  it("applies alpha-safe local contrast for clarity and sharpen", () => {
    for (const field of ["clarity", "sharpen"] as const) {
      const data = new Uint8ClampedArray(5 * 5 * 4);
      for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = 128;
        data[offset + 1] = 128;
        data[offset + 2] = 128;
        data[offset + 3] = 73;
      }
      const center = (2 * 5 + 2) * 4;
      data[center] = 180;
      data[center + 1] = 180;
      data[center + 2] = 180;
      applyBrowserAdjustments(data, 5, 5, adjustment({ [field]: 100 }));
      expect(data[center]).toBeGreaterThan(180);
      expect(data[center + 3]).toBe(73);
    }
  });
});

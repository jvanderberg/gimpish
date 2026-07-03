/**
 * Pixel-parity suite: the TS renderer must reproduce the golden renders made by
 * the original Python/pyvips engine (tests/fixtures/golden, commit 9768613).
 *
 * Both engines rasterize vectors through librsvg and composite through libvips,
 * so differences should be limited to antialiasing/quantization. Tolerances are
 * per-fixture: geometric fixtures are tight; text is looser (font hinting).
 */

import path from "node:path";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadScene, renderScene } from "../src/index.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../../../tests/fixtures");

/** name -> max fraction of pixels allowed to differ (pixelmatch threshold 0.1). */
const CASES: Record<string, number> = {
  blends: 0.005,
  transforms: 0.01,
  gradients: 0.005,
  vector: 0.01,
  text: 0.03,
  "example-poster-shapes": 0.01,
  "example-radial-badge": 0.01,
  "example-text-card": 0.03,
};

function scenePathFor(name: string): string {
  return name.startsWith("example-")
    ? path.resolve(FIXTURES, "../../examples", `${name.slice("example-".length)}.scene.json`)
    : path.join(FIXTURES, "scenes", `${name}.scene.json`);
}

describe("pixel parity with the Python engine", () => {
  for (const [name, tolerance] of Object.entries(CASES)) {
    it(`${name} (≤${(tolerance * 100).toFixed(1)}% differing pixels)`, async () => {
      const doc = loadScene(scenePathFor(name));
      const actual = await renderScene(doc);

      const golden = await sharp(path.join(FIXTURES, "golden", `${name}.png`))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      expect(actual.width).toBe(golden.info.width);
      expect(actual.height).toBe(golden.info.height);

      const differing = pixelmatch(
        actual.data,
        golden.data,
        undefined,
        actual.width,
        actual.height,
        { threshold: 0.1 },
      );
      const fraction = differing / (actual.width * actual.height);
      expect(
        fraction,
        `${name}: ${(fraction * 100).toFixed(3)}% pixels differ`,
      ).toBeLessThanOrEqual(tolerance);
    });
  }
});

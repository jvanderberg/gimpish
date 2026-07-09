/**
 * Per-layer pixel adjustments (brightness, contrast, saturation, exposure,
 * warmth, hue, shadows, highlights, clarity, sharpen).
 *
 * Applied in renderLayer after content render, before blur — so adjustments
 * affect pixel values before the blur spreads them.  Like blur, this is a
 * per-layer property on LayerBase; it works on every layer type.
 *
 * Pipeline order inside applyAdjustments:
 *   1. Tonemap-region corrections (shadows / highlights) — raw buffer math
 *   2. Global tone: brightness, contrast, exposure — sharp linear / modulate
 *   3. Color: saturation, warmth, hue — sharp modulate / recomb
 *   4. Local contrast: clarity (CLAHE) — sharp clahe (alpha-safe)
 *   5. Edge contrast: sharpen — sharp sharpen
 *
 * Each step is skipped when its value is 0 (neutral), so an empty / all-zero
 * adjust object is a complete no-op.
 *
 * NOTE: step 1 (shadows/highlights) mutates the input Raster's `data` buffer
 * in place before the sharp pipeline runs.  This is safe in the render
 * pipeline, where each Placed is freshly rasterized and not shared across
 * layers, but callers passing a borrowed buffer should pass a copy.
 */

import sharp from "sharp";
import type { Adjust } from "../schema.ts";
import type { Raster } from "./raster.ts";

/** True when every field of `adjust` is zero / neutral. */
export function isAdjustNeutral(a: Adjust | undefined): boolean {
  if (!a) return true;
  return (
    a.brightness === 0 &&
    a.contrast === 0 &&
    a.saturation === 0 &&
    a.exposure === 0 &&
    a.warmth === 0 &&
    a.hue === 0 &&
    a.shadows === 0 &&
    a.highlights === 0 &&
    a.clarity === 0 &&
    a.sharpen === 0
  );
}

// ---- raw-buffer tonal adjustments (shadows / highlights) -----------------------

/**
 * Luminance-weighted brightness shift for a tonal region.
 *
 * `region` is "shadows" or "highlights".  For shadows, the weight peaks at
 * luminance 0 and falls to 0 at luminance 255.  For highlights, it's reversed.
 * A smooth cosine falloff is used so the transition is gradual.
 *
 * Positive `amount` brightens the region; negative darkens it.  The shift is
 * scaled by the weight so midtones are barely touched.
 *
 * Mutates `img.data` in place — see module NOTE above.
 */
function applyTonalRegion(img: Raster, region: "shadows" | "highlights", amount: number): void {
  const { data } = img;
  const shift = (amount / 100) * 255;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b; // Rec.601 luminance
    const t = lum / 255; // 0..1
    // Cosine falloff: shadows weight = cos(t * PI/2), highlights = cos((1-t) * PI/2)
    const weight =
      region === "shadows" ? Math.cos(t * (Math.PI / 2)) : Math.cos((1 - t) * (Math.PI / 2));
    const delta = shift * weight;
    data[i] = Math.max(0, Math.min(255, Math.round(r + delta)));
    data[i + 1] = Math.max(0, Math.min(255, Math.round(g + delta)));
    data[i + 2] = Math.max(0, Math.min(255, Math.round(b + delta)));
  }
}

// ---- sharp pipeline helpers ----------------------------------------------------

function pipe(img: Raster): sharp.Sharp {
  return sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 },
  });
}

async function toRaster(p: sharp.Sharp): Promise<Raster> {
  const { data, info } = await p.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * CLAHE (local contrast / clarity) is not alpha-safe — it processes all 4
 * channels and corrupts alpha.  We extract alpha, run CLAHE on RGB only,
 * then rejoin the original alpha band.
 */
async function claheAlphaSafe(img: Raster, strength: number): Promise<Raster> {
  const w = img.width;
  const h = img.height;
  const tileSize = Math.max(2, Math.min(8, Math.round(2 + strength / 25)));
  const maxSlope = Math.max(3, Math.round(2 + strength / 10));

  const base = pipe(img);
  const alpha = await base.clone().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const rgb = await base
    .clone()
    .removeAlpha()
    .clahe({ width: tileSize, height: tileSize, maxSlope })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return toRaster(
    sharp(rgb.data, { raw: { width: w, height: h, channels: 3 } }).joinChannel(alpha.data, {
      raw: { width: w, height: h, channels: 1 },
    }),
  );
}

// ---- main entry point ----------------------------------------------------------

/**
 * Apply all non-zero adjustment fields to a raster.  Returns the same Raster
 * reference when adjust is neutral (no allocation, no sharp calls).
 *
 * Steps that operate on the raw buffer (shadows / highlights) run first so the
 * sharp pipeline picks them up.  Tone and color steps are chained into a single
 * sharp pipeline.  CLAHE requires its own pass because it's not alpha-safe.
 *
 * WARNING: when shadows or highlights are non-zero, the input `img.data` is
 * mutated in place (step 1) before the sharp pipeline runs.  See module NOTE.
 */
export async function applyAdjustments(img: Raster, adjust: Adjust): Promise<Raster> {
  // 1. Tonemap-region corrections (raw buffer, in-place)
  if (adjust.shadows !== 0) applyTonalRegion(img, "shadows", adjust.shadows);
  if (adjust.highlights !== 0) applyTonalRegion(img, "highlights", adjust.highlights);

  // 2-3. Global tone + color: chain into one sharp pipeline
  let pipeline: sharp.Sharp | null = null;

  if (adjust.brightness !== 0) {
    const offset = (adjust.brightness / 100) * 255;
    pipeline = (pipeline ?? pipe(img)).linear(1, offset);
  }

  if (adjust.contrast !== 0) {
    const multiplier = 1 + adjust.contrast / 100;
    const bias = 128 * (1 - multiplier); // pivot around 128
    pipeline = (pipeline ?? pipe(img)).linear(multiplier, bias);
  }

  if (adjust.exposure !== 0) {
    const brightnessMul = 1 + adjust.exposure / 100; // 0..2
    pipeline = (pipeline ?? pipe(img)).modulate({ brightness: brightnessMul });
  }

  if (adjust.saturation !== 0) {
    const satMul = 1 + adjust.saturation / 100;
    pipeline = (pipeline ?? pipe(img)).modulate({ saturation: satMul });
  }

  if (adjust.hue !== 0) {
    pipeline = (pipeline ?? pipe(img)).modulate({ hue: adjust.hue });
  }

  if (adjust.warmth !== 0) {
    const w = adjust.warmth / 100; // -1..1
    // Warm: boost R, cut B.  Cool: reverse.
    const rGain = 1 + w * 0.2;
    const bGain = 1 - w * 0.2;
    pipeline = (pipeline ?? pipe(img)).recomb([
      [rGain, 0, 0],
      [0, 1, 0],
      [0, 0, bGain],
    ]);
  }

  let result: Raster = img;
  if (pipeline) {
    result = await toRaster(pipeline);
  }

  // 4. Clarity (CLAHE) — separate pass, alpha-safe
  if (adjust.clarity > 0) {
    result = await claheAlphaSafe(result, adjust.clarity);
  }

  // 5. Sharpen (unsharp mask) — alpha-safe
  if (adjust.sharpen > 0) {
    const s = adjust.sharpen / 100; // 0..1
    const sigma = 1 + s * 4; // 1..5
    const m1 = s * 5; // 0..5
    const m2 = s * 10; // 0..10
    result = await toRaster(pipe(result).sharpen({ sigma, m1, m2 }));
  }

  return result;
}

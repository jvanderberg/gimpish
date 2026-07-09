/**
 * Stress benchmark for per-layer adjustments.
 *
 * Measures the cost of applyAdjustments at various image sizes and with
 * different adjustment combos, isolating the raw-buffer tonal-region math
 * (shadows/highlights — main-thread JS) from the sharp pipeline (libuv thread
 * pool) so we can see where the bottleneck actually lives.
 *
 * Run: npx tsx packages/core/test/adjust.bench.ts
 */

import type { Adjust } from "../src/index.ts";
import { applyAdjustments, isAdjustNeutral } from "../src/index.ts";
import type { Raster } from "../src/render/raster.ts";

function makeRaster(width: number, height: number): Raster {
  // Pseudo-random RGB noise with full alpha — simulates a photo-like raster.
  const data = Buffer.alloc(width * height * 4);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(rand() * 256);
    data[i + 1] = Math.floor(rand() * 256);
    data[i + 2] = Math.floor(rand() * 256);
    data[i + 3] = 255;
  }
  return { data, width, height };
}

function cloneRaster(r: Raster): Raster {
  return { data: Buffer.from(r.data), width: r.width, height: r.height };
}

const SIZES: Array<[string, number, number]> = [
  ["256×256", 256, 256],
  ["512×512", 512, 512],
  ["1024×1024", 1024, 1024],
  ["2048×2048", 2048, 2048],
];

const COMBOS: Array<[string, Partial<Adjust>]> = [
  ["shadows only", { shadows: 50 }],
  ["highlights only", { highlights: -50 }],
  ["shadows+highlights", { shadows: 50, highlights: -50 }],
  [
    "sharp pipeline only (brightness+contrast+sat+warmth+clarity+sharpen)",
    {
      brightness: 20,
      contrast: 30,
      saturation: -15,
      warmth: 8,
      clarity: 40,
      sharpen: 60,
    },
  ],
  [
    "all 10 (full pipeline)",
    {
      brightness: 20,
      contrast: 30,
      saturation: -15,
      exposure: 10,
      warmth: 8,
      hue: 5,
      shadows: 50,
      highlights: -50,
      clarity: 40,
      sharpen: 60,
    },
  ],
];

function fullAdjust(partial: Partial<Adjust>): Adjust {
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
    ...partial,
  };
}

function fmt(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)}ms` : `${ms.toFixed(1)}ms`;
}

async function benchOne(
  raster: Raster,
  adjust: Adjust,
  runs: number,
): Promise<{ avg: number; min: number; max: number }> {
  // Warmup
  await applyAdjustments(cloneRaster(raster), adjust);

  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const img = cloneRaster(raster);
    const t0 = performance.now();
    await applyAdjustments(img, adjust);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    avg: sum / times.length,
    min: times[0] as number,
    max: times[times.length - 1] as number,
  };
}

async function benchNeutral(raster: Raster, runs: number): Promise<number> {
  // Measure isAdjustNeutral guard cost (should be near-zero)
  const adjust = fullAdjust({});
  const t0 = performance.now();
  for (let i = 0; i < runs * 10; i++) {
    if (!isAdjustNeutral(adjust)) {
      await applyAdjustments(cloneRaster(raster), adjust);
    }
  }
  return (performance.now() - t0) / (runs * 10);
}

async function main(): Promise<void> {
  const RUNS = 10;

  console.log("adjust.bench — per-layer adjustment stress test\n");
  console.log(`Runs per combo: ${RUNS} (after 1 warmup)\n`);

  // Neutral guard benchmark (cheap — do it once on the smallest image)
  const small = makeRaster(256, 256);
  const neutralCost = await benchNeutral(small, RUNS);
  console.log(`Neutral guard (isAdjustNeutral skip):  ${fmt(neutralCost)} per call\n`);

  for (const [label, w, h] of SIZES) {
    const raster = makeRaster(w, h);
    const pixels = w * h;
    console.log(
      `─ ${label}  (${(pixels / 1e6).toFixed(1)}M px, ${(raster.data.length / 1024 / 1024).toFixed(1)} MB) ─`,
    );

    for (const [comboLabel, partial] of COMBOS) {
      const adjust = fullAdjust(partial);
      const { avg, min, max } = await benchOne(raster, adjust, RUNS);
      const throughput = (pixels / (avg / 1000) / 1e6).toFixed(1);
      console.log(
        `  ${comboLabel.padEnd(62)} avg ${fmt(avg).padStart(8)}  min ${fmt(min).padStart(8)}  max ${fmt(max).padStart(8)}  ${throughput} Mpx/s`,
      );
    }
    console.log();
  }
}

await main();

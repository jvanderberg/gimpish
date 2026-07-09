import { loadScene, renderScene } from "@gimpish/core";

const doc = loadScene("scene.json");

// Warmup
await renderScene(doc);

const runs = 5;
const times: number[] = [];
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  await renderScene(doc);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / times.length;

// Now measure with the pico's adjust disabled
const doc2 = loadScene("scene.json");
const pico = doc2.scene.layers.find((l) => l.id === "pico");
if (pico) pico.adjustEnabled = false;
await renderScene(doc2);

const times2: number[] = [];
for (let i = 0; i < runs; i++) {
  const d = loadScene("scene.json");
  const p = d.scene.layers.find((l) => l.id === "pico");
  if (p) p.adjustEnabled = false;
  const t0 = performance.now();
  await renderScene(d);
  times2.push(performance.now() - t0);
}
times2.sort((a, b) => a - b);
const avg2 = times2.reduce((a, b) => a + b, 0) / times2.length;

console.log(`pico scene render (1600×900, 13 layers) — ${runs} runs`);
console.log(
  `  adjust ON:   avg ${avg.toFixed(1)}ms  min ${(times[0] ?? 0).toFixed(1)}ms  max ${(times[times.length - 1] ?? 0).toFixed(1)}ms`,
);
console.log(
  `  adjust OFF:  avg ${avg2.toFixed(1)}ms  min ${(times2[0] ?? 0).toFixed(1)}ms  max ${(times2[times2.length - 1] ?? 0).toFixed(1)}ms`,
);
console.log(`  adjust cost: ${(avg - avg2).toFixed(1)}ms`);

const INPUT_SIZE = 320;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

export const U2NET_INPUT_SIZE = INPUT_SIZE;

export function normalizeU2NetInput(rgba: Uint8ClampedArray): Float32Array {
  const pixels = INPUT_SIZE * INPUT_SIZE;
  if (rgba.length !== pixels * 4) throw new Error("U²-Net input must be 320×320 RGBA");
  let maxValue = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    maxValue = Math.max(maxValue, rgba[offset] ?? 0, rgba[offset + 1] ?? 0, rgba[offset + 2] ?? 0);
  }
  if (maxValue === 0) maxValue = 1;
  const input = new Float32Array(3 * pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = (rgba[offset + channel] ?? 0) / maxValue;
      input[channel * pixels + pixel] =
        (value - (MEAN[channel] as number)) / (STD[channel] as number);
    }
  }
  return input;
}

export function saliencyToAlpha(mask: Float32Array): Uint8ClampedArray {
  const pixels = INPUT_SIZE * INPUT_SIZE;
  if (mask.length < pixels) throw new Error("U²-Net returned an undersized saliency map");
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const value = mask[pixel] as number;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const range = high - low || 1;
  const alpha = new Uint8ClampedArray(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    alpha[pixel] = Math.trunc((((mask[pixel] as number) - low) / range) * 255);
  }
  return alpha;
}

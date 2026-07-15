import type { Adjust } from "@gimpish/core/model";

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function srgbToLinear(value: number): number {
  const normalized = Math.max(0, Math.min(1, value / 255));
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const normalized =
    value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055;
  return clampByte(normalized * 255);
}

function labPivot(value: number): number {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

function labPivotInverse(value: number): number {
  const cube = value ** 3;
  return cube > 0.008856 ? cube : (value - 16 / 116) / 7.787;
}

function rgbToLch(r: number, g: number, b: number): [number, number, number] {
  const rn = srgbToLinear(r);
  const gn = srgbToLinear(g);
  const bn = srgbToLinear(b);
  const x = (0.4124564 * rn + 0.3575761 * gn + 0.1804375 * bn) / 0.95047;
  const y = 0.2126729 * rn + 0.7151522 * gn + 0.072175 * bn;
  const z = (0.0193339 * rn + 0.119192 * gn + 0.9503041 * bn) / 1.08883;
  const fx = labPivot(x);
  const fy = labPivot(y);
  const fz = labPivot(z);
  const lightness = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const labB = 200 * (fy - fz);
  return [lightness, Math.hypot(a, labB), ((Math.atan2(labB, a) * 180) / Math.PI + 360) % 360];
}

function lchToRgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const labB = chroma * Math.sin(radians);
  const fy = (lightness + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - labB / 200;
  const x = 0.95047 * labPivotInverse(fx);
  const y = labPivotInverse(fy);
  const z = 1.08883 * labPivotInverse(fz);
  return [
    linearToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    linearToSrgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    linearToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

function localContrast(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  radius: number,
): void {
  if (!(amount > 0) || width < 2 || height < 2) return;
  const source = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sums: [number, number, number] = [0, 0, 0];
      let count = 0;
      for (let oy = -radius; oy <= radius; oy += 1) {
        const sy = Math.max(0, Math.min(height - 1, y + oy));
        for (let ox = -radius; ox <= radius; ox += 1) {
          const sx = Math.max(0, Math.min(width - 1, x + ox));
          const sourceOffset = (sy * width + sx) * 4;
          sums[0] = sums[0] + (source[sourceOffset] ?? 0);
          sums[1] = sums[1] + (source[sourceOffset + 1] ?? 0);
          sums[2] = sums[2] + (source[sourceOffset + 2] ?? 0);
          count += 1;
        }
      }
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const original = source[offset + channel] ?? 0;
        const blurred = (sums[channel] ?? 0) / count;
        data[offset + channel] = clampByte(original + (original - blurred) * amount);
      }
    }
  }
}

export function isBrowserAdjustNeutral(adjust: Adjust | undefined): boolean {
  return (
    !adjust ||
    (adjust.brightness === 0 &&
      adjust.contrast === 0 &&
      adjust.saturation === 0 &&
      adjust.exposure === 0 &&
      adjust.warmth === 0 &&
      adjust.hue === 0 &&
      adjust.shadows === 0 &&
      adjust.highlights === 0 &&
      adjust.clarity === 0 &&
      adjust.sharpen === 0)
  );
}

/** Apply the scene adjustment contract in place without touching alpha. */
export function applyBrowserAdjustments(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  adjust: Adjust,
): Uint8ClampedArray {
  const brightness = (adjust.brightness / 100) * 255;
  const contrast = 1 + adjust.contrast / 100;
  const contrastBias = 128 * (1 - contrast);
  const exposure = 1 + adjust.exposure / 100;
  const saturation = 1 + adjust.saturation / 100;
  const warmth = adjust.warmth / 100;
  const redGain = 1 + warmth * 0.2;
  const blueGain = 1 - warmth * 0.2;
  const shadowShift = (adjust.shadows / 100) * 255;
  const highlightShift = (adjust.highlights / 100) * 255;

  for (let offset = 0; offset < data.length; offset += 4) {
    let r = data[offset] ?? 0;
    let g = data[offset + 1] ?? 0;
    let b = data[offset + 2] ?? 0;

    if (shadowShift !== 0 || highlightShift !== 0) {
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const t = luminance / 255;
      const delta =
        shadowShift * Math.cos(t * (Math.PI / 2)) +
        highlightShift * Math.cos((1 - t) * (Math.PI / 2));
      r += delta;
      g += delta;
      b += delta;
    }

    r = (r + brightness) * contrast + contrastBias;
    g = (g + brightness) * contrast + contrastBias;
    b = (b + brightness) * contrast + contrastBias;
    if (exposure !== 1 || saturation !== 1 || adjust.hue !== 0) {
      const [lightness, chroma, hue] = rgbToLch(r, g, b);
      [r, g, b] = lchToRgb(lightness * exposure, chroma * saturation, hue + adjust.hue);
    }

    r *= redGain;
    b *= blueGain;
    data[offset] = clampByte(r);
    data[offset + 1] = clampByte(g);
    data[offset + 2] = clampByte(b);
  }

  if (adjust.clarity > 0) {
    localContrast(data, width, height, (adjust.clarity / 100) * 1.25, 2);
  }
  if (adjust.sharpen > 0) {
    localContrast(data, width, height, (adjust.sharpen / 100) * 1.8, 1);
  }
  return data;
}

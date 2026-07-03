/**
 * Raw-RGBA raster helpers. The compositor works on plain byte buffers so that
 * placement (including negative offsets / overflow), opacity, and mask
 * application are exact and dependency-free; sharp handles codecs and filters.
 */

import { parseColor } from "../color.ts";

export interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

export function transparent(width: number, height: number): Raster {
  return { data: Buffer.alloc(width * height * 4), width, height };
}

export function solid(width: number, height: number, color: string): Raster {
  const [r, g, b, a] = parseColor(color);
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { data, width, height };
}

/** Multiply the alpha channel by `opacity` (0..1) in place. */
export function applyOpacity(img: Raster, opacity: number): Raster {
  if (opacity >= 1) return img;
  const o = Math.max(0, opacity);
  const { data } = img;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round((data[i] as number) * o);
  }
  return img;
}

/** Multiply the alpha channel by a single-band 0..255 mask of the same size. */
export function applyMaskBand(img: Raster, mask: Uint8Array): Raster {
  const { data } = img;
  const n = img.width * img.height;
  for (let p = 0; p < n; p += 1) {
    const ai = p * 4 + 3;
    data[ai] = Math.round(((data[ai] as number) * (mask[p] as number)) / 255);
  }
  return img;
}

/**
 * Place `img` on a transparent frameW x frameH canvas with its top-left at
 * (x, y). Off-canvas regions are cropped; returns null if fully off-canvas.
 * Mirrors the Python engine's embed step, which is what makes negative offsets
 * and overflow behave.
 */
export function embed(
  img: Raster,
  x: number,
  y: number,
  frameW: number,
  frameH: number,
): Raster | null {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const srcX0 = Math.max(0, -ix);
  const srcY0 = Math.max(0, -iy);
  const dstX0 = Math.max(0, ix);
  const dstY0 = Math.max(0, iy);
  const w = Math.min(img.width - srcX0, frameW - dstX0);
  const h = Math.min(img.height - srcY0, frameH - dstY0);
  if (w <= 0 || h <= 0) return null;

  const out = transparent(frameW, frameH);
  const rowBytes = w * 4;
  for (let row = 0; row < h; row += 1) {
    const src = ((srcY0 + row) * img.width + srcX0) * 4;
    const dst = ((dstY0 + row) * frameW + dstX0) * 4;
    img.data.copy(out.data, dst, src, src + rowBytes);
  }
  return out;
}

/** Alpha-channel bounding box (threshold > 0), or null if fully transparent. */
export function alphaBounds(
  img: Raster,
): { left: number; top: number; width: number; height: number } | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let yPos = 0; yPos < img.height; yPos += 1) {
    for (let xPos = 0; xPos < img.width; xPos += 1) {
      if ((img.data[(yPos * img.width + xPos) * 4 + 3] as number) > 0) {
        if (xPos < minX) minX = xPos;
        if (xPos > maxX) maxX = xPos;
        if (yPos < minY) minY = yPos;
        if (yPos > maxY) maxY = yPos;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

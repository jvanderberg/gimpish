/**
 * Export targets and crop geometry (browser-safe — no node imports).
 *
 * An export is a fixed output size (exact pixels for a platform) plus a source
 * crop over the canvas. The crop's aspect should match the target so the resize
 * never distorts; when no crop is stored the renderer derives a centered "cover"
 * crop for the target aspect. All crop coordinates are canvas pixels.
 */

import type { Canvas, ExportCrop, ExportSettings } from "./schema.ts";

/** Named output sizes for common platforms. Keys are the CLI `--preset` values. */
export const EXPORT_PRESETS = {
  youtube: { label: "YouTube 1280×720", width: 1280, height: 720 },
  "fb-link": { label: "Facebook link 1200×630", width: 1200, height: 630 },
  square: { label: "Square 1080×1080", width: 1080, height: 1080 },
  "instagram-portrait": { label: "Instagram portrait 1080×1350", width: 1080, height: 1350 },
  story: { label: "Story / TikTok 1080×1920", width: 1080, height: 1920 },
  x: { label: "X 1600×900", width: 1600, height: 900 },
} as const;

export type ExportPreset = keyof typeof EXPORT_PRESETS;

export function isExportPreset(name: string): name is ExportPreset {
  return Object.hasOwn(EXPORT_PRESETS, name);
}

/**
 * Largest centered crop of aspect `targetW:targetH` that fits inside the canvas
 * (the "cover" framing — fills the target with no bars, trimming the long side).
 */
export function coverCrop(
  canvasW: number,
  canvasH: number,
  targetW: number,
  targetH: number,
): ExportCrop {
  const targetAspect = targetW / targetH;
  const canvasAspect = canvasW / canvasH;
  let w: number;
  let h: number;
  if (targetAspect > canvasAspect) {
    w = canvasW;
    h = canvasW / targetAspect;
  } else {
    h = canvasH;
    w = canvasH * targetAspect;
  }
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}

/** Clamp a crop to the canvas and round to whole pixels (sharp.extract needs ints). */
export function clampCrop(crop: ExportCrop, canvasW: number, canvasH: number): ExportCrop {
  const w = Math.max(1, Math.min(Math.round(crop.w), canvasW));
  const h = Math.max(1, Math.min(Math.round(crop.h), canvasH));
  const x = Math.max(0, Math.min(Math.round(crop.x), canvasW - w));
  const y = Math.max(0, Math.min(Math.round(crop.y), canvasH - h));
  return { x, y, w, h };
}

/** The effective, canvas-clamped integer crop for a scene's export settings. */
export function resolveExportCrop(canvas: Canvas, settings: ExportSettings): ExportCrop {
  const crop =
    settings.crop ?? coverCrop(canvas.width, canvas.height, settings.width, settings.height);
  return clampCrop(crop, canvas.width, canvas.height);
}

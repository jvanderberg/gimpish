/** Canvas-space geometry: anchors, fit resolution, gradient stops (see DESIGN.md §5). */

export const ANCHORS = {
  "top-left": [0, 0],
  top: [0.5, 0],
  "top-right": [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  "bottom-left": [0, 1],
  bottom: [0.5, 1],
  "bottom-right": [1, 1],
} as const satisfies Record<string, readonly [number, number]>;

export type Anchor = keyof typeof ANCHORS;

export function anchorFractions(anchor: string): readonly [number, number] {
  return (ANCHORS as Record<string, readonly [number, number]>)[anchor] ?? [0.5, 0.5];
}

export type FitMode = "fit" | "fill" | "cover";

export interface FitResult {
  scale: number;
  x: number;
  y: number;
}

/**
 * Place a srcW x srcH image on the canvas.
 *
 * fit   -> contain inside a box of (percent% of canvas), anchored
 * fill  -> cover the whole canvas (percent scales the cover), overflow cropped
 * cover -> alias of fill
 */
export function resolveFit(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  mode: FitMode,
  percent = 100,
  anchor = "center",
): FitResult {
  const frac = percent / 100;
  let scale: number;
  if (mode === "fit") {
    scale = Math.min((canvasW * frac) / srcW, (canvasH * frac) / srcH);
  } else if (mode === "fill" || mode === "cover") {
    scale = Math.max(canvasW / srcW, canvasH / srcH) * frac;
  } else {
    throw new Error(`unknown fit mode ${JSON.stringify(mode)} (use fit|fill|cover)`);
  }
  const [fx, fy] = anchorFractions(anchor);
  return {
    scale,
    x: (canvasW - srcW * scale) * fx,
    y: (canvasH - srcH * scale) * fy,
  };
}

export interface GradientStop {
  at: number;
  color: string;
}

/** Parse 'at:color, at:color, ...' e.g. '0:#000000ff, 1:#00000000'. */
export function parseStops(text: string): GradientStop[] {
  const stops: GradientStop[] = [];
  for (const rawPart of text.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const sep = part.indexOf(":");
    if (sep < 0) {
      throw new Error(`bad gradient stop ${JSON.stringify(part)}: expected 'position:#color'`);
    }
    const at = Number.parseFloat(part.slice(0, sep));
    const color = part.slice(sep + 1).trim();
    if (!Number.isFinite(at) || !color) {
      throw new Error(`bad gradient stop ${JSON.stringify(part)}: expected 'position:#color'`);
    }
    stops.push({ at, color });
  }
  if (stops.length < 2) throw new Error("gradient needs at least 2 stops");
  return stops.sort((a, b) => a.at - b.at);
}

/** Rotate (x, y) about (px, py) by `degrees` clockwise (screen-space y-down). */
export function rotatePoint(
  x: number,
  y: number,
  px: number,
  py: number,
  degrees: number,
): { x: number; y: number } {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = x - px;
  const dy = y - py;
  return { x: px + dx * c - dy * s, y: py + dx * s + dy * c };
}

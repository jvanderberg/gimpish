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

export interface ArrowGeometryInput {
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
  width: number;
  head_length?: number | undefined;
  head_width?: number | undefined;
}

/** The single closed arrow polygon used by both the SVG and browser renderers. */
export function arrowPolygonPoints(arrow: ArrowGeometryInput): Array<[number, number]> {
  const { from_x: x1, from_y: y1, to_x: x2, to_y: y2, width } = arrow;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length <= 0) throw new Error("arrow needs distinct endpoints");
  const headLength = Math.min(arrow.head_length ?? width * 2.4, length);
  const headWidth = arrow.head_width ?? width * 2.4;
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  const px = -uy;
  const py = ux;
  const bx = x2 - headLength * ux;
  const by = y2 - headLength * uy;
  return [
    [x1 + width * 0.5 * px, y1 + width * 0.5 * py],
    [bx + width * 0.5 * px, by + width * 0.5 * py],
    [bx + headWidth * 0.5 * px, by + headWidth * 0.5 * py],
    [x2, y2],
    [bx - headWidth * 0.5 * px, by - headWidth * 0.5 * py],
    [bx - width * 0.5 * px, by - width * 0.5 * py],
    [x1 - width * 0.5 * px, y1 - width * 0.5 * py],
  ];
}

export function radialGradientGeometry(
  width: number,
  height: number,
  center?: readonly [number, number],
  anchor = "center",
): { cx: number; cy: number; radius: number } {
  const [fx, fy] = center ?? anchorFractions(anchor);
  const cx = fx * width;
  const cy = fy * height;
  const radius = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(width - cx, cy),
    Math.hypot(cx, height - cy),
    Math.hypot(width - cx, height - cy),
    1e-6,
  );
  return { cx, cy, radius };
}

export function linearGradientGeometry(
  width: number,
  height: number,
  angle?: number,
  anchor = "top",
): { x1: number; y1: number; x2: number; y2: number } {
  let dx: number;
  let dy: number;
  if (angle !== undefined) {
    const radians = (angle * Math.PI) / 180;
    dx = Math.cos(radians);
    dy = Math.sin(radians);
  } else {
    const [fx, fy] = anchorFractions(anchor);
    dx = 0.5 - fx;
    dy = 0.5 - fy;
    const length = Math.hypot(dx, dy);
    if (length === 0) [dx, dy] = [0, 1];
    else {
      dx /= length;
      dy /= length;
    }
  }
  const projections = [0, width * dx, height * dy, width * dx + height * dy];
  const minimum = Math.min(...projections);
  const maximum = Math.max(...projections);
  return {
    x1: dx * minimum,
    y1: dy * minimum,
    x2: dx * maximum,
    y2: dy * maximum,
  };
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

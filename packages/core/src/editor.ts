/**
 * Interactive-editor operations: selection boxes and delta-based move/rotate/scale.
 *
 * Deltas map onto each layer type's own storage — image transform, shape rect,
 * text anchor, arrow endpoints, gradient center/angle — so a drag gesture in the
 * web UI commits one small, uniform patch regardless of type.
 */

import { anchorFractions, rotatePoint } from "./geometry.ts";
import type { Canvas, GradientSpec, Layer, Scene } from "./scene.ts";

/** Selection box in canvas pixels, with rotation pivot and capability flags. */
export interface LayerBox {
  id: string;
  type: Layer["type"];
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
  pivotx: number;
  pivoty: number;
  move: boolean;
  rotate: boolean;
  scale: boolean;
}

export interface Size {
  width: number;
  height: number;
}

function box(
  layer: Layer,
  cx: number,
  cy: number,
  w: number,
  h: number,
  opts: Partial<
    Pick<LayerBox, "rotation" | "pivotx" | "pivoty" | "move" | "rotate" | "scale">
  > = {},
): LayerBox {
  return {
    id: layer.id,
    type: layer.type,
    cx,
    cy,
    w,
    h,
    rotation: opts.rotation ?? 0,
    pivotx: opts.pivotx ?? cx,
    pivoty: opts.pivoty ?? cy,
    move: opts.move ?? true,
    rotate: opts.rotate ?? true,
    scale: opts.scale ?? true,
  };
}

export function radialCenter(canvas: Canvas, g: GradientSpec): { cx: number; cy: number } {
  if (g.center) return { cx: g.center[0] * canvas.width, cy: g.center[1] * canvas.height };
  const [fx, fy] = anchorFractions(g.anchor ?? "center");
  return { cx: fx * canvas.width, cy: fy * canvas.height };
}

/**
 * Selection box for a layer. Images/shapes rotate about their center; text about
 * its anchor; arrows about their midpoint; gradients map drag onto their own
 * parameters (radial center, linear angle).
 *
 * `naturalSize` (image layers) and `textBounds` (text layers) are resolved by the
 * caller — the render package owns pixel measurement; this module stays pure.
 */
export function layerBox(
  scene: Scene,
  layer: Layer,
  ctx: {
    naturalSize?: Size;
    textBounds?: { left: number; top: number; width: number; height: number };
  } = {},
): LayerBox | null {
  const { width: W, height: H } = scene.canvas;

  switch (layer.type) {
    case "image": {
      if (!ctx.naturalSize) return null;
      const t = layer.transform;
      const w = ctx.naturalSize.width * t.scale;
      const h = ctx.naturalSize.height * t.scale;
      return box(layer, t.x + w / 2, t.y + h / 2, w, h, { rotation: t.rotation });
    }
    case "shape": {
      const r = layer.rect;
      return box(layer, r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, {
        rotation: r.rotation ?? 0,
      });
    }
    case "text": {
      const b = ctx.textBounds;
      if (!b || b.width <= 0 || b.height <= 0) return null;
      // Rotation is baked into the rendered bounds (box is axis-aligned); the
      // pivot is the text anchor, which is what the renderer rotates about.
      return box(layer, b.left + b.width / 2, b.top + b.height / 2, b.width, b.height, {
        pivotx: layer.text.x,
        pivoty: layer.text.y,
      });
    }
    case "arrow": {
      const a = layer.arrow;
      const pad = Math.max(a.width, a.head_width ?? a.width * 2.4) / 2 + (a.outline_width ?? 0);
      const x0 = Math.min(a.from_x, a.to_x) - pad;
      const x1 = Math.max(a.from_x, a.to_x) + pad;
      const y0 = Math.min(a.from_y, a.to_y) - pad;
      const y1 = Math.max(a.from_y, a.to_y) + pad;
      return box(layer, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, {
        pivotx: (a.from_x + a.to_x) / 2,
        pivoty: (a.from_y + a.to_y) / 2,
      });
    }
    case "gradient": {
      const g = layer.gradient;
      const s = Math.min(W, H);
      if (g.kind === "radial") {
        // A grab indicator at the glow center; dragging moves that center.
        const { cx, cy } = radialCenter(scene.canvas, g);
        return box(layer, cx, cy, s * 0.28, s * 0.28, { rotate: false, scale: false });
      }
      // Linear: a centered indicator whose rotation shows the gradient angle;
      // the handle changes the angle, body-drag is disabled.
      return box(layer, W / 2, H / 2, s * 0.34, s * 0.34, {
        rotation: g.angle ?? 0,
        move: false,
        scale: false,
      });
    }
  }
}

/** Translate a layer by (dx, dy) canvas pixels, in its own storage form. */
export function applyMove(scene: Scene, layer: Layer, dx: number, dy: number): void {
  switch (layer.type) {
    case "image":
      layer.transform.x += dx;
      layer.transform.y += dy;
      return;
    case "shape":
      layer.rect.x += dx;
      layer.rect.y += dy;
      return;
    case "text":
      layer.text.x += dx;
      layer.text.y += dy;
      return;
    case "arrow":
      layer.arrow.from_x += dx;
      layer.arrow.from_y += dy;
      layer.arrow.to_x += dx;
      layer.arrow.to_y += dy;
      return;
    case "gradient": {
      if (layer.gradient.kind !== "radial") return;
      const { cx, cy } = radialCenter(scene.canvas, layer.gradient);
      layer.gradient.center = [(cx + dx) / scene.canvas.width, (cy + dy) / scene.canvas.height];
      return;
    }
  }
}

/** Rotate a layer by `drot` degrees clockwise about its natural pivot. */
export function applyRotate(_scene: Scene, layer: Layer, drot: number): void {
  switch (layer.type) {
    case "image":
      layer.transform.rotation += drot; // render keeps center fixed
      return;
    case "shape":
      layer.rect.rotation = (layer.rect.rotation ?? 0) + drot;
      return;
    case "text":
      layer.text.rotation += drot;
      return;
    case "arrow": {
      const a = layer.arrow;
      const mx = (a.from_x + a.to_x) / 2;
      const my = (a.from_y + a.to_y) / 2;
      const from = rotatePoint(a.from_x, a.from_y, mx, my, drot);
      const to = rotatePoint(a.to_x, a.to_y, mx, my, drot);
      a.from_x = from.x;
      a.from_y = from.y;
      a.to_x = to.x;
      a.to_y = to.y;
      return;
    }
    case "gradient":
      if (layer.gradient.kind === "linear") {
        layer.gradient.angle = (layer.gradient.angle ?? 0) + drot;
      }
      return;
  }
}

/**
 * Scale a layer by factor `f`, keeping its pivot fixed (center for image/shape,
 * anchor for text, midpoint for arrow). Image layers need `naturalSize` to hold
 * their center while transform.x/y (top-left) shifts.
 */
export function applyScale(layer: Layer, f: number, naturalSize?: Size): void {
  const factor = Math.max(0.02, Math.min(50, f));
  switch (layer.type) {
    case "image": {
      if (!naturalSize) return;
      const t = layer.transform;
      const cx = t.x + (naturalSize.width * t.scale) / 2;
      const cy = t.y + (naturalSize.height * t.scale) / 2;
      t.scale *= factor;
      t.x = cx - (naturalSize.width * t.scale) / 2;
      t.y = cy - (naturalSize.height * t.scale) / 2;
      return;
    }
    case "shape": {
      const r = layer.rect;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      r.w *= factor;
      r.h *= factor;
      r.x = cx - r.w / 2;
      r.y = cy - r.h / 2;
      return;
    }
    case "text":
      layer.text.size *= factor; // anchor held
      return;
    case "arrow": {
      const a = layer.arrow;
      const mx = (a.from_x + a.to_x) / 2;
      const my = (a.from_y + a.to_y) / 2;
      a.from_x = mx + (a.from_x - mx) * factor;
      a.from_y = my + (a.from_y - my) * factor;
      a.to_x = mx + (a.to_x - mx) * factor;
      a.to_y = my + (a.to_y - my) * factor;
      a.width *= factor;
      if (a.head_length != null) a.head_length *= factor;
      if (a.head_width != null) a.head_width *= factor;
      a.outline_width *= factor;
      return;
    }
    case "gradient":
      return; // gradients have no scale
  }
}

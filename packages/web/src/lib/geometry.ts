/**
 * Pure geometry helpers for the interactive canvas: contain-fit sizing,
 * screen-to-canvas coordinate mapping, hit-testing rotated boxes, and the
 * live drag-overlay math. No React, no DOM mutation — everything here is a
 * plain function of its inputs so it can be unit tested in isolation.
 */

import type { CSSProperties } from "react";
import type { LayerBox } from "../api";
import type { DragState } from "../hooks/useDrag";

export const DEG = 180 / Math.PI;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

let stampCounter = 0;

/** A stable per-gesture tag used to bust the preview/ghost image caches. */
export function nextStamp(): number {
  stampCounter += 1;
  return stampCounter;
}

export function containBox(availW: number, availH: number, aspect: number): Size {
  if (availW <= 0 || availH <= 0) return { w: 0, h: 0 };
  return availW / availH > aspect
    ? { w: availH * aspect, h: availH }
    : { w: availW, h: availW / aspect };
}

/** clientX/clientY -> canvas-space coords via the overlay SVG's own matrix. */
export function clientToCanvas(svg: SVGSVGElement, clientX: number, clientY: number): Point {
  const p = svg.createSVGPoint();
  p.x = clientX;
  p.y = clientY;
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const q = p.matrixTransform(m.inverse());
  return { x: q.x, y: q.y };
}

/** Is canvas point `pt` inside rotated box `b`? Rotate pt into the box frame. */
export function insideBox(b: LayerBox, pt: Point): boolean {
  const a = -b.rotation / DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = pt.x - b.cx;
  const dy = pt.y - b.cy;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

/** Topmost box (last in paint order) containing the point. */
export function hitTest(boxes: LayerBox[], pt: Point): string | null {
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const b = boxes[i];
    if (b && insideBox(b, pt)) return b.id;
  }
  return null;
}

/** Rotate a canvas point about a box's pivot by the box's rotation. */
export function rotAboutPivot(
  b: Pick<LayerBox, "rotation" | "pivotx" | "pivoty">,
  x: number,
  y: number,
): Point {
  const a = b.rotation / DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - b.pivotx;
  const dy = y - b.pivoty;
  return { x: b.pivotx + dx * c - dy * s, y: b.pivoty + dx * s + dy * c };
}

/**
 * Rotation-handle position (canvas coords): above the box's top-center in
 * the unrotated frame, then rotated about the box's pivot to match content.
 */
export function handlePos(b: LayerBox, off: number): Point {
  return rotAboutPivot(b, b.cx, b.cy - b.h / 2 - off);
}

/** The box's four corners in canvas coords (rotated about its pivot). */
export function corners(b: LayerBox): Point[] {
  const hw = b.w / 2;
  const hh = b.h / 2;
  const offsets: Point[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return offsets.map((o) => rotAboutPivot(b, b.cx + o.x, b.cy + o.y));
}

/** Apply an in-flight drag gesture to its box for live overlay rendering. */
export function applyDragToBox(box: LayerBox, drag: DragState | null): LayerBox {
  if (!drag || drag.id !== box.id) return box;
  if (drag.mode === "move") {
    const dx = drag.cur.cx - drag.orig.cx;
    const dy = drag.cur.cy - drag.orig.cy;
    return {
      ...box,
      cx: drag.cur.cx,
      cy: drag.cur.cy,
      pivotx: box.pivotx + dx,
      pivoty: box.pivoty + dy,
    };
  }
  if (drag.mode === "scale") {
    const f = drag.cur.scale;
    return {
      ...box,
      w: box.w * f,
      h: box.h * f,
      cx: drag.pivotx + (box.cx - drag.pivotx) * f,
      cy: drag.pivoty + (box.cy - drag.pivoty) * f,
    };
  }
  return { ...box, rotation: drag.cur.rotation };
}

/**
 * CSS transform for the floating ghost sprite during a drag: a pure
 * translate/rotate/scale derived from the gesture, applied on top of the
 * preview image which has the real layer hidden.
 */
export function ghostStyleFor(drag: DragState | null, hasBox: boolean, k: number): CSSProperties {
  if (!drag || !hasBox) return { display: "none" };
  if (drag.mode === "move") {
    const gx = (drag.cur.cx - drag.orig.cx) / k;
    const gy = (drag.cur.cy - drag.orig.cy) / k;
    return { display: "block", transform: `translate(${gx}px, ${gy}px)` };
  }
  if (drag.mode === "scale") {
    return {
      display: "block",
      transformOrigin: `${drag.pivotx / k}px ${drag.pivoty / k}px`,
      transform: `scale(${drag.cur.scale})`,
    };
  }
  const d = drag.cur.rotation - drag.orig.rotation;
  return {
    display: "block",
    transformOrigin: `${drag.pivotx / k}px ${drag.pivoty / k}px`,
    transform: `rotate(${d}deg)`,
  };
}

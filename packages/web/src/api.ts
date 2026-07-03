/**
 * Typed fetch helpers and structural Scene/Layer types for the editor UI.
 *
 * These are intentionally narrower than the server's zod schema (see
 * @gimpish/core `scene.ts`) — only the fields the UI actually reads are
 * modeled, so the wire contract can grow without this file changing.
 */

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface Mask {
  kind: string;
}

export interface GradientSpec {
  kind: "linear" | "radial";
  angle?: number;
}

export interface ArrowSpec {
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
}

export interface TextSpec {
  content: string;
  x: number;
  y: number;
  font: string;
  size: number;
  rotation?: number;
}

export interface RectSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
}

interface LayerCommon {
  id: string;
  name: string;
  opacity: number;
  blend: string;
  visible: boolean;
}

export type Layer =
  | (LayerCommon & {
      type: "image";
      source: string;
      transform: Transform;
      mask?: Mask | null;
    })
  | (LayerCommon & {
      type: "shape";
      shape: "rect" | "ellipse";
      rect: RectSpec;
      fill?: string | null;
      stroke?: string | null;
    })
  | (LayerCommon & { type: "gradient"; gradient: GradientSpec })
  | (LayerCommon & { type: "arrow"; arrow: ArrowSpec })
  | (LayerCommon & { type: "text"; text: TextSpec });

export interface Canvas {
  width: number;
  height: number;
  background: string;
}

export interface Scene {
  version: number;
  canvas: Canvas;
  layers: Layer[];
}

// The selection-box contract is core's own type — one definition, no drift.
export type { LayerBox } from "@gimpish/core/model";

import type { LayerBox } from "@gimpish/core/model";

export interface Geometry {
  canvas: { width: number; height: number };
  boxes: LayerBox[];
}

export interface TransformDelta {
  dx?: number;
  dy?: number;
  drot?: number;
  scale?: number;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return (await res.json()) as T;
}

export function fetchScene(): Promise<Scene> {
  return getJSON<Scene>("/api/scene");
}

export function fetchGeometry(): Promise<Geometry> {
  return getJSON<Geometry>("/api/geometry");
}

/** Composited preview PNG URL; `hideId` drops a layer (used mid-drag). */
export function previewUrl(ts: number, hideId?: string | null): string {
  const params = new URLSearchParams();
  if (hideId) params.set("hide", hideId);
  params.set("ts", String(ts));
  return `/api/preview.png?${params.toString()}`;
}

/** The drag "ghost": a single layer alone on a transparent canvas-size PNG. */
export function spriteUrl(id: string, ts: number): string {
  return `/api/layer/${encodeURIComponent(id)}/sprite.png?ts=${ts}`;
}

export async function postTransform(id: string, body: TransformDelta): Promise<void> {
  const res = await fetch(`/api/layer/${encodeURIComponent(id)}/transform`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`transform post responded ${res.status}`);
}

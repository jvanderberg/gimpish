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

export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  warmth: number;
  hue: number;
  shadows: number;
  highlights: number;
  clarity: number;
  sharpen: number;
}

interface LayerCommon {
  id: string;
  name: string;
  opacity: number;
  blend: string;
  visible: boolean;
  adjust?: Adjust;
  adjustEnabled?: boolean;
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
  export?: ExportSettings | null;
}

// The selection-box contract is core's own type — one definition, no drift.
export type { LayerBox } from "@gimpish/core/model";

import type { ExportSettings, LayerBox } from "@gimpish/core/model";

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

// ---- undo / redo -------------------------------------------------------------------

export interface HistoryDepths {
  undo: number;
  redo: number;
}

export function fetchHistory(): Promise<HistoryDepths> {
  return getJSON<HistoryDepths>("/api/history");
}

/** Undo/redo the last scene.json change (any writer: editor, CLI, agent). */
export async function postHistoryOp(op: "undo" | "redo"): Promise<void> {
  const res = await fetch(`/api/${op}`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${op} responded ${res.status}`);
  }
}

/** Move a layer to an absolute paint-order index (0 = back/bottom). */
export async function reorderLayer(id: string, index: number): Promise<void> {
  const res = await fetch(`/api/layer/${encodeURIComponent(id)}/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index }),
  });
  if (!res.ok) throw new Error(`reorder responded ${res.status}`);
}

export async function deleteLayer(id: string): Promise<void> {
  const res = await fetch(`/api/layer/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete responded ${res.status}`);
}

/** Toggle whether a layer's adjustments are applied at render time. */
export async function toggleAdjust(id: string, enabled: boolean): Promise<void> {
  const res = await fetch(`/api/layer/${encodeURIComponent(id)}/adjust-enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`adjust-enabled responded ${res.status}`);
}

/** Show or hide a layer at render time. */
export async function setLayerVisible(id: string, visible: boolean): Promise<void> {
  const res = await fetch(`/api/layer/${encodeURIComponent(id)}/visible`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visible }),
  });
  if (!res.ok) throw new Error(`visible responded ${res.status}`);
}

// ---- import / export ---------------------------------------------------------------

export type ExportFormat = "png" | "jpg" | "webp";

// Saved export target — shared shape with the core schema.
export type { ExportCrop, ExportSettings } from "@gimpish/core/model";

/** Render download URL (server sets Content-Disposition); omit size for native resolution. */
export function exportUrl(
  format: ExportFormat,
  size: { width?: number; height?: number } = {},
): string {
  const params = new URLSearchParams({ format });
  if (size.width) params.set("width", String(size.width));
  if (size.height) params.set("height", String(size.height));
  return `/api/export?${params.toString()}`;
}

/** Download URL for a cropped export at an exact output size. */
export function exportCropUrl(s: {
  format: ExportFormat;
  width: number;
  height: number;
  crop: { x: number; y: number; w: number; h: number };
}): string {
  const params = new URLSearchParams({
    format: s.format,
    width: String(Math.round(s.width)),
    height: String(Math.round(s.height)),
    cropX: String(Math.round(s.crop.x)),
    cropY: String(Math.round(s.crop.y)),
    cropW: String(Math.round(s.crop.w)),
    cropH: String(Math.round(s.crop.h)),
  });
  return `/api/export?${params.toString()}`;
}

/** Persist the scene's saved export settings (size + crop). */
export async function saveExportSettings(settings: ExportSettings): Promise<void> {
  const res = await fetch("/api/export-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`export-settings responded ${res.status}`);
}

/** Scene + all referenced assets as a relocatable .gimpish zip. */
export const BUNDLE_URL = "/api/bundle";

export type ImportResult =
  | { ok: true; kind: "image"; id: string; source: string; width: number; height: number }
  | { ok: true; kind: "bundle"; layers: number };

/** Upload a dropped/picked file. Images become layers; .gimpish replaces the scene. */
export async function importFile(file: File): Promise<ImportResult> {
  const res = await fetch(`/api/import?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const body = (await res.json()) as ImportResult | { error: string };
  if (!res.ok || "error" in body) {
    throw new Error("error" in body ? body.error : `import responded ${res.status}`);
  }
  return body;
}

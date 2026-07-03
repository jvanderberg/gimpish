/**
 * Scene schema and pure model operations (browser-safe — no node imports).
 *
 * The scene is the single source of truth: an ordered list of layers over a fixed
 * design canvas. Positions and sizes are in canvas-space pixels (DESIGN.md §5).
 * Layer order is paint order; index 0 is the bottom (back) layer.
 *
 * The zod schema IS the wire contract; file IO lives in doc.ts.
 */

import { z } from "zod";

export const SCENE_VERSION = 1;

// ---- schema -------------------------------------------------------------------

const TransformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().default(1),
  rotation: z.number().default(0), // degrees, clockwise
});

const MaskRectSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  w: z.number().optional(),
  h: z.number().optional(),
});

const MaskSchema = z.object({
  kind: z.enum(["cutout", "image", "shape"]),
  cache: z.string().nullish(),
  source: z.string().nullish(),
  shape: z.enum(["rect", "ellipse"]).nullish(),
  rect: MaskRectSchema.nullish(),
  feather: z.number().default(0),
  invert: z.boolean().default(false),
});

const GradientStopSchema = z.object({ at: z.number(), color: z.string() });

const GradientSpecSchema = z.object({
  kind: z.enum(["linear", "radial"]).default("linear"),
  stops: z.array(GradientStopSchema).min(2),
  anchor: z.string().optional(),
  angle: z.number().optional(),
  center: z.tuple([z.number(), z.number()]).optional(), // radial: [fx, fy] fractions
});

const ArrowSpecSchema = z.object({
  from_x: z.number(),
  from_y: z.number(),
  to_x: z.number(),
  to_y: z.number(),
  color: z.string().default("#e61e2dff"),
  width: z.number().default(24),
  head_length: z.number().optional(),
  head_width: z.number().optional(),
  outline: z.string().nullish(),
  // Optional so the renderer can default a *missing* value to width * 0.35;
  // an explicit 0 stays 0.
  outline_width: z.number().optional(),
});

const TextShadowSchema = z.object({
  color: z.string().default("#00000080"),
  dx: z.number().default(0),
  dy: z.number().default(0),
  blur: z.number().default(0),
});

const TextSpecSchema = z.object({
  content: z.string(),
  x: z.number().default(0),
  y: z.number().default(0),
  font: z.string().default("sans-serif"),
  size: z.number().default(64),
  weight: z.string().default("400"),
  style: z.enum(["normal", "italic", "oblique"]).default("normal"),
  align: z.enum(["left", "center", "right"]).default("left"),
  fill: z.string().default("#ffffffff"),
  gradient: GradientSpecSchema.optional(),
  stroke: z.string().nullish(),
  stroke_width: z.number().default(0),
  shadow: TextShadowSchema.optional(),
  line_height: z.number().default(1.15),
  letter_spacing: z.number().default(0),
  rotation: z.number().default(0),
});

const LayerBase = {
  id: z.string(),
  name: z.string().default(""),
  opacity: z.number().default(1),
  blend: z.string().default("normal"),
  visible: z.boolean().default(true),
  blur: z.number().nonnegative().optional(), // gaussian sigma in canvas pixels
};

const ImageLayerSchema = z.object({
  ...LayerBase,
  type: z.literal("image"),
  source: z.string(),
  transform: TransformSchema.default({ x: 0, y: 0, scale: 1, rotation: 0 }),
  mask: MaskSchema.nullish(),
});

const RectSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  w: z.number(),
  h: z.number(),
  rotation: z.number().optional(),
});

const ShapeLayerSchema = z.object({
  ...LayerBase,
  type: z.literal("shape"),
  shape: z.enum(["rect", "ellipse"]),
  rect: RectSchema,
  fill: z.string().nullish(),
  stroke: z.string().nullish(),
  stroke_width: z.number().default(0),
});

const GradientLayerSchema = z.object({
  ...LayerBase,
  type: z.literal("gradient"),
  gradient: GradientSpecSchema,
});

const ArrowLayerSchema = z.object({
  ...LayerBase,
  type: z.literal("arrow"),
  arrow: ArrowSpecSchema,
});

const TextLayerSchema = z.object({
  ...LayerBase,
  type: z.literal("text"),
  text: TextSpecSchema,
});

export const LayerSchema = z.discriminatedUnion("type", [
  ImageLayerSchema,
  ShapeLayerSchema,
  GradientLayerSchema,
  ArrowLayerSchema,
  TextLayerSchema,
]);

export const CanvasSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  background: z.string().default("transparent"), // "transparent" or "#rrggbbaa"
});

export const SceneSchema = z.object({
  version: z.number().default(SCENE_VERSION),
  canvas: CanvasSchema,
  layers: z.array(LayerSchema).default([]),
});

export type Transform = z.infer<typeof TransformSchema>;
export type Mask = z.infer<typeof MaskSchema>;
export type GradientSpec = z.infer<typeof GradientSpecSchema>;
export type ArrowSpec = z.infer<typeof ArrowSpecSchema>;
export type TextSpec = z.infer<typeof TextSpecSchema>;
export type ImageLayer = z.infer<typeof ImageLayerSchema>;
export type ShapeLayer = z.infer<typeof ShapeLayerSchema>;
export type GradientLayer = z.infer<typeof GradientLayerSchema>;
export type ArrowLayer = z.infer<typeof ArrowLayerSchema>;
export type TextLayer = z.infer<typeof TextLayerSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;
export type Scene = z.infer<typeof SceneSchema>;

export function parseScene(data: unknown): Scene {
  return SceneSchema.parse(data);
}

// ---- layer lookup / ordering -----------------------------------------------------

export function findLayer(scene: Scene, layerId: string): Layer {
  const layer = scene.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`no layer with id ${JSON.stringify(layerId)}`);
  return layer;
}

export function layerIndex(scene: Scene, layerId: string): number {
  const i = scene.layers.findIndex((l) => l.id === layerId);
  if (i < 0) throw new Error(`no layer with id ${JSON.stringify(layerId)}`);
  return i;
}

/**
 * Move a layer to paint-order index `to` (0 = back/bottom), interpreted after
 * the layer is removed — same semantics as `layer move --to`. Returns the
 * clamped index actually used.
 */
export function moveLayerTo(scene: Scene, layerId: string, to: number): number {
  const i = layerIndex(scene, layerId);
  const [layer] = scene.layers.splice(i, 1) as [Layer];
  const j = Math.max(0, Math.min(scene.layers.length, Math.trunc(to)));
  scene.layers.splice(j, 0, layer);
  return j;
}

/** Remove a layer from the scene, returning it. */
export function removeLayer(scene: Scene, layerId: string): Layer {
  const [layer] = scene.layers.splice(layerIndex(scene, layerId), 1) as [Layer];
  return layer;
}

export function uniqueId(scene: Scene, base: string): string {
  const slugged = slug(base) || "layer";
  const existing = new Set(scene.layers.map((l) => l.id));
  if (!existing.has(slugged)) return slugged;
  let n = 2;
  while (existing.has(`${slugged}${n}`)) n += 1;
  return `${slugged}${n}`;
}

export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]+/g, "")
    .replace(/[ _-]+/g, "-")
    .replace(/^-|-$/g, "");
}

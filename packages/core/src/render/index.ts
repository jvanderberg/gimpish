/**
 * The single render path (sharp/libvips). Used by preview / render / export / serve.
 *
 * Every layer renders to a raw RGBA raster plus a top-left offset, is embedded
 * onto a canvas-sized transparent frame (which makes negative offsets and
 * overflow behave), then composited bottom-to-top with its blend mode — the same
 * pipeline shape as the original Python engine, validated by the golden fixtures.
 */

import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { SceneDoc } from "../doc.ts";
import { sceneRoot } from "../doc.ts";
import type { Layer, Mask, ShapeLayer } from "../schema.ts";
import {
  alphaBounds,
  applyMaskBand,
  applyOpacity,
  embed,
  type Raster,
  solid,
  transparent,
} from "./raster.ts";
import { arrowSvg, gradientSvg, shapeSvg, textSvg } from "./svg.ts";

// Map scene blend names to libvips composite modes. "normal" == Porter-Duff "over".
export const BLEND_MODES: Record<string, string> = {
  normal: "over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "colour-dodge",
  "color-burn": "colour-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  add: "add",
};

export interface RenderOptions {
  width?: number | undefined;
  height?: number | undefined;
  /** Layer ids to skip — used by the live editor's ghost-drag preview. */
  hide?: ReadonlySet<string> | undefined;
}

// ---- decode helpers ---------------------------------------------------------------

async function toRaster(pipeline: sharp.Sharp): Promise<Raster> {
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function fromRaster(img: Raster): sharp.Sharp {
  return sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 },
  });
}

async function rasterizeSvg(svg: string): Promise<Raster> {
  return toRaster(sharp(Buffer.from(svg)));
}

/** Cached natural (unscaled) image dimensions, keyed by resolved path + mtime
 * so a replaced file invalidates its entry during a long `serve` session. */
const sizeCache = new Map<string, { width: number; height: number }>();

export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const resolved = path.resolve(file);
  const key = `${resolved}@${statSync(resolved).mtimeMs}`;
  const hit = sizeCache.get(key);
  if (hit) return hit;
  const meta = await sharp(resolved).metadata();
  const size = { width: meta.width, height: meta.height };
  sizeCache.set(key, size);
  return size;
}

/** Probe in-memory image bytes (throws on undecodable data). Used by uploads. */
export async function imageMeta(
  data: Uint8Array,
): Promise<{ width: number; height: number; format: string }> {
  const meta = await sharp(data).metadata();
  return { width: meta.width, height: meta.height, format: meta.format ?? "png" };
}

// ---- masks ------------------------------------------------------------------------

/** Load a mask as a single-band 0..255 buffer sized to (w, h). */
async function loadMaskBand(root: string, mask: Mask, w: number, h: number): Promise<Uint8Array> {
  let band: Buffer;
  let bw: number;
  let bh: number;

  if (mask.kind === "cutout" || mask.kind === "image") {
    const file = mask.kind === "cutout" ? mask.cache : mask.source;
    if (!file)
      throw new Error(
        `${mask.kind} mask missing ${mask.kind === "cutout" ? "cache" : "source"} path`,
      );
    const img = sharp(path.join(root, file));
    const meta = await img.metadata();
    const hasAlpha = meta.channels === 4 || meta.channels === 2;
    const { data, info } = await (hasAlpha
      ? img.extractChannel(meta.channels === 4 ? 3 : 1)
      : img.greyscale()
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    band = data;
    bw = info.width;
    bh = info.height;
  } else {
    band = shapeMaskBand(mask, w, h);
    bw = w;
    bh = h;
  }

  const needsResize = bw !== w || bh !== h;
  if (!needsResize && !mask.invert && !(mask.feather > 0)) return band;

  let pipeline = sharp(band, { raw: { width: bw, height: bh, channels: 1 } });
  if (needsResize) pipeline = pipeline.resize(w, h, { fit: "fill" });
  if (mask.invert) pipeline = pipeline.negate();
  if (mask.feather > 0) pipeline = pipeline.blur(mask.feather);
  // NB: without an explicit b-w colourspace sharp expands 1-channel raw input
  // to 3-channel sRGB output, which would corrupt the band's stride.
  const { data, info } = await pipeline
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) throw new Error(`mask band has ${info.channels} channels`);
  return data;
}

function shapeMaskBand(mask: Mask, w: number, h: number): Buffer {
  const rect = mask.rect ?? { x: 0, y: 0, w, h };
  const rx = rect.x;
  const ry = rect.y;
  const rw = rect.w ?? w;
  const rh = rect.h ?? h;
  const out = Buffer.alloc(w * h);

  if (mask.shape === "ellipse") {
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    for (let yy = 0; yy < h; yy += 1) {
      for (let xx = 0; xx < w; xx += 1) {
        const nx = (xx - cx) / (rw / 2);
        const ny = (yy - cy) / (rh / 2);
        if (nx * nx + ny * ny <= 1) out[yy * w + xx] = 255;
      }
    }
  } else {
    const x0 = Math.max(0, Math.trunc(rx));
    const y0 = Math.max(0, Math.trunc(ry));
    const x1 = Math.min(w, Math.trunc(rx) + Math.trunc(rw));
    const y1 = Math.min(h, Math.trunc(ry) + Math.trunc(rh));
    for (let yy = y0; yy < y1; yy += 1) out.fill(255, yy * w + x0, yy * w + x1);
  }
  return out;
}

// ---- per-layer rendering ------------------------------------------------------------

interface Placed {
  img: Raster;
  x: number;
  y: number;
}

async function renderImageLayer(doc: SceneDoc, layer: Layer & { type: "image" }): Promise<Placed> {
  const root = sceneRoot(doc);
  const file = path.join(root, layer.source);
  let img = await toRaster(sharp(file).toColourspace("srgb"));

  if (layer.mask) {
    const band = await loadMaskBand(root, layer.mask, img.width, img.height);
    applyMaskBand(img, band);
  }

  const t = layer.transform;
  if (t.scale !== 1) {
    img = await toRaster(
      fromRaster(img).resize(
        Math.max(1, Math.round(img.width * t.scale)),
        Math.max(1, Math.round(img.height * t.scale)),
        { fit: "fill", kernel: "lanczos3" },
      ),
    );
  }

  let x = t.x;
  let y = t.y;
  if (t.rotation) {
    const cx = x + img.width / 2;
    const cy = y + img.height / 2;
    img = await toRaster(
      fromRaster(img).rotate(t.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }),
    );
    x = cx - img.width / 2;
    y = cy - img.height / 2;
  }
  return { img, x, y };
}

async function renderShapeLayer(layer: ShapeLayer): Promise<Placed> {
  if (layer.rect.w <= 0 || layer.rect.h <= 0) {
    throw new Error(`shape layer ${JSON.stringify(layer.id)} needs positive w/h`);
  }
  let img = await rasterizeSvg(shapeSvg(layer));
  let x = layer.rect.x;
  let y = layer.rect.y;
  const rot = layer.rect.rotation ?? 0;
  if (rot) {
    const cx = x + img.width / 2;
    const cy = y + img.height / 2;
    img = await toRaster(
      fromRaster(img).rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } }),
    );
    x = cx - img.width / 2;
    y = cy - img.height / 2;
  }
  return { img, x, y };
}

/**
 * Gaussian-blur a placed layer raster. The raster is padded by 3*sigma of
 * transparency first so the blur spreads outward past the layer bounds.
 * (sharp premultiplies alpha internally around blur, so transparent-region
 * colors can't halo into visible edges.)
 */
async function blurPlaced(placed: Placed, sigma: number): Promise<Placed> {
  const pad = Math.ceil(sigma * 3);
  const blurred = await toRaster(
    fromRaster(placed.img)
      .extend({
        top: pad,
        bottom: pad,
        left: pad,
        right: pad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .blur(sigma),
  );
  return { img: blurred, x: placed.x - pad, y: placed.y - pad };
}

async function renderLayer(doc: SceneDoc, layer: Layer): Promise<Placed> {
  const placed = await renderLayerContent(doc, layer);
  return layer.blur && layer.blur > 0 ? blurPlaced(placed, layer.blur) : placed;
}

async function renderLayerContent(doc: SceneDoc, layer: Layer): Promise<Placed> {
  switch (layer.type) {
    case "image":
      return renderImageLayer(doc, layer);
    case "shape":
      return renderShapeLayer(layer);
    case "gradient":
      return { img: await rasterizeSvg(gradientSvg(doc.scene.canvas, layer.gradient)), x: 0, y: 0 };
    case "arrow":
      return { img: await rasterizeSvg(arrowSvg(doc.scene.canvas, layer.arrow)), x: 0, y: 0 };
    case "text":
      return { img: await rasterizeSvg(textSvg(doc.scene.canvas, layer.text)), x: 0, y: 0 };
  }
}

// ---- scene composition ----------------------------------------------------------------

/** Composite the whole scene to a raw RGBA raster at canvas size (then optional resize). */
export async function renderScene(doc: SceneDoc, opts: RenderOptions = {}): Promise<Raster> {
  const { width: W, height: H, background } = doc.scene.canvas;
  const base =
    background === "transparent" || background == null
      ? transparent(W, H)
      : solid(W, H, background);

  const overlays: sharp.OverlayOptions[] = [];
  for (const layer of doc.scene.layers) {
    if (!layer.visible || opts.hide?.has(layer.id)) continue;
    const { img, x, y } = await renderLayer(doc, layer);
    applyOpacity(img, layer.opacity);
    const placed = embed(img, x, y, W, H);
    if (!placed) continue;
    const blend = BLEND_MODES[layer.blend] ?? "over";
    overlays.push({
      input: placed.data,
      raw: { width: W, height: H, channels: 4 },
      blend: blend as sharp.Blend,
      top: 0,
      left: 0,
    });
  }

  let out = fromRaster(base);
  if (overlays.length > 0) out = out.composite(overlays);

  if (opts.width || opts.height) {
    const sx = opts.width ? opts.width / W : (opts.height as number) / H;
    const sy = opts.height ? opts.height / H : sx;
    const composited = await toRaster(out);
    return toRaster(
      fromRaster(composited).resize(Math.round(W * sx), Math.round(H * sy), { fit: "fill" }),
    );
  }
  return toRaster(out);
}

/** Downscaled render capped at `maxDim` (aspect preserved). */
export async function renderPreview(
  doc: SceneDoc,
  maxDim = 1024,
  hide?: ReadonlySet<string>,
): Promise<Raster> {
  const { width: W, height: H } = doc.scene.canvas;
  if (Math.max(W, H) <= maxDim) return renderScene(doc, { hide });
  const scale = maxDim / Math.max(W, H);
  return renderScene(doc, {
    width: Math.round(W * scale),
    height: Math.round(H * scale),
    hide,
  });
}

/**
 * Render a single layer alone on a transparent full canvas at preview scale —
 * the live editor's draggable "ghost" sprite.
 */
export async function renderLayerSprite(
  doc: SceneDoc,
  layer: Layer,
  maxDim = 1400,
): Promise<Raster> {
  const { width: W, height: H } = doc.scene.canvas;
  const { img, x, y } = await renderLayer(doc, layer);
  applyOpacity(img, layer.opacity);
  const placed = embed(img, x, y, W, H) ?? transparent(W, H);
  if (Math.max(W, H) <= maxDim) return placed;
  const scale = maxDim / Math.max(W, H);
  return toRaster(
    fromRaster(placed).resize(Math.round(W * scale), Math.round(H * scale), { fit: "fill" }),
  );
}

/** On-canvas alpha bounding box of a text layer (drives its selection box). */
export async function textBounds(
  doc: SceneDoc,
  layer: Layer & { type: "text" },
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const img = await rasterizeSvg(textSvg(doc.scene.canvas, layer.text));
  return alphaBounds(img);
}

// ---- encoding ---------------------------------------------------------------------

export async function rasterToPng(img: Raster): Promise<Buffer> {
  return fromRaster(img).png().toBuffer();
}

export type EncodeFormat = "png" | "jpg" | "webp";

/** Encode a raster to png/jpg/webp bytes (jpeg is flattened onto white — no alpha). */
export async function encodeRaster(
  img: Raster,
  format: EncodeFormat,
  quality = 90,
): Promise<Buffer> {
  let pipeline = fromRaster(img);
  if (format === "jpg") {
    pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality });
  } else if (format === "webp") {
    pipeline = pipeline.webp({ quality });
  } else {
    pipeline = pipeline.png();
  }
  return pipeline.toBuffer();
}

function formatForExt(ext: string): EncodeFormat {
  if (ext === ".jpg" || ext === ".jpeg") return "jpg";
  if (ext === ".webp") return "webp";
  return "png";
}

export async function renderToFile(
  doc: SceneDoc,
  out: string,
  opts: RenderOptions & { quality?: number } = {},
): Promise<string> {
  const img = await renderScene(doc, opts);
  const format = formatForExt(path.extname(out).toLowerCase());
  writeFileSync(out, await encodeRaster(img, format, opts.quality ?? 90));
  return out;
}

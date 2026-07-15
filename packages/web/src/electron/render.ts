import type { ArrowLayer, GradientSpec, Layer, Scene, TextLayer } from "@gimpish/core/model";
import {
  anchorFractions,
  coverCrop,
  type ExportCrop,
  type ImageLayer,
  type Mask,
  parseColor,
} from "@gimpish/core/model";
import { applyBrowserAdjustments, isBrowserAdjustNeutral } from "./adjust";
import type { GimpishElectronApi } from "./api";

const imageCache = new Map<string, Promise<ImageBitmap>>();
const maskedImageCache = new Map<string, Promise<ImageBitmap>>();
const adjustedLayerCache = new Map<string, Promise<ImageBitmap>>();

export function clearRendererCaches(): void {
  for (const pending of imageCache.values()) {
    void pending.then(
      (image) => image.close(),
      () => undefined,
    );
  }
  for (const pending of maskedImageCache.values()) {
    void pending.then(
      (image) => image.close(),
      () => undefined,
    );
  }
  for (const pending of adjustedLayerCache.values()) {
    void pending.then(
      (image) => image.close(),
      () => undefined,
    );
  }
  imageCache.clear();
  maskedImageCache.clear();
  adjustedLayerCache.clear();
}

function cssColor(color: string): string {
  if (color === "transparent") return "rgba(0,0,0,0)";
  const [r, g, b, a] = parseColor(color);
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

async function loadImage(api: GimpishElectronApi, storedPath: string): Promise<ImageBitmap> {
  let pending = imageCache.get(storedPath);
  if (!pending) {
    pending = api.readAsset(storedPath).then(async ({ mimeType, data }) => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return createImageBitmap(new Blob([bytes], { type: mimeType }), {
        imageOrientation: "from-image",
      });
    });
    imageCache.set(storedPath, pending);
  }
  return pending;
}

function maskAlpha(mask: Mask, rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length / 4);
  let hasUsefulAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      hasUsefulAlpha = true;
      break;
    }
  }
  for (let pixel = 0; pixel < out.length; pixel += 1) {
    const offset = pixel * 4;
    const alpha =
      mask.kind === "cutout" || hasUsefulAlpha
        ? (rgba[offset + 3] ?? 0)
        : Math.round(
            0.2126 * (rgba[offset] ?? 0) +
              0.7152 * (rgba[offset + 1] ?? 0) +
              0.0722 * (rgba[offset + 2] ?? 0),
          );
    out[pixel] = mask.invert ? 255 - alpha : alpha;
  }
  return out;
}

async function makeMaskCanvas(
  api: GimpishElectronApi,
  mask: Mask,
  width: number,
  height: number,
): Promise<OffscreenCanvas> {
  const raw = new OffscreenCanvas(width, height);
  const ctx = raw.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable");

  if (mask.kind === "shape") {
    const rect = mask.rect ?? { x: 0, y: 0, w: width, h: height };
    const x = rect.x;
    const y = rect.y;
    const w = rect.w ?? width;
    const h = rect.h ?? height;
    ctx.fillStyle = mask.invert ? "black" : "white";
    if (mask.invert) ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = mask.invert ? "destination-out" : "source-over";
    ctx.beginPath();
    if (mask.shape === "ellipse") {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else ctx.rect(x, y, w, h);
    ctx.fill();
  } else {
    const storedPath = mask.kind === "cutout" ? mask.cache : mask.source;
    if (!storedPath) throw new Error(`${mask.kind} mask is missing its asset path`);
    const image = await loadImage(api, storedPath);
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    const alpha = maskAlpha(mask, pixels.data);
    for (let pixel = 0; pixel < alpha.length; pixel += 1) {
      const offset = pixel * 4;
      pixels.data[offset] = 255;
      pixels.data[offset + 1] = 255;
      pixels.data[offset + 2] = 255;
      pixels.data[offset + 3] = alpha[pixel] ?? 0;
    }
    ctx.putImageData(pixels, 0, 0);
  }

  if (!(mask.feather > 0)) return raw;
  const feathered = new OffscreenCanvas(width, height);
  const featherCtx = feathered.getContext("2d");
  if (!featherCtx) throw new Error("2D canvas is unavailable");
  featherCtx.filter = `blur(${mask.feather}px)`;
  featherCtx.drawImage(raw, 0, 0);
  return feathered;
}

async function imageForLayer(api: GimpishElectronApi, layer: ImageLayer): Promise<ImageBitmap> {
  const source = await loadImage(api, layer.source);
  const layerMask = layer.mask;
  if (!layerMask) return source;
  const key = `${layer.source}\u0000${JSON.stringify(layerMask)}`;
  let pending = maskedImageCache.get(key);
  if (!pending) {
    pending = (async () => {
      const canvas = new OffscreenCanvas(source.width, source.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D canvas is unavailable");
      ctx.drawImage(source, 0, 0);
      const mask = await makeMaskCanvas(api, layerMask, source.width, source.height);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(mask, 0, 0);
      return createImageBitmap(canvas);
    })();
    maskedImageCache.set(key, pending);
  }
  return pending;
}

function blendMode(layer: Layer): GlobalCompositeOperation {
  const modes: Record<string, GlobalCompositeOperation> = {
    normal: "source-over",
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighten: "lighten",
    "color-dodge": "color-dodge",
    "color-burn": "color-burn",
    "hard-light": "hard-light",
    "soft-light": "soft-light",
    difference: "difference",
    exclusion: "exclusion",
    add: "lighter",
  };
  return modes[layer.blend] ?? "source-over";
}

function gradient(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scene: Scene,
  spec: GradientSpec,
): CanvasGradient {
  const { width, height } = scene.canvas;
  let result: CanvasGradient;
  if (spec.kind === "radial") {
    const center = spec.center ?? anchorFractions(spec.anchor ?? "center");
    const cx = center[0] * width;
    const cy = center[1] * height;
    result = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(width, height) / 2);
  } else {
    const angle = ((spec.angle ?? 0) * Math.PI) / 180;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.abs(width * Math.cos(angle)) / 2 + Math.abs(height * Math.sin(angle)) / 2;
    const dx = Math.cos(angle) * radius;
    const dy = Math.sin(angle) * radius;
    result = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  }
  for (const stop of spec.stops) result.addColorStop(stop.at, cssColor(stop.color));
  return result;
}

function setLayerEffects(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: Layer,
): void {
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = blendMode(layer);
  const filters: string[] = [];
  if (layer.blur && layer.blur > 0) filters.push(`blur(${layer.blur}px)`);
  ctx.filter = filters.join(" ") || "none";
  if (layer.shadow) {
    ctx.shadowColor = cssColor(layer.shadow.color);
    ctx.shadowOffsetX = layer.shadow.dx;
    ctx.shadowOffsetY = layer.shadow.dy;
    ctx.shadowBlur = layer.shadow.blur * 2;
  }
}

function drawText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scene: Scene,
  layer: TextLayer,
): void {
  const t = layer.text;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(((t.rotation ?? 0) * Math.PI) / 180);
  ctx.font = `${t.style} ${t.weight} ${t.size}px ${JSON.stringify(t.font)}`;
  ctx.letterSpacing = `${t.letter_spacing}px`;
  ctx.textAlign = t.align;
  ctx.textBaseline = "top";
  if (t.shadow) {
    ctx.shadowColor = cssColor(t.shadow.color);
    ctx.shadowOffsetX = t.shadow.dx;
    ctx.shadowOffsetY = t.shadow.dy;
    ctx.shadowBlur = t.shadow.blur * 2;
  }
  const lines = t.content.split("\n");
  const lineHeight = t.size * t.line_height;
  for (const [index, line] of lines.entries()) {
    const y = index * lineHeight;
    if (t.stroke && t.stroke_width > 0) {
      ctx.strokeStyle = cssColor(t.stroke);
      ctx.lineWidth = t.stroke_width * 2;
      ctx.lineJoin = "round";
      ctx.strokeText(line, 0, y);
    }
    ctx.fillStyle = t.gradient ? gradient(ctx, scene, t.gradient) : cssColor(t.fill);
    ctx.fillText(line, 0, y);
  }
  ctx.restore();
}

function drawArrow(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: ArrowLayer,
): void {
  const a = layer.arrow;
  const paint = (color: string, extra: number) => {
    const width = a.width + extra * 2;
    const headLength = (a.head_length ?? a.width * 2.2) + extra;
    const headWidth = (a.head_width ?? a.width * 2.8) + extra * 2;
    const angle = Math.atan2(a.to_y - a.from_y, a.to_x - a.from_x);
    const bx = a.to_x - Math.cos(angle) * headLength;
    const by = a.to_y - Math.sin(angle) * headLength;
    const nx = -Math.sin(angle) * (headWidth / 2);
    const ny = Math.cos(angle) * (headWidth / 2);
    ctx.beginPath();
    ctx.moveTo(a.from_x, a.from_y);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = cssColor(color);
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(a.to_x, a.to_y);
    ctx.lineTo(bx + nx, by + ny);
    ctx.lineTo(bx - nx, by - ny);
    ctx.closePath();
    ctx.fillStyle = cssColor(color);
    ctx.fill();
  };

  if (a.outline && (a.outline_width ?? 0) > 0) paint(a.outline, a.outline_width ?? 0);
  paint(a.color, 0);
}

async function drawLayerContent(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scene: Scene,
  layer: Layer,
  api: GimpishElectronApi,
): Promise<void> {
  switch (layer.type) {
    case "image": {
      const image = await imageForLayer(api, layer);
      const t = layer.transform;
      const width = image.width * t.scale;
      const height = image.height * t.scale;
      ctx.translate(t.x + width / 2, t.y + height / 2);
      ctx.rotate((t.rotation * Math.PI) / 180);
      ctx.drawImage(image, -width / 2, -height / 2, width, height);
      break;
    }
    case "shape": {
      const r = layer.rect;
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.rotate(((r.rotation ?? 0) * Math.PI) / 180);
      ctx.beginPath();
      if (layer.shape === "ellipse") ctx.ellipse(0, 0, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(-r.w / 2, -r.h / 2, r.w, r.h);
      if (layer.fill) {
        ctx.fillStyle = cssColor(layer.fill);
        ctx.fill();
      }
      if (layer.stroke && layer.stroke_width > 0) {
        ctx.strokeStyle = cssColor(layer.stroke);
        ctx.lineWidth = layer.stroke_width;
        ctx.stroke();
      }
      break;
    }
    case "gradient":
      ctx.fillStyle = gradient(ctx, scene, layer.gradient);
      ctx.fillRect(0, 0, scene.canvas.width, scene.canvas.height);
      break;
    case "arrow":
      drawArrow(ctx, layer);
      break;
    case "text":
      drawText(ctx, scene, layer);
      break;
  }
}

async function drawLayer(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scene: Scene,
  layer: Layer,
  api: GimpishElectronApi,
): Promise<void> {
  if (!layer.visible) return;
  ctx.save();
  setLayerEffects(ctx, layer);
  const adjust = layer.adjustEnabled === false ? undefined : layer.adjust;
  if (adjust && !isBrowserAdjustNeutral(adjust)) {
    const key = `${scene.canvas.width}x${scene.canvas.height}\u0000${JSON.stringify(layer)}`;
    let pending = adjustedLayerCache.get(key);
    if (!pending) {
      pending = (async () => {
        const surface = new OffscreenCanvas(scene.canvas.width, scene.canvas.height);
        const surfaceCtx = surface.getContext("2d", { willReadFrequently: true });
        if (!surfaceCtx) throw new Error("2D canvas is unavailable");
        await drawLayerContent(surfaceCtx, scene, layer, api);
        const pixels = surfaceCtx.getImageData(0, 0, surface.width, surface.height);
        applyBrowserAdjustments(pixels.data, pixels.width, pixels.height, adjust);
        surfaceCtx.putImageData(pixels, 0, 0);
        return createImageBitmap(surface);
      })();
      adjustedLayerCache.set(key, pending);
      if (adjustedLayerCache.size > 12) {
        const oldest = adjustedLayerCache.entries().next().value as
          | [string, Promise<ImageBitmap>]
          | undefined;
        if (oldest) {
          adjustedLayerCache.delete(oldest[0]);
          void oldest[1].then(
            (image) => image.close(),
            () => undefined,
          );
        }
      }
    }
    ctx.drawImage(await pending, 0, 0);
  } else {
    await drawLayerContent(ctx, scene, layer, api);
  }
  ctx.restore();
}

export async function renderScene(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  scene: Scene,
  api: GimpishElectronApi,
  outputWidth = scene.canvas.width,
  outputHeight = scene.canvas.height,
  sourceCrop?: ExportCrop,
): Promise<void> {
  canvas.width = Math.max(1, Math.round(outputWidth));
  canvas.height = Math.max(1, Math.round(outputHeight));
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("2D canvas is unavailable");
  const crop =
    sourceCrop ?? coverCrop(scene.canvas.width, scene.canvas.height, canvas.width, canvas.height);
  const sx = canvas.width / crop.w;
  const sy = canvas.height / crop.h;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(sx, sy);
  ctx.translate(-crop.x, -crop.y);
  if (scene.canvas.background !== "transparent") {
    ctx.fillStyle = cssColor(scene.canvas.background);
    ctx.fillRect(0, 0, scene.canvas.width, scene.canvas.height);
  }
  for (const layer of scene.layers) await drawLayer(ctx, scene, layer, api);
  ctx.restore();
}

export async function imageNaturalSize(
  api: GimpishElectronApi,
  storedPath: string,
): Promise<{ width: number; height: number }> {
  const image = await loadImage(api, storedPath);
  return { width: image.width, height: image.height };
}

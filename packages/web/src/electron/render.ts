import type { ArrowLayer, GradientSpec, Layer, Scene, TextLayer } from "@gimpish/core/model";
import { parseColor } from "@gimpish/core/model";
import type { GimpishElectronApi } from "./api";

const imageCache = new Map<string, Promise<ImageBitmap>>();

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
    const center = spec.center ?? [0.5, 0.5];
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
  if (layer.adjust && layer.adjustEnabled !== false) {
    const a = layer.adjust;
    if (a.brightness) filters.push(`brightness(${100 + a.brightness}%)`);
    if (a.contrast) filters.push(`contrast(${100 + a.contrast}%)`);
    if (a.saturation) filters.push(`saturate(${100 + a.saturation}%)`);
    if (a.hue) filters.push(`hue-rotate(${a.hue}deg)`);
  }
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
  const angle = Math.atan2(a.to_y - a.from_y, a.to_x - a.from_x);
  const headLength = a.head_length ?? a.width * 2.2;
  const headWidth = a.head_width ?? a.width * 2.8;
  const bx = a.to_x - Math.cos(angle) * headLength;
  const by = a.to_y - Math.sin(angle) * headLength;
  const nx = -Math.sin(angle) * (headWidth / 2);
  const ny = Math.cos(angle) * (headWidth / 2);
  ctx.beginPath();
  ctx.moveTo(a.from_x, a.from_y);
  ctx.lineTo(bx, by);
  ctx.strokeStyle = cssColor(a.color);
  ctx.lineWidth = a.width;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(a.to_x, a.to_y);
  ctx.lineTo(bx + nx, by + ny);
  ctx.lineTo(bx - nx, by - ny);
  ctx.closePath();
  ctx.fillStyle = cssColor(a.color);
  ctx.fill();
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
  switch (layer.type) {
    case "image": {
      const image = await loadImage(api, layer.source);
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
  ctx.restore();
}

export async function renderScene(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  scene: Scene,
  api: GimpishElectronApi,
  outputWidth = scene.canvas.width,
  outputHeight = scene.canvas.height,
): Promise<void> {
  canvas.width = Math.max(1, Math.round(outputWidth));
  canvas.height = Math.max(1, Math.round(outputHeight));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable");
  const sx = canvas.width / scene.canvas.width;
  const sy = canvas.height / scene.canvas.height;
  ctx.save();
  ctx.scale(sx, sy);
  ctx.clearRect(0, 0, scene.canvas.width, scene.canvas.height);
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

/** Icon + subtitle text for a layer row in the panel list. */

import type { Layer } from "../api";

const ICONS: Record<string, string> = {
  image: "🖼",
  arrow: "➜",
  text: "T",
};

export function shapeIcon(layer: Layer): string {
  if (layer.type === "shape") return layer.shape === "ellipse" ? "⬭" : "▭";
  if (layer.type === "gradient") return layer.gradient.kind === "radial" ? "◎" : "▧";
  return ICONS[layer.type] ?? "?";
}

export function adjustSubtitle(layer: Layer): string {
  const a = layer.adjust;
  if (!a) return "";
  const parts: string[] = [];
  if (a.brightness !== 0) parts.push(`b${a.brightness > 0 ? "+" : ""}${a.brightness}`);
  if (a.contrast !== 0) parts.push(`c${a.contrast > 0 ? "+" : ""}${a.contrast}`);
  if (a.saturation !== 0) parts.push(`s${a.saturation > 0 ? "+" : ""}${a.saturation}`);
  if (a.exposure !== 0) parts.push(`e${a.exposure > 0 ? "+" : ""}${a.exposure}`);
  if (a.warmth !== 0) parts.push(`w${a.warmth > 0 ? "+" : ""}${a.warmth}`);
  if (a.hue !== 0) parts.push(`h${a.hue > 0 ? "+" : ""}${a.hue}`);
  if (a.shadows !== 0) parts.push(`sh${a.shadows > 0 ? "+" : ""}${a.shadows}`);
  if (a.highlights !== 0) parts.push(`hi${a.highlights > 0 ? "+" : ""}${a.highlights}`);
  if (a.clarity !== 0) parts.push(`cl${a.clarity}`);
  if (a.sharpen !== 0) parts.push(`sp${a.sharpen}`);
  return parts.length > 0 ? parts.join(" ") : "";
}

export function layerSubtitle(layer: Layer): string {
  switch (layer.type) {
    case "image": {
      const maskPart = layer.mask ? `  ·  mask:${layer.mask.kind}` : "";
      const adjPart = layer.adjust ? `  ·  ${adjustSubtitle(layer)}` : "";
      return `${layer.source}  ·  ×${layer.transform.scale.toPrecision(3)}${maskPart}${adjPart}`;
    }
    case "shape": {
      const adjPart = layer.adjust ? `  ·  ${adjustSubtitle(layer)}` : "";
      return `${layer.shape}  ${layer.fill ?? ""}${layer.stroke ? ` / ${layer.stroke}` : ""}${adjPart}`;
    }
    case "gradient": {
      const adjPart = layer.adjust ? `  ·  ${adjustSubtitle(layer)}` : "";
      return `${layer.gradient.kind} gradient${adjPart}`;
    }
    case "arrow": {
      const a = layer.arrow;
      const adjPart = layer.adjust ? `  ·  ${adjustSubtitle(layer)}` : "";
      return `(${a.from_x}, ${a.from_y}) → (${a.to_x}, ${a.to_y})${adjPart}`;
    }
    case "text": {
      const t = layer.text;
      const content = t.content.replaceAll("\n", " ");
      const adjPart = layer.adjust ? `  ·  ${adjustSubtitle(layer)}` : "";
      return `${content}  ·  ${t.font} ${t.size}${adjPart}`;
    }
    default:
      return "";
  }
}

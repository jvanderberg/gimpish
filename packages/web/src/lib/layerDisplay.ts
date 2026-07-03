/** Icon + subtitle text for a layer row in the panel list. */

import type { Layer } from "../api";

const ICONS: Record<string, string> = {
  image: "🖼",
  shape: "◆",
  gradient: "▧",
  arrow: "➜",
  text: "T",
};

export function shapeIcon(layer: Layer): string {
  if (layer.type === "shape") return layer.shape === "ellipse" ? "⬭" : "▭";
  if (layer.type === "gradient") return layer.gradient.kind === "radial" ? "◎" : "▧";
  return ICONS[layer.type] ?? "?";
}

export function layerSubtitle(layer: Layer): string {
  switch (layer.type) {
    case "image": {
      const maskPart = layer.mask ? `  ·  mask:${layer.mask.kind}` : "";
      return `${layer.source}  ·  ×${layer.transform.scale.toPrecision(3)}${maskPart}`;
    }
    case "shape":
      return `${layer.shape}  ${layer.fill ?? ""}${layer.stroke ? ` / ${layer.stroke}` : ""}`;
    case "gradient":
      return `${layer.gradient.kind} gradient`;
    case "arrow": {
      const a = layer.arrow;
      return `(${a.from_x}, ${a.from_y}) → (${a.to_x}, ${a.to_y})`;
    }
    case "text": {
      const t = layer.text;
      const content = t.content.replaceAll("\\n", " ");
      return `${content}  ·  ${t.font} ${t.size}`;
    }
    default:
      return "";
  }
}

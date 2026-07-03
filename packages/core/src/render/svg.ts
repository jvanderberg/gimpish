/**
 * SVG builders for vector layer types (shape, gradient, arrow, text).
 *
 * These reproduce the SVG the Python engine generated (rasterized by librsvg in
 * both engines), which is what keeps vector output pixel-compatible.
 */

import { svgColor } from "../color.ts";
import { anchorFractions } from "../geometry.ts";
import type { ArrowSpec, Canvas, GradientSpec, ShapeLayer, TextSpec } from "../scene.ts";

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const fmt = (n: number) => n.toFixed(3);

// ---- shapes -----------------------------------------------------------------------

/**
 * Rect/ellipse with the stroke drawn fully INSIDE the bounds (the Python engine
 * inset fills by the stroke width and painted the stroke as an outer frame).
 * Paths are inset by half the stroke so the stroke spans [0..sw] from the edge.
 */
export function shapeSvg(layer: ShapeLayer): string {
  const { w, h } = layer.rect;
  const sw = layer.stroke && layer.stroke_width > 0 ? layer.stroke_width : 0;
  const parts: string[] = [];

  if (layer.shape === "ellipse") {
    const cx = w / 2;
    const cy = h / 2;
    if (layer.fill) {
      // Fill reaches mid-stroke; under an opaque stroke this matches the
      // Python fill-inside-ring geometry without an antialiasing seam.
      const { color, opacity } = svgColor(layer.fill);
      parts.push(
        `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt((w - sw) / 2)}" ry="${fmt((h - sw) / 2)}" ` +
          `fill="${color}" fill-opacity="${opacity.toFixed(4)}" />`,
      );
    }
    if (sw > 0 && layer.stroke) {
      const { color, opacity } = svgColor(layer.stroke);
      parts.push(
        `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt((w - sw) / 2)}" ry="${fmt((h - sw) / 2)}" ` +
          `fill="none" stroke="${color}" stroke-opacity="${opacity.toFixed(4)}" stroke-width="${fmt(sw)}" />`,
      );
    }
  } else {
    if (layer.fill) {
      // Exact Python geometry: fill is the rect inset by the full stroke width.
      const { color, opacity } = svgColor(layer.fill);
      parts.push(
        `<rect x="${fmt(sw)}" y="${fmt(sw)}" width="${fmt(Math.max(w - 2 * sw, 0))}" ` +
          `height="${fmt(Math.max(h - 2 * sw, 0))}" fill="${color}" fill-opacity="${opacity.toFixed(4)}" />`,
      );
    }
    if (sw > 0 && layer.stroke) {
      const { color, opacity } = svgColor(layer.stroke);
      parts.push(
        `<rect x="${fmt(sw / 2)}" y="${fmt(sw / 2)}" width="${fmt(w - sw)}" height="${fmt(h - sw)}" ` +
          `fill="none" stroke="${color}" stroke-opacity="${opacity.toFixed(4)}" stroke-width="${fmt(sw)}" />`,
      );
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" ` +
    `viewBox="0 0 ${fmt(w)} ${fmt(h)}">${parts.join("")}</svg>`
  );
}

// ---- gradients ----------------------------------------------------------------------

function stopTags(g: GradientSpec): string {
  return [...g.stops]
    .sort((a, b) => a.at - b.at)
    .map((stop) => {
      const { color, opacity } = svgColor(stop.color);
      const at = Math.max(0, Math.min(1, stop.at)) * 100;
      return `<stop offset="${at.toFixed(3)}%" stop-color="${color}" stop-opacity="${opacity.toFixed(4)}" />`;
    })
    .join("");
}

/**
 * Full-canvas gradient. Geometry matches the Python engine: radial distance is
 * normalized to the farthest corner from the center; linear spans the min..max
 * corner projection along the direction vector.
 */
export function gradientSvg(canvas: Canvas, g: GradientSpec): string {
  const W = canvas.width;
  const H = canvas.height;
  let def: string;

  if (g.kind === "radial") {
    let fx: number;
    let fy: number;
    if (g.center) {
      [fx, fy] = g.center;
    } else {
      [fx, fy] = anchorFractions(g.anchor ?? "center");
    }
    const cx = fx * W;
    const cy = fy * H;
    const corners: Array<[number, number]> = [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ];
    const r = Math.max(...corners.map(([px, py]) => Math.hypot(px - cx, py - cy)), 1e-6);
    def =
      `<radialGradient id="g" gradientUnits="userSpaceOnUse" ` +
      `cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}">${stopTags(g)}</radialGradient>`;
  } else {
    let dx: number;
    let dy: number;
    if (g.angle != null) {
      const rad = (g.angle * Math.PI) / 180;
      dx = Math.cos(rad);
      dy = Math.sin(rad);
    } else {
      const [fx, fy] = anchorFractions(g.anchor ?? "top");
      dx = 0.5 - fx;
      dy = 0.5 - fy;
      const norm = Math.hypot(dx, dy);
      if (norm === 0) {
        [dx, dy] = [0, 1]; // centered linear is meaningless -> top->bottom
      } else {
        dx /= norm;
        dy /= norm;
      }
    }
    const projections = [0, W * dx, H * dy, W * dx + H * dy];
    const pmin = Math.min(...projections);
    const pmax = Math.max(...projections);
    def =
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" ` +
      `x1="${fmt(dx * pmin)}" y1="${fmt(dy * pmin)}" x2="${fmt(dx * pmax)}" y2="${fmt(dy * pmax)}">` +
      `${stopTags(g)}</linearGradient>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${def}</defs><rect x="0" y="0" width="${W}" height="${H}" fill="url(#g)" /></svg>`
  );
}

// ---- arrows -------------------------------------------------------------------------

export function arrowSvg(canvas: Canvas, a: ArrowSpec): string {
  const { from_x: x1, from_y: y1, to_x: x2, to_y: y2 } = a;
  const { color, opacity } = svgColor(a.color);
  const width = a.width;
  const headLength = Math.min(a.head_length ?? width * 2.4, Math.hypot(x2 - x1, y2 - y1));
  const headWidth = a.head_width ?? width * 2.4;
  const outlineWidth = a.outline_width ?? Math.max(0, width * 0.35);

  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length <= 0) throw new Error("arrow needs distinct endpoints");
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  const px = -uy;
  const py = ux;
  const bx = x2 - headLength * ux;
  const by = y2 - headLength * uy;

  const points: Array<[number, number]> = [
    [x1 + width * 0.5 * px, y1 + width * 0.5 * py],
    [bx + width * 0.5 * px, by + width * 0.5 * py],
    [bx + headWidth * 0.5 * px, by + headWidth * 0.5 * py],
    [x2, y2],
    [bx - headWidth * 0.5 * px, by - headWidth * 0.5 * py],
    [bx - width * 0.5 * px, by - width * 0.5 * py],
    [x1 - width * 0.5 * px, y1 - width * 0.5 * py],
  ];
  const polygon = points.map(([px2, py2]) => `${fmt(px2)},${fmt(py2)}`).join(" ");

  let strokeAttrs = "";
  if (a.outline && outlineWidth > 0) {
    const o = svgColor(a.outline);
    strokeAttrs =
      ` stroke="${o.color}" stroke-opacity="${o.opacity.toFixed(4)}"` +
      ` stroke-width="${fmt(outlineWidth)}" stroke-linejoin="round"`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" ` +
    `viewBox="0 0 ${canvas.width} ${canvas.height}">` +
    `<polygon points="${polygon}" fill="${color}" fill-opacity="${opacity.toFixed(4)}"${strokeAttrs} />` +
    `</svg>`
  );
}

// ---- text ---------------------------------------------------------------------------

/** Full-canvas styled text. Field-for-field port of the Python SVG builder. */
export function textSvg(canvas: Canvas, t: TextSpec): string {
  if (!t.content) throw new Error("text layer has empty content");

  const anchor = { left: "start", center: "middle", right: "end" }[t.align];
  const defs: string[] = [];
  let filterAttr = "";
  let fillAttr: string;
  let fillOpacity: number;

  if (t.gradient) {
    defs.push(textGradientDef(t.gradient));
    fillAttr = "url(#text-fill)";
    fillOpacity = 1;
  } else {
    const f = svgColor(t.fill);
    fillAttr = f.color;
    fillOpacity = f.opacity;
  }

  if (t.shadow) {
    const s = svgColor(t.shadow.color);
    defs.push(
      `<filter id="text-shadow" x="-50%" y="-50%" width="200%" height="200%">` +
        `<feDropShadow dx="${fmt(t.shadow.dx)}" dy="${fmt(t.shadow.dy)}" ` +
        `stdDeviation="${fmt(t.shadow.blur)}" flood-color="${s.color}" ` +
        `flood-opacity="${s.opacity.toFixed(4)}" /></filter>`,
    );
    filterAttr = ' filter="url(#text-shadow)"';
  }

  let strokeAttrs = "";
  if (t.stroke && t.stroke_width > 0) {
    const s = svgColor(t.stroke);
    strokeAttrs =
      ` stroke="${s.color}" stroke-opacity="${s.opacity.toFixed(4)}"` +
      ` stroke-width="${fmt(t.stroke_width)}" stroke-linejoin="round"` +
      ` paint-order="stroke fill"`;
  }

  const lines = t.content.split("\n");
  const tspans = lines
    .map((line, i) => {
      const dy = i === 0 ? "0" : fmt(t.size * t.line_height);
      return `<tspan x="${fmt(t.x)}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  const transform = t.rotation
    ? ` transform="rotate(${fmt(t.rotation)} ${fmt(t.x)} ${fmt(t.y)})"`
    : "";
  const defsTag = defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" ` +
    `viewBox="0 0 ${canvas.width} ${canvas.height}">${defsTag}` +
    `<text x="${fmt(t.x)}" y="${fmt(t.y)}" font-family="${escapeXml(t.font)}" ` +
    `font-size="${fmt(t.size)}" font-weight="${escapeXml(t.weight)}" ` +
    `font-style="${escapeXml(t.style)}" text-anchor="${anchor}" dominant-baseline="hanging" ` +
    `letter-spacing="${fmt(t.letter_spacing)}" fill="${fillAttr}" ` +
    `fill-opacity="${fillOpacity.toFixed(4)}"${strokeAttrs}${filterAttr}${transform}>` +
    `${tspans}</text></svg>`
  );
}

/** Percent-space gradient def used for text fills (matches the Python builder). */
function textGradientDef(g: GradientSpec): string {
  if (g.kind === "radial") {
    return `<radialGradient id="text-fill" cx="50%" cy="50%" r="70%">${stopTags(g)}</radialGradient>`;
  }
  const rad = ((g.angle ?? 0) * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const x1 = 50 - dx * 50;
  const y1 = 50 - dy * 50;
  const x2 = 50 + dx * 50;
  const y2 = 50 + dy * 50;
  return (
    `<linearGradient id="text-fill" x1="${fmt(x1)}%" y1="${fmt(y1)}%" ` +
    `x2="${fmt(x2)}%" y2="${fmt(y2)}%">${stopTags(g)}</linearGradient>`
  );
}

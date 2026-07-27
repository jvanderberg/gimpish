import type { TextSpec } from "@gimpish/core/model";
import { canvasFontFamily } from "./vector";

export type TextContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface ArcGlyph {
  text: string;
  x: number;
  y: number;
  rotation: number;
  width: number;
  height: number;
}

export interface TextLocalBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function configureTextContext(ctx: TextContext, text: TextSpec): void {
  ctx.font =
    `${text.style} ${text.weight} ${text.stretch} ` +
    `${text.size}px ${canvasFontFamily(text.font)}`;
  ctx.letterSpacing = `${text.letter_spacing}px`;
}

/** Lay one line out around its text circle in local coordinates. */
export function arcGlyphLayout(ctx: TextContext, text: TextSpec): ArcGlyph[] {
  const arc = text.arc;
  if (!arc) return [];
  const glyphs = Array.from(text.content.replaceAll("\n", " "));
  if (glyphs.length === 0) return [];
  const widths = glyphs.map((glyph) => ctx.measureText(glyph).width);
  const spacing = text.letter_spacing;
  const total = widths.reduce((sum, width) => sum + width, 0) + spacing * (glyphs.length - 1);
  const offset = text.align === "center" ? -total / 2 : text.align === "right" ? -total : 0;
  const direction = arc.direction === "counterclockwise" ? -1 : 1;
  const anchor = (arc.angle * Math.PI) / 180;
  let cursor = 0;
  return glyphs.map((glyph, index) => {
    const width = widths[index] ?? 0;
    const distance = offset + cursor + width / 2;
    const angle = anchor + (direction * distance) / arc.radius;
    cursor += width + spacing;
    return {
      text: glyph,
      x: Math.cos(angle) * arc.radius,
      y: Math.sin(angle) * arc.radius,
      rotation: angle + direction * (Math.PI / 2),
      width,
      height: text.size * text.line_height,
    };
  });
}

function rotatedPoint(x: number, y: number, angle: number): { x: number; y: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Browser-measured local bounds used by the selection overlay. */
export function measureTextLocalBounds(ctx: TextContext, text: TextSpec): TextLocalBounds {
  configureTextContext(ctx, text);
  if (!text.arc) {
    const lines = text.content.split("\n");
    const width = Math.max(text.size * 0.25, ...lines.map((line) => ctx.measureText(line).width));
    const height = Math.max(text.size, lines.length * text.size * text.line_height);
    const left = text.align === "center" ? -width / 2 : text.align === "right" ? -width : 0;
    return { left, top: 0, width, height };
  }

  const points: Array<{ x: number; y: number }> = [];
  for (const glyph of arcGlyphLayout(ctx, text)) {
    const corners = [
      [-glyph.width / 2, -glyph.height],
      [glyph.width / 2, -glyph.height],
      [glyph.width / 2, 0],
      [-glyph.width / 2, 0],
    ] as const;
    for (const [x, y] of corners) {
      const rotated = rotatedPoint(x, y, glyph.rotation);
      points.push({ x: glyph.x + rotated.x, y: glyph.y + rotated.y });
    }
  }
  if (points.length === 0) {
    return { left: 0, top: 0, width: text.size * 0.25, height: text.size };
  }
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  return { left, top, width: right - left, height: bottom - top };
}

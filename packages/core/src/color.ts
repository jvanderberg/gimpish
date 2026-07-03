/** Color parsing/formatting for the `#rgb` / `#rrggbb` / `#rrggbbaa` scene convention. */

export type Rgba = readonly [r: number, g: number, b: number, a: number];

/** Parse '#rgb', '#rrggbb', or '#rrggbbaa' (alpha optional, defaults opaque). */
export function parseColor(text: string): Rgba {
  let s = text.trim().replace(/^#/, "");
  if (s.length === 3) s = [...s].map((ch) => ch + ch).join("");
  if (s.length === 6) s += "ff";
  if (s.length !== 8 || !/^[0-9a-fA-F]{8}$/.test(s)) {
    throw new Error(`bad color ${JSON.stringify(text)}: expected #rgb, #rrggbb, or #rrggbbaa`);
  }
  const at = (i: number) => Number.parseInt(s.slice(i, i + 2), 16);
  return [at(0), at(2), at(4), at(6)];
}

/** Format an RGBA tuple back to '#rrggbbaa'. */
export function formatColor([r, g, b, a]: Rgba): string {
  const hex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}

/** Combine a base color with an alpha fraction (0..1) -> '#rrggbbaa'. */
export function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = parseColor(color);
  return formatColor([r, g, b, Math.round(Math.max(0, Math.min(1, alpha)) * 255)]);
}

/** Split a scene color into an SVG color string and a 0..1 opacity. */
export function svgColor(color: string): { color: string; opacity: number } {
  const [r, g, b, a] = parseColor(color);
  return { color: `rgb(${r},${g},${b})`, opacity: a / 255 };
}

const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

/** CSS generic font families must be unquoted or Chromium treats them as missing fonts. */
export function canvasFontFamily(family: string): string {
  const trimmed = family.trim();
  const generic = trimmed.toLowerCase();
  if (GENERIC_FONT_FAMILIES.has(generic)) return generic;
  return `"${trimmed.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Match sharp/libvips raw-RGBA semantics before a non-normal Canvas blend. */
export function premultiplyBlendPixels(data: Uint8ClampedArray, opacity: number): void {
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = Math.round((data[offset + 3] ?? 0) * opacity);
    data[offset] = Math.round(((data[offset] ?? 0) * alpha) / 255);
    data[offset + 1] = Math.round(((data[offset + 1] ?? 0) * alpha) / 255);
    data[offset + 2] = Math.round(((data[offset + 2] ?? 0) * alpha) / 255);
    data[offset + 3] = alpha;
  }
}

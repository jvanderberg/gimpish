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
  if (GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase())) return trimmed.toLowerCase();
  return `"${trimmed.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

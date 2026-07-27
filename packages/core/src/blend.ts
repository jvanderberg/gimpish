/** Blend names supported by the canonical browser compositor. */
export const BLEND_MODES = {
  normal: true,
  multiply: true,
  screen: true,
  overlay: true,
  darken: true,
  lighten: true,
  "color-dodge": true,
  "color-burn": true,
  "hard-light": true,
  "soft-light": true,
  difference: true,
  exclusion: true,
  add: true,
} as const;

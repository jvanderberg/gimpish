/** Per-layer operations: transform, rotate, fit, move, opacity, blend, blur, shadow, adjust, visible, delete, remove-bg, mask. */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  BLEND_MODES,
  cacheDir,
  findLayer,
  imageSize,
  layerIndex,
  parseColor,
  removeBackground,
  resolveFit,
  rotatePoint,
  sceneRoot,
} from "@gimpish/core";
import type { Command } from "commander";
import {
  CliError,
  loadOrFail,
  parseIntStrict,
  parseNum,
  relToScene,
  requireAnchor,
  saved,
  sceneOption,
} from "../shared.ts";

/** Format a number like Python's '%g' (6 significant digits, no trailing zeros). */
function g(n: number): string {
  return Number(n.toPrecision(6)).toString();
}

export function transformAction(
  layerId: string,
  opts: { x?: number; y?: number; scale?: number; rotation?: number; scene: string },
): string {
  const doc = loadOrFail(opts.scene);
  const layer = findLayer(doc.scene, layerId);
  if (layer.type !== "image") throw new CliError("transform applies to image layers");
  const t = layer.transform;
  if (opts.x !== undefined) t.x = opts.x;
  if (opts.y !== undefined) t.y = opts.y;
  if (opts.scale !== undefined) t.scale = opts.scale;
  if (opts.rotation !== undefined) t.rotation = opts.rotation;
  return saved(doc, `${layerId}: x=${t.x} y=${t.y} scale=${t.scale} rotation=${t.rotation}`);
}

export function rotateAction(
  layerId: string,
  opts: { ccw?: number; cw?: number; pivot: string; scene: string },
): string {
  if ((opts.ccw === undefined) === (opts.cw === undefined)) {
    throw new CliError("provide exactly one of --ccw or --cw");
  }
  const doc = loadOrFail(opts.scene);
  const layer = findLayer(doc.scene, layerId);
  const degreesCcw = opts.ccw !== undefined ? opts.ccw : -(opts.cw as number);

  if (layer.type === "image") {
    // Image transforms store clockwise-positive rotation.
    layer.transform.rotation -= degreesCcw;
    return saved(doc, `${layerId}: rotation=${g(layer.transform.rotation)}`);
  }

  if (layer.type === "text") {
    layer.text.rotation -= degreesCcw;
    return saved(doc, `${layerId}: rotation=${g(layer.text.rotation)}`);
  }

  if (layer.type !== "arrow") {
    throw new CliError("rotate currently applies to image, text, and arrow layers");
  }

  const a = layer.arrow;
  let px: number;
  let py: number;
  if (opts.pivot === "tip") {
    px = a.to_x;
    py = a.to_y;
  } else if (opts.pivot === "tail") {
    px = a.from_x;
    py = a.from_y;
  } else if (opts.pivot === "center") {
    px = (a.from_x + a.to_x) / 2;
    py = (a.from_y + a.to_y) / 2;
  } else {
    throw new CliError("pivot must be tip|tail|center");
  }

  // Canvas coordinates are screen-like (y grows downward); rotating by -ccw
  // degrees clockwise makes positive --ccw match visual counterclockwise.
  const from = rotatePoint(a.from_x, a.from_y, px, py, -degreesCcw);
  const to = rotatePoint(a.to_x, a.to_y, px, py, -degreesCcw);
  a.from_x = from.x;
  a.from_y = from.y;
  a.to_x = to.x;
  a.to_y = to.y;
  return saved(
    doc,
    `${layerId}: rotated ${g(Math.abs(degreesCcw))} deg ` +
      `${degreesCcw >= 0 ? "ccw" : "cw"} around ${opts.pivot}`,
  );
}

export async function fitAction(
  layerId: string,
  opts: { mode: string; percent: number; anchor: string; scene: string },
): Promise<string> {
  if (opts.mode !== "fit" && opts.mode !== "fill" && opts.mode !== "cover") {
    throw new CliError("mode must be fit|fill|cover");
  }
  requireAnchor(opts.anchor);
  const doc = loadOrFail(opts.scene);
  const layer = findLayer(doc.scene, layerId);
  if (layer.type !== "image") throw new CliError("fit applies to image layers");
  const src = path.resolve(sceneRoot(doc), layer.source);
  const { width: sw, height: sh } = await imageSize(src);
  const { canvas } = doc.scene;
  const { scale, x, y } = resolveFit(
    sw,
    sh,
    canvas.width,
    canvas.height,
    opts.mode,
    opts.percent,
    opts.anchor,
  );
  layer.transform.scale = scale;
  layer.transform.x = x;
  layer.transform.y = y;
  return saved(
    doc,
    `${layerId}: ${opts.mode} ${g(opts.percent)}% -> ` +
      `scale=${Number(scale.toPrecision(4))} x=${x.toFixed(0)} y=${y.toFixed(0)}`,
  );
}

export function moveAction(
  layerId: string,
  opts: {
    up?: boolean;
    down?: boolean;
    top?: boolean;
    bottom?: boolean;
    to?: number;
    scene: string;
  },
): string {
  const doc = loadOrFail(opts.scene);
  const { layers } = doc.scene;
  const i = layerIndex(doc.scene, layerId);
  const [layer] = layers.splice(i, 1);
  if (!layer) throw new CliError(`no layer with id ${JSON.stringify(layerId)}`);
  const n = layers.length;
  let j: number;
  if (opts.to !== undefined) {
    j = Math.max(0, Math.min(n, opts.to));
  } else if (opts.top) {
    j = n;
  } else if (opts.bottom) {
    j = 0;
  } else if (opts.up) {
    j = Math.min(n, i + 1);
  } else if (opts.down) {
    j = Math.max(0, i - 1);
  } else {
    layers.splice(i, 0, layer); // restore before failing
    throw new CliError("specify --up/--down/--top/--bottom/--to");
  }
  layers.splice(j, 0, layer);
  return saved(doc, `${layerId}: moved to index ${j}`);
}

export function opacityAction(layerId: string, value: number, opts: { scene: string }): string {
  const doc = loadOrFail(opts.scene);
  const clamped = Math.max(0, Math.min(1, value));
  findLayer(doc.scene, layerId).opacity = clamped;
  return saved(doc, `${layerId}: opacity=${clamped}`);
}

export function blurAction(layerId: string, sigma: number, opts: { scene: string }): string {
  if (sigma < 0) throw new CliError("blur sigma must be >= 0");
  const doc = loadOrFail(opts.scene);
  const layer = findLayer(doc.scene, layerId);
  if (sigma === 0) {
    layer.blur = undefined;
  } else {
    layer.blur = sigma;
  }
  return saved(doc, `${layerId}: blur=${sigma === 0 ? "off" : g(sigma)}`);
}

// Starter drop shadow when a layer has none yet — soft, cast down-right.
const SHADOW_DEFAULTS = { color: "#00000080", dx: 12, dy: 16, blur: 16 } as const;

export function shadowAction(
  layerId: string,
  opts: {
    color?: string;
    dx?: number;
    dy?: number;
    blur?: number;
    none?: boolean;
    scene: string;
  },
): string {
  const doc = loadOrFail(opts.scene);
  const layer = findLayer(doc.scene, layerId);
  if (opts.none) {
    layer.shadow = undefined;
    return saved(doc, `${layerId}: shadow off`);
  }
  // Merge onto any existing shadow so tweaks don't reset the other fields;
  // fall back to the starter defaults when adding a shadow from scratch.
  const base = layer.shadow ?? SHADOW_DEFAULTS;
  const shadow = {
    color: opts.color ?? base.color,
    dx: opts.dx ?? base.dx,
    dy: opts.dy ?? base.dy,
    blur: opts.blur ?? base.blur,
  };
  if (shadow.blur < 0) throw new CliError("shadow blur must be >= 0");
  try {
    parseColor(shadow.color);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  layer.shadow = shadow;
  return saved(
    doc,
    `${layerId}: shadow color=${shadow.color} dx=${g(shadow.dx)} dy=${g(shadow.dy)} blur=${g(shadow.blur)}`,
  );
}

export function adjustAction(
  layerId: string,
  opts: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
    exposure?: number;
    warmth?: number;
    hue?: number;
    shadows?: number;
    highlights?: number;
    clarity?: number;
    sharpen?: number;
    reset?: boolean;
    enable?: boolean;
    disable?: boolean;
    scene: string;
  },
): string {
  const doc = loadOrFail(opts.scene);
  const layer = findLayer(doc.scene, layerId);

  if (opts.reset) {
    layer.adjust = undefined;
    return saved(doc, `${layerId}: adjustments cleared`);
  }

  // Toggle the bypass flag.  --disable keeps the values but skips them at
  // render time; --enable restores rendering.
  if (opts.disable) {
    layer.adjustEnabled = false;
  } else if (opts.enable) {
    layer.adjustEnabled = true;
  }

  const adjust = layer.adjust ?? {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    exposure: 0,
    warmth: 0,
    hue: 0,
    shadows: 0,
    highlights: 0,
    clarity: 0,
    sharpen: 0,
  };

  if (opts.brightness !== undefined) adjust.brightness = opts.brightness;
  if (opts.contrast !== undefined) adjust.contrast = opts.contrast;
  if (opts.saturation !== undefined) adjust.saturation = opts.saturation;
  if (opts.exposure !== undefined) adjust.exposure = opts.exposure;
  if (opts.warmth !== undefined) adjust.warmth = opts.warmth;
  if (opts.hue !== undefined) adjust.hue = opts.hue;
  if (opts.shadows !== undefined) adjust.shadows = opts.shadows;
  if (opts.highlights !== undefined) adjust.highlights = opts.highlights;
  if (opts.clarity !== undefined) adjust.clarity = opts.clarity;
  if (opts.sharpen !== undefined) adjust.sharpen = opts.sharpen;

  // Remove the adjust object entirely if all values are neutral
  if (
    adjust.brightness === 0 &&
    adjust.contrast === 0 &&
    adjust.saturation === 0 &&
    adjust.exposure === 0 &&
    adjust.warmth === 0 &&
    adjust.hue === 0 &&
    adjust.shadows === 0 &&
    adjust.highlights === 0 &&
    adjust.clarity === 0 &&
    adjust.sharpen === 0
  ) {
    layer.adjust = undefined;
    // Still persist the toggle if it was explicitly set.
    if (opts.enable || opts.disable) {
      return saved(doc, `${layerId}: adjust (no values, ${layer.adjustEnabled ? "on" : "off"})`);
    }
    return saved(doc, `${layerId}: adjustments cleared (all neutral)`);
  }

  layer.adjust = adjust;
  const parts: string[] = [];
  if (adjust.brightness !== 0) parts.push(`brightness=${g(adjust.brightness)}`);
  if (adjust.contrast !== 0) parts.push(`contrast=${g(adjust.contrast)}`);
  if (adjust.saturation !== 0) parts.push(`saturation=${g(adjust.saturation)}`);
  if (adjust.exposure !== 0) parts.push(`exposure=${g(adjust.exposure)}`);
  if (adjust.warmth !== 0) parts.push(`warmth=${g(adjust.warmth)}`);
  if (adjust.hue !== 0) parts.push(`hue=${g(adjust.hue)}`);
  if (adjust.shadows !== 0) parts.push(`shadows=${g(adjust.shadows)}`);
  if (adjust.highlights !== 0) parts.push(`highlights=${g(adjust.highlights)}`);
  if (adjust.clarity !== 0) parts.push(`clarity=${g(adjust.clarity)}`);
  if (adjust.sharpen !== 0) parts.push(`sharpen=${g(adjust.sharpen)}`);
  const suffix = layer.adjustEnabled === false ? " [off]" : "";
  return saved(doc, `${layerId}: adjust ${parts.join(" ")}${suffix}`);
}

export function blendAction(layerId: string, mode: string, opts: { scene: string }): string {
  if (!(mode in BLEND_MODES)) {
    throw new CliError(
      `unknown blend '${mode}'; choose from ${Object.keys(BLEND_MODES).join(", ")}`,
    );
  }
  const doc = loadOrFail(opts.scene);
  findLayer(doc.scene, layerId).blend = mode;
  return saved(doc, `${layerId}: blend=${mode}`);
}

export function visibleAction(layerId: string, value: string, opts: { scene: string }): string {
  const lowered = value.toLowerCase();
  if (lowered !== "true" && lowered !== "false") {
    throw new CliError(`expected true or false, got ${JSON.stringify(value)}`);
  }
  const visible = lowered === "true";
  const doc = loadOrFail(opts.scene);
  findLayer(doc.scene, layerId).visible = visible;
  return saved(doc, `${layerId}: visible=${visible}`);
}

export function deleteAction(layerId: string, opts: { scene: string }): string {
  const doc = loadOrFail(opts.scene);
  doc.scene.layers.splice(layerIndex(doc.scene, layerId), 1);
  return saved(doc, `deleted ${layerId}`);
}

export async function removeBgAction(layerId: string, opts: { scene: string }): Promise<string> {
  const doc = loadOrFail(opts.scene);
  const layer = findLayer(doc.scene, layerId);
  if (layer.type !== "image") throw new CliError("remove-bg applies to image layers");
  const src = path.resolve(sceneRoot(doc), layer.source);
  const out = path.join(cacheDir(doc), `${layer.id}_cutout.png`);
  console.log("running background removal (first run loads the model)…");
  await removeBackground(src, out);
  layer.mask = { kind: "cutout", cache: relToScene(doc, out), feather: 0, invert: false };
  return saved(doc, `${layerId}: background removed -> ${layer.mask.cache}`);
}

export function maskAction(
  layerId: string,
  opts: {
    from?: string;
    shape?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    feather: number;
    invert?: boolean;
    scene: string;
  },
): string {
  const doc = loadOrFail(opts.scene);
  const layer = findLayer(doc.scene, layerId);
  if (layer.type !== "image") throw new CliError("mask applies to image layers");
  if (opts.from) {
    if (!existsSync(opts.from)) throw new CliError(`${opts.from} not found`);
    layer.mask = {
      kind: "image",
      source: relToScene(doc, opts.from),
      feather: opts.feather,
      invert: opts.invert ?? false,
    };
  } else if (opts.shape) {
    if (opts.shape !== "rect" && opts.shape !== "ellipse") {
      throw new CliError("shape must be rect|ellipse");
    }
    if (opts.w <= 0 || opts.h <= 0) throw new CliError("shape mask needs --w and --h");
    layer.mask = {
      kind: "shape",
      shape: opts.shape,
      rect: { x: opts.x, y: opts.y, w: opts.w, h: opts.h },
      feather: opts.feather,
      invert: opts.invert ?? false,
    };
  } else {
    throw new CliError("provide --from or --shape");
  }
  return saved(doc, `${layerId}: mask=${layer.mask.kind}`);
}

export function registerLayerCommands(program: Command): void {
  const layer = program.command("layer").description("Per-layer operations.");

  sceneOption(
    layer
      .command("transform")
      .description("Set offset / scale / rotation on a layer.")
      .argument("<id>")
      .option("--x <n>", "Offset x.", parseNum)
      .option("--y <n>", "Offset y.", parseNum)
      .option("--scale <n>", "Uniform scale.", parseNum)
      .option("--rotation <deg>", "Rotation in degrees.", parseNum),
  ).action((id, opts) => console.log(transformAction(id, opts)));

  sceneOption(
    layer
      .command("rotate")
      .description("Rotate a layer relative to its current orientation.")
      .argument("<id>")
      .option("--ccw <deg>", "Rotate visually counterclockwise by degrees.", parseNum)
      .option("--cw <deg>", "Rotate visually clockwise by degrees.", parseNum)
      .option("--pivot <point>", "arrow pivot: tip|tail|center", "center"),
  ).action((id, opts) => console.log(rotateAction(id, opts)));

  sceneOption(
    layer
      .command("fit")
      .description("Scale + position a layer relative to the canvas (resolves to pixels).")
      .argument("<id>")
      .option("--mode <mode>", "fit|fill|cover", "fit")
      .option("--percent <n>", "% of canvas (fit/fill).", parseNum, 100)
      .option("--anchor <anchor>", "Placement anchor.", "center"),
  ).action(async (id, opts) => console.log(await fitAction(id, opts)));

  sceneOption(
    layer
      .command("move")
      .description("Reorder a layer (up=toward front).")
      .argument("<id>")
      .option("--up")
      .option("--down")
      .option("--top")
      .option("--bottom")
      .option("--to <index>", "Absolute index (0=bottom).", parseIntStrict),
  ).action((id, opts) => console.log(moveAction(id, opts)));

  sceneOption(
    layer
      .command("opacity")
      .description("Set layer opacity.")
      .argument("<id>")
      .argument("<value>", "0.0–1.0", parseNum),
  ).action((id, value, opts) => console.log(opacityAction(id, value, opts)));

  sceneOption(
    layer
      .command("blend")
      .description("Set layer blend mode.")
      .argument("<id>")
      .argument("<mode>", `one of: ${Object.keys(BLEND_MODES).join(", ")}`),
  ).action((id, mode, opts) => console.log(blendAction(id, mode, opts)));

  sceneOption(
    layer
      .command("blur")
      .description("Gaussian-blur a layer (sigma in canvas pixels; 0 removes).")
      .argument("<id>")
      .argument("<sigma>", "Blur sigma in canvas pixels (0 = off).", parseNum),
  ).action((id, sigma, opts) => console.log(blurAction(id, sigma, opts)));

  sceneOption(
    layer
      .command("shadow")
      .description("Drop shadow behind a layer (derived from its silhouette).")
      .argument("<id>")
      .option("--color <hex>", "Shadow color #rrggbbaa (alpha = strength).")
      .option("--dx <n>", "Horizontal offset in canvas pixels.", parseNum)
      .option("--dy <n>", "Vertical offset in canvas pixels (down positive).", parseNum)
      .option("--blur <n>", "Shadow blur sigma in canvas pixels.", parseNum)
      .option("--none", "Remove the drop shadow."),
  ).action((id, opts) => console.log(shadowAction(id, opts)));

  sceneOption(
    layer
      .command("adjust")
      .description("Per-layer tone/color adjustments (brightness, contrast, etc.).")
      .argument("<id>")
      .option("--brightness <n>", "-100..100 (additive offset).", parseNum)
      .option("--contrast <n>", "-100..100 (multiplier around midpoint).", parseNum)
      .option("--saturation <n>", "-100..100 (-100 = grayscale).", parseNum)
      .option("--exposure <n>", "-100..100 (multiplicative).", parseNum)
      .option("--warmth <n>", "-100..100 (warm/cool color shift).", parseNum)
      .option("--hue <n>", "-180..180 (hue rotation degrees).", parseNum)
      .option("--shadows <n>", "-100..100 (lift/darken shadow regions).", parseNum)
      .option("--highlights <n>", "-100..100 (recover/darken highlight regions).", parseNum)
      .option("--clarity <n>", "0..100 (CLAHE local contrast).", parseNum)
      .option("--sharpen <n>", "0..100 (unsharp mask edge contrast).", parseNum)
      .option("--reset", "Clear all adjustments on the layer.")
      .option("--enable", "Re-enable adjustments (render them).")
      .option("--disable", "Bypass adjustments at render time (values kept)."),
  ).action((id, opts) => console.log(adjustAction(id, opts)));
  sceneOption(
    layer
      .command("visible")
      .description("Show/hide a layer.")
      .argument("<id>")
      .argument("<value>", "true|false"),
  ).action((id, value, opts) => console.log(visibleAction(id, value, opts)));

  sceneOption(layer.command("delete").description("Remove a layer.").argument("<id>")).action(
    (id, opts) => console.log(deleteAction(id, opts)),
  );

  sceneOption(
    layer
      .command("remove-bg")
      .description("Remove a layer's background -> cutout mask.")
      .argument("<id>"),
  ).action(async (id, opts) => console.log(await removeBgAction(id, opts)));

  sceneOption(
    layer
      .command("mask")
      .description("Mask a layer from an image or a shape.")
      .argument("<id>")
      .option("--from <file>", "External mask image.")
      .option("--shape <shape>", "rect|ellipse")
      .option("--x <n>", "Shape x.", parseNum, 0)
      .option("--y <n>", "Shape y.", parseNum, 0)
      .option("--w <n>", "Shape width.", parseNum, 0)
      .option("--h <n>", "Shape height.", parseNum, 0)
      .option("--feather <n>", "Feather radius.", parseNum, 0)
      .option("--invert", "Invert the mask."),
  ).action((id, opts) => console.log(maskAction(id, opts)));
}

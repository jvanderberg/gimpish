/** Draw primitives as layers: rect, ellipse, arrow, text, gradient, alpha-gradient. */

import type { SceneDoc } from "@gimpish/core";
import {
  type GradientSpec,
  type Layer,
  layerIndex,
  parseColor,
  parseStops,
  saveScene,
  type TextSpec,
  uniqueId,
  withAlpha,
} from "@gimpish/core";
import type { Command } from "commander";
import { CliError, loadOrFail, parseNum, requireAnchor, sceneOption } from "../shared.ts";

/** Insert above `over` when given, otherwise append on top. */
function insertLayer(doc: SceneDoc, layer: Layer, over?: string): void {
  if (over) {
    doc.scene.layers.splice(layerIndex(doc.scene, over) + 1, 0, layer);
  } else {
    doc.scene.layers.push(layer);
  }
}

interface ShapeOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  strokeWidth: number;
  name?: string;
  scene: string;
}

function addShape(shape: "rect" | "ellipse", opts: ShapeOpts): string {
  const doc = loadOrFail(opts.scene);
  if (opts.fill) parseColor(opts.fill);
  if (opts.stroke) parseColor(opts.stroke);
  const base = opts.name ?? shape;
  const layer: Layer = {
    id: uniqueId(doc.scene, base),
    type: "shape",
    name: base,
    opacity: 1,
    blend: "normal",
    visible: true,
    shape,
    rect: { x: opts.x, y: opts.y, w: opts.w, h: opts.h },
    fill: opts.fill ?? null,
    stroke: opts.stroke ?? null,
    stroke_width: opts.strokeWidth,
  };
  doc.scene.layers.push(layer);
  saveScene(doc);
  return `added ${shape} layer '${layer.id}'`;
}

export function rectAction(opts: ShapeOpts): string {
  return addShape("rect", opts);
}

export function ellipseAction(opts: ShapeOpts): string {
  return addShape("ellipse", opts);
}

export function arrowAction(opts: {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: string;
  width: number;
  headLength?: number;
  headWidth?: number;
  outline?: string;
  outlineWidth: number;
  over?: string;
  name?: string;
  scene: string;
}): string {
  const doc = loadOrFail(opts.scene);
  parseColor(opts.color);
  if (opts.outline) parseColor(opts.outline);
  const base = opts.name ?? "arrow";
  const layer: Layer = {
    id: uniqueId(doc.scene, base),
    type: "arrow",
    name: base,
    opacity: 1,
    blend: "normal",
    visible: true,
    arrow: {
      from_x: opts.fromX,
      from_y: opts.fromY,
      to_x: opts.toX,
      to_y: opts.toY,
      color: opts.color,
      width: opts.width,
      head_length: opts.headLength ?? opts.width * 2.4,
      head_width: opts.headWidth ?? opts.width * 2.4,
      outline: opts.outline ?? null,
      outline_width: opts.outlineWidth,
    },
  };
  insertLayer(doc, layer, opts.over);
  saveScene(doc);
  return `added arrow layer '${layer.id}'`;
}

export function textAction(
  content: string,
  opts: {
    x: number;
    y: number;
    font: string;
    size: number;
    weight: string;
    style: string;
    align: string;
    fill: string;
    gradientStops?: string;
    gradientKind: string;
    gradientAngle: number;
    stroke?: string;
    strokeWidth: number;
    shadowColor?: string;
    shadowAngle: number;
    shadowDistance: number;
    shadowBlur: number;
    shadowDx?: number;
    shadowDy?: number;
    lineHeight: number;
    letterSpacing: number;
    rotation: number;
    over?: string;
    name?: string;
    scene: string;
  },
): string {
  if (opts.align !== "left" && opts.align !== "center" && opts.align !== "right") {
    throw new CliError("align must be left|center|right");
  }
  if (opts.style !== "normal" && opts.style !== "italic" && opts.style !== "oblique") {
    throw new CliError("style must be normal|italic|oblique");
  }
  if (opts.gradientKind !== "linear" && opts.gradientKind !== "radial") {
    throw new CliError("gradient kind must be linear|radial");
  }
  parseColor(opts.fill);
  if (opts.stroke) parseColor(opts.stroke);

  const text: TextSpec = {
    content,
    x: opts.x,
    y: opts.y,
    font: opts.font,
    size: opts.size,
    weight: opts.weight,
    style: opts.style,
    align: opts.align,
    fill: opts.fill,
    stroke: opts.stroke ?? null,
    stroke_width: opts.strokeWidth,
    line_height: opts.lineHeight,
    letter_spacing: opts.letterSpacing,
    rotation: opts.rotation,
  };
  if (opts.gradientStops) {
    text.gradient = {
      kind: opts.gradientKind,
      angle: opts.gradientAngle,
      stops: parseStops(opts.gradientStops),
    };
  }
  if (opts.shadowColor) {
    parseColor(opts.shadowColor);
    let dx: number;
    let dy: number;
    if (opts.shadowDx === undefined || opts.shadowDy === undefined) {
      const radians = (opts.shadowAngle * Math.PI) / 180;
      dx = Math.cos(radians) * opts.shadowDistance;
      dy = Math.sin(radians) * opts.shadowDistance;
    } else {
      dx = opts.shadowDx;
      dy = opts.shadowDy;
    }
    text.shadow = { color: opts.shadowColor, dx, dy, blur: opts.shadowBlur };
  }

  const doc = loadOrFail(opts.scene);
  const base = opts.name ?? "text";
  const layer: Layer = {
    id: uniqueId(doc.scene, base),
    type: "text",
    name: base,
    opacity: 1,
    blend: "normal",
    visible: true,
    text,
  };
  insertLayer(doc, layer, opts.over);
  saveScene(doc);
  return `added text layer '${layer.id}'`;
}

function addGradient(opts: {
  kind: string;
  anchor?: string;
  angle?: number;
  stops: GradientSpec["stops"];
  over?: string;
  name?: string;
  scene: string;
}): string {
  if (opts.kind !== "linear" && opts.kind !== "radial") {
    throw new CliError("kind must be linear|radial");
  }
  if (opts.anchor) requireAnchor(opts.anchor);
  const doc = loadOrFail(opts.scene);
  const gradient: GradientSpec = { kind: opts.kind, stops: opts.stops };
  if (opts.angle !== undefined) gradient.angle = opts.angle;
  if (opts.anchor) gradient.anchor = opts.anchor;
  if (!opts.anchor && opts.angle === undefined) {
    gradient.anchor = opts.kind === "radial" ? "center" : "top";
  }
  const base = opts.name ?? "gradient";
  const layer: Layer = {
    id: uniqueId(doc.scene, base),
    type: "gradient",
    name: base,
    opacity: 1,
    blend: "normal",
    visible: true,
    gradient,
  };
  insertLayer(doc, layer, opts.over);
  saveScene(doc);
  return `added gradient layer '${layer.id}'`;
}

export function gradientAction(opts: {
  kind: string;
  anchor?: string;
  angle?: number;
  stops: string;
  over?: string;
  name?: string;
  scene: string;
}): string {
  return addGradient({ ...opts, stops: parseStops(opts.stops) });
}

export function alphaGradientAction(opts: {
  color: string;
  from: number;
  to: number;
  kind: string;
  anchor?: string;
  angle?: number;
  over?: string;
  name?: string;
  scene: string;
}): string {
  const stops = [
    { at: 0, color: withAlpha(opts.color, opts.from) },
    { at: 1, color: withAlpha(opts.color, opts.to) },
  ];
  return addGradient({ ...opts, stops, name: opts.name ?? "alpha-gradient" });
}

export function registerDrawCommands(program: Command): void {
  const draw = program.command("draw").description("Draw primitives as layers.");

  const shapeOptions = (cmd: Command): Command =>
    cmd
      .requiredOption("--x <n>", "Left edge x.", parseNum)
      .requiredOption("--y <n>", "Top edge y.", parseNum)
      .requiredOption("--w <n>", "Width.", parseNum)
      .requiredOption("--h <n>", "Height.", parseNum)
      .option("--fill <color>", "Fill color.")
      .option("--stroke <color>", "Stroke color.")
      .option("--stroke-width <n>", "Stroke width.", parseNum, 0)
      .option("--name <name>", "Layer name/id hint.");

  sceneOption(
    shapeOptions(draw.command("rect").description("Draw a filled/stroked rectangle.")),
  ).action((opts) => console.log(rectAction(opts)));

  sceneOption(
    shapeOptions(draw.command("ellipse").description("Draw a filled/stroked ellipse.")),
  ).action((opts) => console.log(ellipseAction(opts)));

  sceneOption(
    draw
      .command("arrow")
      .description("Draw an arrow from tail to tip as a vector-rendered scene layer.")
      .requiredOption("--from-x <n>", "Arrow tail x in canvas pixels.", parseNum)
      .requiredOption("--from-y <n>", "Arrow tail y in canvas pixels.", parseNum)
      .requiredOption("--to-x <n>", "Arrow tip x in canvas pixels.", parseNum)
      .requiredOption("--to-y <n>", "Arrow tip y in canvas pixels.", parseNum)
      .option("--color <color>", "Arrow fill color.", "#e61e2dff")
      .option("--width <n>", "Shaft width in canvas pixels.", parseNum, 24)
      .option("--head-length <n>", "Arrowhead length.", parseNum)
      .option("--head-width <n>", "Arrowhead width.", parseNum)
      .option("--outline <color>", "Outline color.", "#ffffffff")
      .option("--outline-width <n>", "Outline thickness.", parseNum, 8)
      .option("--over <id>", "Insert above this layer id.")
      .option("--name <name>", "Layer name/id hint."),
  ).action((opts) => console.log(arrowAction(opts)));

  sceneOption(
    draw
      .command("text")
      .description("Draw styled text as a vector-rendered scene layer.")
      .argument("<content>", "Text content. Use literal newlines for multiple lines.")
      .requiredOption("--x <n>", "Text anchor x in canvas pixels.", parseNum)
      .requiredOption("--y <n>", "Text top y in canvas pixels.", parseNum)
      .option("--font <family>", "CSS/Pango font family.", "sans-serif")
      .option("--size <n>", "Font size in canvas pixels.", parseNum, 64)
      .option("--weight <weight>", "Font weight, e.g. 400, 700, bold.", "700")
      .option("--style <style>", "normal|italic|oblique", "normal")
      .option("--align <align>", "left|center|right", "left")
      .option("--fill <color>", "Text fill color.", "#ffffffff")
      .option("--gradient-stops <stops>", "'0:#fff, 1:#888'")
      .option("--gradient-kind <kind>", "linear|radial", "linear")
      .option("--gradient-angle <deg>", "Linear gradient angle.", parseNum, 0)
      .option("--stroke <color>", "Text stroke color.")
      .option("--stroke-width <n>", "Text stroke width.", parseNum, 0)
      .option("--shadow-color <color>", "Drop shadow color.")
      .option("--shadow-angle <deg>", "Shadow direction, 0=right, 90=down.", parseNum, 45)
      .option("--shadow-distance <n>", "Shadow offset distance.", parseNum, 8)
      .option("--shadow-blur <n>", "Shadow blur/std deviation.", parseNum, 6)
      .option("--shadow-dx <n>", "Explicit shadow x offset.", parseNum)
      .option("--shadow-dy <n>", "Explicit shadow y offset.", parseNum)
      .option("--line-height <n>", "Line height multiplier.", parseNum, 1.15)
      .option("--letter-spacing <n>", "Letter spacing.", parseNum, 0)
      .option("--rotation <deg>", "Rotation in degrees.", parseNum, 0)
      .option("--over <id>", "Insert above this layer id.")
      .option("--name <name>", "Layer name/id hint."),
  ).action((content, opts) => console.log(textAction(content, opts)));

  sceneOption(
    draw
      .command("gradient")
      .description("Add a linear/radial gradient as a layer (explicit per-stop colors).")
      .option("--kind <kind>", "linear|radial", "linear")
      .option("--anchor <anchor>", "Direction/center anchor.")
      .option("--angle <deg>", "Linear angle (deg).", parseNum)
      .requiredOption("--stops <stops>", "'0:#000000ff, 1:#00000000'")
      .option("--over <id>", "Insert above this layer id.")
      .option("--name <name>", "Layer name/id hint."),
  ).action((opts) => console.log(gradientAction(opts)));

  sceneOption(
    draw
      .command("alpha-gradient")
      .description("Add a one-color gradient that ramps only its alpha (color -> transparent).")
      .option("--color <color>", "Single gradient color (#rrggbb).", "#000000")
      .option("--from <n>", "Start opacity 0..1 (at the anchor).", parseNum, 1.0)
      .option("--to <n>", "End opacity 0..1 (far edge).", parseNum, 0.0)
      .option("--kind <kind>", "linear|radial", "linear")
      .option("--anchor <anchor>", "Direction/center anchor.")
      .option("--angle <deg>", "Linear angle (deg).", parseNum)
      .option("--over <id>", "Insert above this layer id.")
      .option("--name <name>", "Layer name/id hint."),
  ).action((opts) => console.log(alphaGradientAction(opts)));
}

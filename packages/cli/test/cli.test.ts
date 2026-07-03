/** CLI action tests — exercise the action functions directly on temp scenes. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseScene, type Scene } from "@gimpish/core";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  alphaGradientAction,
  arrowAction,
  ellipseAction,
  gradientAction,
  rectAction,
  textAction,
} from "../src/commands/draw.ts";
import {
  blendAction,
  deleteAction,
  fitAction,
  maskAction,
  moveAction,
  opacityAction,
  rotateAction,
  transformAction,
  visibleAction,
} from "../src/commands/layer.ts";
import { exportAction, previewAction, renderAction } from "../src/commands/output.ts";
import { addAction, initAction, layersAction } from "../src/commands/scene.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gimpish-cli-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function readScene(scenePath: string): Scene {
  return parseScene(JSON.parse(readFileSync(scenePath, "utf8")));
}

/** New 80x60 scene in a fresh temp dir; returns the scene path. */
function newScene(width = 80, height = 60, bg = "transparent"): string {
  const scene = path.join(tempDir(), "scene.json");
  initAction(undefined, { width, height, bg, scene });
  return scene;
}

async function writePng(file: string, width: number, height: number): Promise<void> {
  await sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 60, b: 60, alpha: 1 } },
  })
    .png()
    .toFile(file);
}

describe("init", () => {
  it("creates a valid scene", () => {
    const scene = path.join(tempDir(), "scene.json");
    const msg = initAction(undefined, { width: 80, height: 60, bg: "transparent", scene });
    expect(msg).toBe(`created ${scene} (80x60, bg=transparent)`);
    const s = readScene(scene);
    expect(s.canvas).toMatchObject({ width: 80, height: 60, background: "transparent" });
    expect(s.layers).toEqual([]);
  });

  it("refuses to overwrite without --force", () => {
    const scene = newScene();
    expect(() =>
      initAction(undefined, { width: 10, height: 10, bg: "transparent", scene }),
    ).toThrow(/already exists/);
    initAction(undefined, { width: 10, height: 10, bg: "transparent", scene, force: true });
    expect(readScene(scene).canvas.width).toBe(10);
  });

  it("rejects a bad background color", () => {
    const scene = path.join(tempDir(), "scene.json");
    expect(() => initAction(undefined, { width: 10, height: 10, bg: "nope", scene })).toThrow(
      /bad color/,
    );
  });

  it("requires an explicit canvas size", () => {
    const scene = path.join(tempDir(), "scene.json");
    expect(() => initAction(undefined, { bg: "transparent", scene })).toThrow(
      /canvas size is required/,
    );
    expect(() => initAction(undefined, { width: 80, bg: "transparent", scene })).toThrow(
      /canvas size is required/,
    );
  });

  it("scaffolds a document directory when given one", () => {
    const dir = path.join(tempDir(), "card");
    const msg = initAction(dir, { width: 80, height: 60, bg: "transparent", scene: "scene.json" });
    const scene = path.join(dir, "scene.json");
    expect(msg).toBe(`created ${scene} (80x60, bg=transparent)`);
    expect(readScene(scene).canvas.width).toBe(80);
  });

  it("rejects a directory combined with --scene", () => {
    const dir = path.join(tempDir(), "card");
    expect(() =>
      initAction(dir, { width: 80, height: 60, bg: "transparent", scene: "other.json" }),
    ).toThrow(/not both/);
  });
});

describe("add", () => {
  it("appends an image layer with a scene-relative source", async () => {
    const scene = newScene();
    const img = path.join(path.dirname(scene), "sprite.png");
    await writePng(img, 8, 8);
    const msg = addAction(img, { scene });
    expect(msg).toBe(`added image layer 'sprite' (${img}) → ${scene}`);
    const s = readScene(scene);
    expect(s.layers).toHaveLength(1);
    const layer = s.layers[0];
    if (layer?.type !== "image") throw new Error("expected image layer");
    expect(layer.source).toBe("sprite.png");
    expect(layer.transform).toEqual({ x: 0, y: 0, scale: 1, rotation: 0 });
  });

  it("fails for a missing file", () => {
    const scene = newScene();
    expect(() => addAction(path.join(path.dirname(scene), "nope.png"), { scene })).toThrow(
      /not found/,
    );
  });
});

describe("layers", () => {
  it("lists layer ids, top first", () => {
    const scene = newScene();
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "backdrop" });
    ellipseAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "blob" });
    const out = layersAction({ scene });
    const lines = out.split("\n");
    expect(lines[0]).toContain(`scene ${scene}`);
    expect(lines[0]).toContain("canvas 80x60");
    expect(lines[1]).toContain("blob");
    expect(lines[2]).toContain("backdrop");
  });

  it("prints (no layers) for an empty scene", () => {
    const out = layersAction({ scene: newScene() });
    expect(out).toContain("canvas 80x60");
    expect(out).toContain("(no layers)");
  });

  it("accepts a document directory for --scene", () => {
    const scene = newScene();
    const out = layersAction({ scene: path.dirname(scene) });
    expect(out).toContain("canvas 80x60");
  });
});

describe("draw", () => {
  it("rect appends a shape layer with the given fields", () => {
    const scene = newScene();
    const msg = rectAction({
      x: 5,
      y: 6,
      w: 30,
      h: 20,
      fill: "#ff0000",
      stroke: "#ffffffff",
      strokeWidth: 2,
      scene,
    });
    expect(msg).toBe(`added rect layer 'rect' → ${scene}`);
    const layer = readScene(scene).layers[0];
    if (layer?.type !== "shape") throw new Error("expected shape layer");
    expect(layer.shape).toBe("rect");
    expect(layer.rect).toMatchObject({ x: 5, y: 6, w: 30, h: 20 });
    expect(layer.fill).toBe("#ff0000");
    expect(layer.stroke).toBe("#ffffffff");
    expect(layer.stroke_width).toBe(2);
  });

  it("rejects invalid colors", () => {
    const scene = newScene();
    expect(() =>
      rectAction({ x: 0, y: 0, w: 1, h: 1, fill: "red", strokeWidth: 0, scene }),
    ).toThrow(/bad color/);
  });

  it("arrow defaults head size to width * 2.4", () => {
    const scene = newScene();
    const msg = arrowAction({
      fromX: 10,
      fromY: 50,
      toX: 70,
      toY: 10,
      color: "#e61e2dff",
      width: 10,
      outline: "#ffffffff",
      outlineWidth: 8,
      scene,
    });
    expect(msg).toBe(`added arrow layer 'arrow' → ${scene}`);
    const layer = readScene(scene).layers[0];
    if (layer?.type !== "arrow") throw new Error("expected arrow layer");
    expect(layer.arrow).toMatchObject({
      from_x: 10,
      from_y: 50,
      to_x: 70,
      to_y: 10,
      width: 10,
      head_length: 24,
      head_width: 24,
      outline: "#ffffffff",
      outline_width: 8,
    });
  });

  it("text stores styling and computes shadow dx/dy from angle/distance", () => {
    const scene = newScene();
    const msg = textAction("Hello\nWorld", {
      x: 10,
      y: 20,
      font: "sans-serif",
      size: 12,
      weight: "700",
      style: "italic",
      align: "center",
      fill: "#112233ff",
      gradientKind: "linear",
      gradientAngle: 0,
      strokeWidth: 0,
      shadowColor: "#00000080",
      shadowAngle: 90,
      shadowDistance: 10,
      shadowBlur: 3,
      lineHeight: 1.2,
      letterSpacing: 1,
      rotation: 5,
      scene,
    });
    expect(msg).toBe(`added text layer 'text' → ${scene}`);
    const layer = readScene(scene).layers[0];
    if (layer?.type !== "text") throw new Error("expected text layer");
    expect(layer.text).toMatchObject({
      content: "Hello\nWorld",
      x: 10,
      y: 20,
      size: 12,
      style: "italic",
      align: "center",
      fill: "#112233ff",
      line_height: 1.2,
      letter_spacing: 1,
      rotation: 5,
    });
    const shadow = layer.text.shadow;
    if (!shadow) throw new Error("expected shadow");
    expect(shadow.dx).toBeCloseTo(0, 8); // cos(90deg) * 10
    expect(shadow.dy).toBeCloseTo(10, 8); // sin(90deg) * 10
    expect(shadow.blur).toBe(3);
  });

  it("text honors explicit shadow dx/dy and gradient stops", () => {
    const scene = newScene();
    textAction("Hi", {
      x: 0,
      y: 0,
      font: "sans-serif",
      size: 12,
      weight: "400",
      style: "normal",
      align: "left",
      fill: "#ffffffff",
      gradientStops: "0:#ffffffff, 1:#888888ff",
      gradientKind: "radial",
      gradientAngle: 0,
      strokeWidth: 0,
      shadowColor: "#000000ff",
      shadowAngle: 45,
      shadowDistance: 8,
      shadowBlur: 6,
      shadowDx: -3,
      shadowDy: 4,
      lineHeight: 1.15,
      letterSpacing: 0,
      rotation: 0,
      scene,
    });
    const layer = readScene(scene).layers[0];
    if (layer?.type !== "text") throw new Error("expected text layer");
    expect(layer.text.shadow).toMatchObject({ dx: -3, dy: 4 });
    expect(layer.text.gradient).toMatchObject({
      kind: "radial",
      stops: [
        { at: 0, color: "#ffffffff" },
        { at: 1, color: "#888888ff" },
      ],
    });
  });

  it("text validates align and style", () => {
    const scene = newScene();
    const base = {
      x: 0,
      y: 0,
      font: "sans-serif",
      size: 12,
      weight: "400",
      fill: "#ffffffff",
      gradientKind: "linear",
      gradientAngle: 0,
      strokeWidth: 0,
      shadowAngle: 45,
      shadowDistance: 8,
      shadowBlur: 6,
      lineHeight: 1.15,
      letterSpacing: 0,
      rotation: 0,
      scene,
    };
    expect(() => textAction("x", { ...base, style: "normal", align: "middle" })).toThrow(
      /align must be/,
    );
    expect(() => textAction("x", { ...base, style: "slanted", align: "left" })).toThrow(
      /style must be/,
    );
  });

  it("gradient stores parsed stops and defaults the anchor when no angle", () => {
    const scene = newScene();
    const msg = gradientAction({ kind: "linear", stops: "0:#000000ff, 1:#00000000", scene });
    expect(msg).toBe(`added gradient layer 'gradient' → ${scene}`);
    const layer = readScene(scene).layers[0];
    if (layer?.type !== "gradient") throw new Error("expected gradient layer");
    expect(layer.gradient.anchor).toBe("top");
    expect(layer.gradient.stops).toEqual([
      { at: 0, color: "#000000ff" },
      { at: 1, color: "#00000000" },
    ]);

    gradientAction({ kind: "radial", stops: "0:#fff, 1:#000", scene, name: "glow" });
    const radial = readScene(scene).layers[1];
    if (radial?.type !== "gradient") throw new Error("expected gradient layer");
    expect(radial.gradient.anchor).toBe("center");

    gradientAction({ kind: "linear", angle: 45, stops: "0:#fff, 1:#000", scene, name: "slant" });
    const angled = readScene(scene).layers[2];
    if (angled?.type !== "gradient") throw new Error("expected gradient layer");
    expect(angled.gradient.angle).toBe(45);
    expect(angled.gradient.anchor).toBeUndefined();
  });

  it("alpha-gradient builds two stops from color + from/to alphas", () => {
    const scene = newScene();
    const msg = alphaGradientAction({ color: "#102030", from: 1, to: 0, kind: "linear", scene });
    expect(msg).toBe(`added gradient layer 'alpha-gradient' → ${scene}`);
    const layer = readScene(scene).layers[0];
    if (layer?.type !== "gradient") throw new Error("expected gradient layer");
    expect(layer.gradient.stops).toEqual([
      { at: 0, color: "#102030ff" },
      { at: 1, color: "#10203000" },
    ]);
  });

  it("--over inserts the new layer just above the target", () => {
    const scene = newScene();
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "a" });
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "b" });
    arrowAction({
      fromX: 0,
      fromY: 0,
      toX: 10,
      toY: 10,
      color: "#e61e2dff",
      width: 4,
      outlineWidth: 0,
      over: "a",
      scene,
    });
    expect(readScene(scene).layers.map((l) => l.id)).toEqual(["a", "arrow", "b"]);
  });
});

describe("layer ops", () => {
  it("opacity clamps to 0..1", () => {
    const scene = newScene();
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "a" });
    opacityAction("a", 1.5, { scene });
    expect(readScene(scene).layers[0]?.opacity).toBe(1);
    opacityAction("a", -0.5, { scene });
    expect(readScene(scene).layers[0]?.opacity).toBe(0);
    opacityAction("a", 0.25, { scene });
    expect(readScene(scene).layers[0]?.opacity).toBe(0.25);
  });

  it("blend validates the mode", () => {
    const scene = newScene();
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "a" });
    expect(() => blendAction("a", "melt", { scene })).toThrow(/unknown blend/);
    blendAction("a", "multiply", { scene });
    expect(readScene(scene).layers[0]?.blend).toBe("multiply");
  });

  it("visible parses true/false and rejects other values", () => {
    const scene = newScene();
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "a" });
    visibleAction("a", "false", { scene });
    expect(readScene(scene).layers[0]?.visible).toBe(false);
    visibleAction("a", "true", { scene });
    expect(readScene(scene).layers[0]?.visible).toBe(true);
    expect(() => visibleAction("a", "maybe", { scene })).toThrow(/true or false/);
  });

  it("delete removes the layer", () => {
    const scene = newScene();
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "a" });
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "b" });
    expect(deleteAction("a", { scene })).toBe(`deleted a → ${scene}`);
    expect(readScene(scene).layers.map((l) => l.id)).toEqual(["b"]);
  });

  it("move reorders with up/down/top/bottom/to", () => {
    const scene = newScene();
    for (const name of ["a", "b", "c"]) {
      rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name });
    }
    const order = () => readScene(scene).layers.map((l) => l.id);

    expect(moveAction("a", { up: true, scene })).toBe(`a: moved to index 1 → ${scene}`);
    expect(order()).toEqual(["b", "a", "c"]);
    moveAction("c", { down: true, scene });
    expect(order()).toEqual(["b", "c", "a"]);
    moveAction("b", { top: true, scene });
    expect(order()).toEqual(["c", "a", "b"]);
    moveAction("b", { bottom: true, scene });
    expect(order()).toEqual(["b", "c", "a"]);
    moveAction("a", { to: 1, scene });
    expect(order()).toEqual(["b", "a", "c"]);
    moveAction("b", { to: 99, scene }); // clamps
    expect(order()).toEqual(["a", "c", "b"]);
    expect(() => moveAction("a", { scene })).toThrow(/specify/);
  });

  it("transform sets image transform fields and rejects other types", async () => {
    const scene = newScene();
    const dir = path.dirname(scene);
    rectAction({ x: 0, y: 0, w: 10, h: 10, strokeWidth: 0, scene, name: "box" });
    await writePng(path.join(dir, "img.png"), 8, 8);
    addAction(path.join(dir, "img.png"), { scene });
    transformAction("img", { x: 3, y: -4, scale: 2, rotation: 15, scene });
    const layer = readScene(scene).layers[1];
    if (layer?.type !== "image") throw new Error("expected image layer");
    expect(layer.transform).toEqual({ x: 3, y: -4, scale: 2, rotation: 15 });
    expect(() => transformAction("box", { x: 1, scene })).toThrow(/image layers/);
  });

  it("fit computes scale and anchored placement from the natural size", async () => {
    const scene = newScene(); // 80x60 canvas
    const dir = path.dirname(scene);
    await writePng(path.join(dir, "img.png"), 20, 10);
    addAction(path.join(dir, "img.png"), { scene });
    const msg = await fitAction("img", { mode: "fit", percent: 100, anchor: "center", scene });
    // scale = min(80/20, 60/10) = 4 -> 80x40, centered vertically
    expect(msg).toBe(`img: fit 100% -> scale=4 x=0 y=10 → ${scene}`);
    const layer = readScene(scene).layers[0];
    if (layer?.type !== "image") throw new Error("expected image layer");
    expect(layer.transform).toMatchObject({ scale: 4, x: 0, y: 10 });

    await fitAction("img", { mode: "fill", percent: 100, anchor: "center", scene });
    const filled = readScene(scene).layers[0];
    if (filled?.type !== "image") throw new Error("expected image layer");
    // fill: scale = max(80/20, 60/10) = 6 -> 120x60, x centers overflow
    expect(filled.transform).toMatchObject({ scale: 6, x: -20, y: 0 });
  });

  it("rotate adjusts image rotation clockwise-positive", async () => {
    const scene = newScene();
    const dir = path.dirname(scene);
    await writePng(path.join(dir, "img.png"), 8, 8);
    addAction(path.join(dir, "img.png"), { scene });
    expect(rotateAction("img", { ccw: 30, pivot: "center", scene })).toBe(
      `img: rotation=-30 → ${scene}`,
    );
    rotateAction("img", { cw: 10, pivot: "center", scene });
    const layer = readScene(scene).layers[0];
    if (layer?.type !== "image") throw new Error("expected image layer");
    expect(layer.transform.rotation).toBe(-20);
  });

  it("rotate on an arrow rotates its endpoints about the pivot", () => {
    const scene = newScene();
    arrowAction({
      fromX: 0,
      fromY: 0,
      toX: 10,
      toY: 0,
      color: "#e61e2dff",
      width: 2,
      outlineWidth: 0,
      scene,
    });
    // 90deg visual ccw about the tail: tip (10,0) -> (0,-10) in y-down coords.
    const msg = rotateAction("arrow", { ccw: 90, pivot: "tail", scene });
    expect(msg).toBe(`arrow: rotated 90 deg ccw around tail → ${scene}`);
    let layer = readScene(scene).layers[0];
    if (layer?.type !== "arrow") throw new Error("expected arrow layer");
    expect(layer.arrow.from_x).toBeCloseTo(0, 6);
    expect(layer.arrow.from_y).toBeCloseTo(0, 6);
    expect(layer.arrow.to_x).toBeCloseTo(0, 6);
    expect(layer.arrow.to_y).toBeCloseTo(-10, 6);

    // 90deg cw about the center brings it back horizontal: (0,-5)..(0,5) -> ...
    rotateAction("arrow", { cw: 90, pivot: "center", scene });
    layer = readScene(scene).layers[0];
    if (layer?.type !== "arrow") throw new Error("expected arrow layer");
    expect(layer.arrow.from_x).toBeCloseTo(-5, 6);
    expect(layer.arrow.from_y).toBeCloseTo(-5, 6);
    expect(layer.arrow.to_x).toBeCloseTo(5, 6);
    expect(layer.arrow.to_y).toBeCloseTo(-5, 6);
  });

  it("rotate requires exactly one of --ccw/--cw and a known pivot", () => {
    const scene = newScene();
    arrowAction({
      fromX: 0,
      fromY: 0,
      toX: 10,
      toY: 0,
      color: "#e61e2dff",
      width: 2,
      outlineWidth: 0,
      scene,
    });
    expect(() => rotateAction("arrow", { pivot: "center", scene })).toThrow(/exactly one/);
    expect(() => rotateAction("arrow", { ccw: 10, cw: 10, pivot: "center", scene })).toThrow(
      /exactly one/,
    );
    expect(() => rotateAction("arrow", { ccw: 10, pivot: "middle", scene })).toThrow(
      /tip\|tail\|center/,
    );
  });

  it("mask sets shape and image masks on image layers", async () => {
    const scene = newScene();
    const dir = path.dirname(scene);
    await writePng(path.join(dir, "img.png"), 8, 8);
    await writePng(path.join(dir, "band.png"), 8, 8);
    addAction(path.join(dir, "img.png"), { scene });

    maskAction("img", { shape: "ellipse", x: 1, y: 2, w: 6, h: 4, feather: 2, scene });
    let layer = readScene(scene).layers[0];
    if (layer?.type !== "image") throw new Error("expected image layer");
    expect(layer.mask).toMatchObject({
      kind: "shape",
      shape: "ellipse",
      rect: { x: 1, y: 2, w: 6, h: 4 },
      feather: 2,
      invert: false,
    });

    maskAction("img", {
      from: path.join(dir, "band.png"),
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      feather: 0,
      invert: true,
      scene,
    });
    layer = readScene(scene).layers[0];
    if (layer?.type !== "image") throw new Error("expected image layer");
    expect(layer.mask).toMatchObject({ kind: "image", source: "band.png", invert: true });

    expect(() =>
      maskAction("img", { shape: "rect", x: 0, y: 0, w: 0, h: 0, feather: 0, scene }),
    ).toThrow(/--w and --h/);
    expect(() => maskAction("img", { x: 0, y: 0, w: 0, h: 0, feather: 0, scene })).toThrow(
      /--from or --shape/,
    );
  });
});

describe("output", () => {
  function shapeScene(): string {
    const scene = newScene(80, 60, "#1b2432ff");
    rectAction({ x: 10, y: 10, w: 40, h: 30, fill: "#ff3366ff", strokeWidth: 0, scene });
    return scene;
  }

  it("preview writes a downscaled png and reports its size", async () => {
    const scene = shapeScene();
    const out = path.join(path.dirname(scene), "preview.png");
    const msg = await previewAction({ out, max: 40, scene });
    expect(msg).toBe(`preview -> ${out} (40x30) [scene: ${scene}]`);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([40, 30]);
  });

  it("render writes the full-size (or resized) image", async () => {
    const scene = shapeScene();
    const out = path.join(path.dirname(scene), "out.png");
    expect(await renderAction({ out, scene })).toBe(`rendered -> ${out} [scene: ${scene}]`);
    let meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([80, 60]);

    await renderAction({ out, width: 40, scene });
    meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([40, 30]);
  });

  it("export writes a jpg without alpha", async () => {
    const scene = shapeScene();
    const out = path.join(path.dirname(scene), "final.jpg");
    expect(await exportAction({ out, quality: 80, scene })).toBe(
      `exported -> ${out} [scene: ${scene}]`,
    );
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false);
    expect([meta.width, meta.height]).toEqual([80, 60]);
  });

  it("renders a golden fixture scene at canvas size", async () => {
    const fixture = path.resolve(
      import.meta.dirname,
      "../../../tests/fixtures/scenes/vector.scene.json",
    );
    const out = path.join(tempDir(), "vector.png");
    await renderAction({ out, scene: fixture });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([640, 420]);
  });
});

describe("demo", () => {
  it("scaffolds an example scene and renders its preview", async () => {
    const dir = path.join(tempDir(), "demo");
    const { demoAction } = await import("../src/commands/demo.ts");
    const msg = await demoAction(dir);
    expect(msg).toContain("demo ready");
    const scene = readScene(path.join(dir, "scene.json"));
    expect(scene.layers.length).toBeGreaterThanOrEqual(5);
    expect(scene.layers.map((l) => l.id)).toContain("headline");
    const meta = await sharp(path.join(dir, "preview.png")).metadata();
    expect(meta.width).toBe(1024);
    await expect(demoAction(dir)).rejects.toThrow(/already exists/);
  });
});

describe("doctor", () => {
  it("reports a healthy environment here", async () => {
    const { doctorAction } = await import("../src/commands/doctor.ts");
    const { report, healthy } = await doctorAction();
    expect(healthy).toBe(true);
    expect(report).toContain("node");
    expect(report).toContain("sharp");
  });
});

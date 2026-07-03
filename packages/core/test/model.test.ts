import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ArrowLayer, GradientLayer, Scene } from "../src/index.ts";
import {
  applyMove,
  applyRotate,
  applyScale,
  findLayer,
  formatColor,
  layerBox,
  layerIndex,
  loadScene,
  parseColor,
  parseScene,
  parseStops,
  resolveFit,
  saveScene,
  uniqueId,
  withAlpha,
} from "../src/index.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../../../tests/fixtures");

describe("color", () => {
  it("parses #rgb, #rrggbb, #rrggbbaa", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255, 255]);
    expect(parseColor("#3068b0")).toEqual([48, 104, 176, 255]);
    expect(parseColor("#3068b080")).toEqual([48, 104, 176, 128]);
    expect(parseColor("  #000000ff ")).toEqual([0, 0, 0, 255]);
  });

  it("rejects malformed colors", () => {
    for (const bad of ["", "#12345", "#gggggg", "red", "#12345678aa"]) {
      expect(() => parseColor(bad)).toThrow(/bad color/);
    }
  });

  it("round-trips through formatColor and applies alpha", () => {
    expect(formatColor(parseColor("#a1b2c3d4"))).toBe("#a1b2c3d4");
    expect(withAlpha("#000000", 0.5)).toBe("#00000080");
    expect(withAlpha("#ffffff", 2)).toBe("#ffffffff");
  });
});

describe("geometry", () => {
  it("resolveFit fit mode contains within percent box", () => {
    const { scale, x, y } = resolveFit(320, 240, 1600, 900, "fit", 75);
    expect(scale).toBeCloseTo(Math.min((1600 * 0.75) / 320, (900 * 0.75) / 240));
    expect(x).toBeCloseTo((1600 - 320 * scale) / 2);
    expect(y).toBeCloseTo((900 - 240 * scale) / 2);
  });

  it("resolveFit fill covers the canvas and honors anchors", () => {
    const { scale, x, y } = resolveFit(320, 240, 1600, 900, "fill", 100, "top-left");
    expect(scale).toBeCloseTo(Math.max(1600 / 320, 900 / 240));
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });

  it("rejects unknown fit modes", () => {
    expect(() => resolveFit(1, 1, 1, 1, "stretch" as never)).toThrow(/unknown fit mode/);
  });

  it("parses gradient stops sorted by position", () => {
    expect(parseStops("1:#00000000, 0:#000000ff")).toEqual([
      { at: 0, color: "#000000ff" },
      { at: 1, color: "#00000000" },
    ]);
    expect(() => parseStops("0:#fff")).toThrow(/at least 2/);
    expect(() => parseStops("nope")).toThrow(/bad gradient stop/);
  });
});

describe("scene document", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gimpish-test-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("loads every Python-written fixture scene unchanged", () => {
    for (const name of ["blends", "transforms", "gradients", "vector", "text"]) {
      const doc = loadScene(path.join(FIXTURES, "scenes", `${name}.scene.json`));
      expect(doc.scene.layers.length).toBeGreaterThan(0);
    }
  });

  it("round-trips load -> save -> load", () => {
    const doc = loadScene(path.join(FIXTURES, "scenes", "transforms.scene.json"));
    const copy = path.join(tmp, "roundtrip.scene.json");
    saveScene(doc, copy);
    const again = loadScene(copy);
    expect(again.scene).toEqual(doc.scene);
  });

  it("rejects invalid scenes with a useful error", () => {
    expect(() => parseScene({ canvas: { width: 0, height: 100 }, layers: [] })).toThrow();
    expect(() =>
      parseScene({
        canvas: { width: 10, height: 10 },
        layers: [{ id: "x", type: "mystery" }],
      }),
    ).toThrow();
  });

  it("finds layers and allocates unique ids", () => {
    const doc = loadScene(path.join(FIXTURES, "scenes", "vector.scene.json"));
    expect(findLayer(doc.scene, "arrow-plain").type).toBe("arrow");
    expect(layerIndex(doc.scene, "bg")).toBe(0);
    expect(() => findLayer(doc.scene, "nope")).toThrow(/no layer/);
    expect(uniqueId(doc.scene, "bg")).toBe("bg2");
    expect(uniqueId(doc.scene, "New Layer!")).toBe("new-layer");
  });
});

function testScene(): Scene {
  return parseScene({
    canvas: { width: 1000, height: 500 },
    layers: [
      {
        id: "img",
        type: "image",
        source: "x.png",
        transform: { x: 100, y: 50, scale: 2, rotation: 0 },
      },
      { id: "box", type: "shape", shape: "rect", rect: { x: 10, y: 20, w: 100, h: 60 } },
      {
        id: "label",
        type: "text",
        text: { content: "hi", x: 500, y: 100, size: 40 },
      },
      {
        id: "arr",
        type: "arrow",
        arrow: { from_x: 0, from_y: 0, to_x: 100, to_y: 0, width: 10, outline_width: 2 },
      },
      {
        id: "rad",
        type: "gradient",
        gradient: {
          kind: "radial",
          anchor: "bottom-right",
          stops: [
            { at: 0, color: "#000000ff" },
            { at: 1, color: "#00000000" },
          ],
        },
      },
      {
        id: "lin",
        type: "gradient",
        gradient: {
          kind: "linear",
          angle: 30,
          stops: [
            { at: 0, color: "#000000ff" },
            { at: 1, color: "#00000000" },
          ],
        },
      },
    ],
  });
}

describe("editor", () => {
  it("computes boxes with per-type capabilities", () => {
    const scene = testScene();
    const img = layerBox(scene, findLayer(scene, "img"), {
      naturalSize: { width: 30, height: 40 },
    });
    expect(img).toMatchObject({ cx: 130, cy: 90, w: 60, h: 80, move: true, scale: true });

    const rad = layerBox(scene, findLayer(scene, "rad"));
    expect(rad).toMatchObject({ cx: 1000, cy: 500, rotate: false, scale: false });

    const lin = layerBox(scene, findLayer(scene, "lin"));
    expect(lin).toMatchObject({ rotation: 30, move: false });

    const arr = layerBox(scene, findLayer(scene, "arr"));
    expect(arr).toMatchObject({ pivotx: 50, pivoty: 0 });
  });

  it("applyMove translates each type in its own storage", () => {
    const scene = testScene();
    const img = findLayer(scene, "img");
    applyMove(scene, img, 10, -5);
    expect(img.type === "image" && img.transform).toMatchObject({ x: 110, y: 45 });

    const rad = findLayer(scene, "rad") as GradientLayer;
    applyMove(scene, rad, -200, -100);
    expect(rad.gradient.center?.[0]).toBeCloseTo(0.8);
    expect(rad.gradient.center?.[1]).toBeCloseTo(0.8);
  });

  it("applyRotate rotates arrows about their midpoint", () => {
    const scene = testScene();
    const arr = findLayer(scene, "arr") as ArrowLayer;
    applyRotate(scene, arr, 90);
    expect(arr.arrow.from_x).toBeCloseTo(50);
    expect(arr.arrow.from_y).toBeCloseTo(-50);
    expect(arr.arrow.to_x).toBeCloseTo(50);
    expect(arr.arrow.to_y).toBeCloseTo(50);
  });

  it("applyScale holds each type's pivot fixed", () => {
    const scene = testScene();
    const img = findLayer(scene, "img");
    applyScale(img, 2, { width: 30, height: 40 });
    // center was (130, 90); scale 2 -> 4, size 120x160, so x = 130-60, y = 90-80
    expect(img.type === "image" && img.transform).toMatchObject({ x: 70, y: 10, scale: 4 });

    const arr = findLayer(scene, "arr") as ArrowLayer;
    applyScale(arr, 2);
    expect(arr.arrow.from_x).toBeCloseTo(-50);
    expect(arr.arrow.to_x).toBeCloseTo(150);
    expect(arr.arrow.width).toBeCloseTo(20);

    const label = findLayer(scene, "label");
    applyScale(label, 0.5);
    expect(label.type === "text" && label.text.size).toBe(20);
  });

  it("clamps extreme scale factors", () => {
    const scene = testScene();
    const box = findLayer(scene, "box");
    applyScale(box, 0.00001);
    expect(box.type === "shape" && box.rect.w).toBeCloseTo(2);
  });

  it("move/rotate/scale round-trip back to the original", () => {
    const scene = testScene();
    const arr = findLayer(scene, "arr") as ArrowLayer;
    const orig = structuredClone(arr.arrow);
    applyMove(scene, arr, 33, -7);
    applyRotate(scene, arr, 41);
    applyScale(arr, 1.7);
    applyScale(arr, 1 / 1.7);
    applyRotate(scene, arr, -41);
    applyMove(scene, arr, -33, 7);
    for (const key of ["from_x", "from_y", "to_x", "to_y", "width"] as const) {
      expect(arr.arrow[key]).toBeCloseTo(orig[key], 6);
    }
  });
});

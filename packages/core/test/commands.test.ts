import { describe, expect, it } from "vitest";
import { applyDocumentCommand, parseScene } from "../src/model.ts";

describe("applyDocumentCommand", () => {
  it("clones the scene and returns concrete before/after values", () => {
    const scene = parseScene({
      canvas: { width: 800, height: 450 },
      layers: [
        {
          id: "title",
          type: "text",
          text: { content: "Hello", x: 400, y: 100, rotation: 0 },
        },
      ],
    });

    const result = applyDocumentCommand(scene, {
      kind: "transform-layer",
      layerId: "title",
      dx: 25,
      dy: -10,
      drot: 7,
    });

    expect(scene.layers[0]?.type === "text" && scene.layers[0].text.x).toBe(400);
    const changed = result.scene.layers[0];
    expect(changed?.type).toBe("text");
    if (changed?.type !== "text") throw new Error("expected text layer");
    expect(changed.text).toMatchObject({ x: 425, y: 90, rotation: 7 });
    expect(result.receipt.operations[0]).toMatchObject({
      kind: "transform-layer",
      layerId: "title",
      before: { text: { x: 400, y: 100, rotation: 0 } },
      after: { text: { x: 425, y: 90, rotation: 7 } },
    });
  });

  it("scales an image around its center when natural size is supplied", () => {
    const scene = parseScene({
      canvas: { width: 800, height: 450 },
      layers: [
        {
          id: "photo",
          type: "image",
          source: "assets/photo.png",
          transform: { x: 100, y: 50, scale: 1, rotation: 0 },
        },
      ],
    });
    const result = applyDocumentCommand(scene, {
      kind: "transform-layer",
      layerId: "photo",
      scale: 2,
      naturalSize: { width: 200, height: 100 },
    });
    const changed = result.scene.layers[0];
    if (changed?.type !== "image") throw new Error("expected image layer");
    expect(changed.transform).toEqual({ x: 0, y: 0, scale: 2, rotation: 0 });
  });

  it("adds, edits, and removes circular layout on native text", () => {
    const scene = parseScene({
      canvas: { width: 800, height: 450 },
      layers: [{ id: "title", type: "text", text: { content: "Hello", x: 400, y: 300 } }],
    });
    const arced = applyDocumentCommand(scene, {
      kind: "edit-text",
      layerId: "title",
      patch: { content: "PALISADES", arc: { radius: 300 } },
    }).scene;
    const changed = arced.layers[0];
    if (changed?.type !== "text") throw new Error("expected text layer");
    expect(changed.text).toMatchObject({
      content: "PALISADES",
      arc: { radius: 300, angle: -90, direction: "clockwise" },
    });

    const straight = applyDocumentCommand(arced, {
      kind: "edit-text",
      layerId: "title",
      patch: { arc: null },
    }).scene.layers[0];
    expect(straight?.type === "text" && straight.text.arc).toBeUndefined();
  });

  it("fits an image and resolves semantic layer edits", () => {
    const scene = parseScene({
      canvas: { width: 800, height: 400 },
      layers: [{ id: "photo", type: "image", source: "photo.png" }],
    });
    const fitted = applyDocumentCommand(scene, {
      kind: "fit-layer",
      layerId: "photo",
      mode: "fit",
      percent: 50,
      anchor: "bottom-right",
      naturalSize: { width: 400, height: 200 },
    }).scene;
    const edited = applyDocumentCommand(fitted, {
      kind: "edit-layer",
      layerId: "photo",
      opacity: 0.6,
      shadow: { blur: 8 },
      adjust: { warmth: 25 },
    }).scene;
    const changed = edited.layers[0];
    if (changed?.type !== "image") throw new Error("expected image layer");
    expect(changed.transform).toEqual({ x: 400, y: 200, scale: 1, rotation: 0 });
    expect(changed).toMatchObject({
      opacity: 0.6,
      shadow: { color: "#00000080", dx: 12, dy: 16, blur: 8 },
      adjust: { warmth: 25, exposure: 0, sharpen: 0 },
    });
  });

  it("reorders a layer by paint index", () => {
    const scene = parseScene({
      canvas: { width: 100, height: 100 },
      layers: [
        { id: "back", type: "shape", shape: "rect", rect: { w: 1, h: 1 } },
        { id: "middle", type: "shape", shape: "rect", rect: { w: 1, h: 1 } },
        { id: "front", type: "shape", shape: "rect", rect: { w: 1, h: 1 } },
      ],
    });
    const result = applyDocumentCommand(scene, {
      kind: "reorder-layer",
      layerId: "back",
      index: 2,
    });
    expect(result.scene.layers.map((layer) => layer.id)).toEqual(["middle", "front", "back"]);
  });
});

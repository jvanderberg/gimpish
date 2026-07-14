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
});

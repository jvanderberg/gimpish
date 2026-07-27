import { parseScene } from "@gimpish/core/model";
import { describe, expect, it } from "vitest";
import { applyVisibilityOverrides } from "../src/hooks/useLiveScene";

describe("served editor visibility overrides", () => {
  it("keeps the latest local toggle authoritative across a stale server refresh", () => {
    const visible = parseScene({
      canvas: { width: 100, height: 100 },
      layers: [{ id: "trail", type: "shape", shape: "rect", rect: { w: 10, h: 10 } }],
    });
    const staleHidden = parseScene({
      canvas: { width: 100, height: 100 },
      layers: [
        {
          id: "trail",
          type: "shape",
          shape: "rect",
          rect: { w: 10, h: 10 },
          visible: false,
        },
      ],
    });

    expect(applyVisibilityOverrides(visible, { trail: false })?.layers[0]?.visible).toBe(false);
    expect(applyVisibilityOverrides(staleHidden, { trail: true })?.layers[0]?.visible).toBe(true);
  });

  it("leaves unrelated layers and unoverridden scenes unchanged", () => {
    const scene = parseScene({
      canvas: { width: 100, height: 100 },
      layers: [
        { id: "trail", type: "shape", shape: "rect", rect: { w: 10, h: 10 } },
        {
          id: "sky",
          type: "shape",
          shape: "rect",
          rect: { w: 10, h: 10 },
          visible: false,
        },
      ],
    });

    expect(applyVisibilityOverrides(scene, {})).toBe(scene);
    const result = applyVisibilityOverrides(scene, { trail: false });
    expect(result?.layers.map((layer) => layer.visible)).toEqual([false, false]);
    expect(result?.layers[1]).toBe(scene.layers[1]);
  });
});

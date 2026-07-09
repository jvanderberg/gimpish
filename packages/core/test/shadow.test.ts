import { describe, expect, it } from "vitest";
import type { SceneDoc, Shadow } from "../src/index.ts";
import { parseScene, renderScene } from "../src/index.ts";

function rectScene(shadow?: Partial<Shadow>): SceneDoc {
  return {
    path: "/tmp/shadow-test/scene.json", // no file IO happens for shape-only scenes
    scene: parseScene({
      canvas: { width: 120, height: 80 },
      layers: [
        {
          id: "box",
          type: "shape",
          shape: "rect",
          rect: { x: 40, y: 20, w: 40, h: 40 },
          fill: "#ff0000ff",
          ...(shadow ? { shadow } : {}),
        },
      ],
    }),
  };
}

function px(
  img: { data: Buffer; width: number },
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [
    img.data[i] as number,
    img.data[i + 1] as number,
    img.data[i + 2] as number,
    img.data[i + 3] as number,
  ];
}

describe("layer shadow", () => {
  it("casts a dark silhouette offset from the layer", async () => {
    // Hard shadow (no blur) offset down-right; the rect occupies x[40,80) y[20,60).
    const out = await renderScene(rectScene({ color: "#000000ff", dx: 20, dy: 12, blur: 0 }));

    // Just past the rect's right edge, within the shadow's offset band: opaque black.
    const [r, g, b, a] = px(out, 90, 40);
    expect(a).toBeGreaterThan(250);
    expect(r).toBeLessThan(20);
    expect(g).toBeLessThan(20);
    expect(b).toBeLessThan(20);

    // The rect itself still paints red on top of its own shadow.
    expect(px(out, 60, 40)[0]).toBeGreaterThan(250);
  });

  it("color alpha sets shadow strength", async () => {
    const out = await renderScene(rectScene({ color: "#00000080", dx: 20, dy: 0, blur: 0 }));
    const a = px(out, 90, 40)[3];
    expect(a).toBeGreaterThan(100);
    expect(a).toBeLessThan(160); // ~0x80, not fully opaque
  });

  it("blur spreads the shadow past the offset silhouette", async () => {
    const hard = await renderScene(rectScene({ color: "#000000ff", dx: 0, dy: 0, blur: 0 }));
    const soft = await renderScene(rectScene({ color: "#000000ff", dx: 0, dy: 0, blur: 6 }));
    // A pixel just outside the rect: no shadow when hard, softly filled when blurred.
    expect(px(hard, 36, 40)[3]).toBe(0);
    expect(px(soft, 36, 40)[3]).toBeGreaterThan(0);
  });

  it("a fully transparent shadow color renders nothing", async () => {
    const none = await renderScene(rectScene());
    const clear = await renderScene(rectScene({ color: "#00000000", dx: 20, dy: 20, blur: 8 }));
    expect(Buffer.compare(none.data, clear.data)).toBe(0);
  });
});

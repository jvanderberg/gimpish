import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../src/index.ts";
import { parseScene, renderScene } from "../src/index.ts";

function rectScene(blur?: number): SceneDoc {
  return {
    path: "/tmp/blur-test/scene.json", // no file IO happens for shape-only scenes
    scene: parseScene({
      canvas: { width: 120, height: 80 },
      layers: [
        {
          id: "box",
          type: "shape",
          shape: "rect",
          rect: { x: 40, y: 20, w: 40, h: 40 },
          fill: "#ff0000ff",
          ...(blur ? { blur } : {}),
        },
      ],
    }),
  };
}

function alphaAt(img: { data: Buffer; width: number }, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3] as number;
}

describe("layer blur", () => {
  it("softens edges and spreads past the layer bounds", async () => {
    const sharp = await renderScene(rectScene());
    const blurred = await renderScene(rectScene(4));

    // Just outside the rect: hard render is fully transparent, blur spreads out.
    expect(alphaAt(sharp, 34, 40)).toBe(0);
    expect(alphaAt(blurred, 34, 40)).toBeGreaterThan(0);

    // Center stays essentially opaque; the exact edge is now soft.
    expect(alphaAt(blurred, 60, 40)).toBeGreaterThan(250);
    const edge = alphaAt(blurred, 40, 40);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);

    // Color must not halo toward the transparent surround (premultiplied pass):
    // a visible edge pixel stays red, not darkened by transparent-black bleed.
    const i = (40 * blurred.width + 44) * 4;
    expect(blurred.data[i]).toBeGreaterThan(200); // R
    expect(blurred.data[i + 1]).toBeLessThan(30); // G
  });

  it("blur=0 / absent renders identically", async () => {
    const a = await renderScene(rectScene());
    const b = await renderScene(rectScene(0));
    expect(Buffer.compare(a.data, b.data)).toBe(0);
  });
});

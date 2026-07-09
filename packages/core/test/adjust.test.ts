import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../src/index.ts";
import { isAdjustNeutral, parseScene, renderScene } from "../src/index.ts";

function rectScene(adjust?: Record<string, number>): SceneDoc {
  return {
    path: "/tmp/adjust-test/scene.json",
    scene: parseScene({
      canvas: { width: 120, height: 80 },
      layers: [
        {
          id: "box",
          type: "shape",
          shape: "rect",
          rect: { x: 20, y: 20, w: 80, h: 40 },
          fill: "#808080ff",
          ...(adjust ? { adjust } : {}),
        },
      ],
    }),
  };
}

function pixelAt(
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

describe("isAdjustNeutral", () => {
  it("returns true for undefined", () => {
    expect(isAdjustNeutral(undefined)).toBe(true);
  });

  it("returns true for all-zero adjust", () => {
    expect(
      isAdjustNeutral({
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
      }),
    ).toBe(true);
  });

  it("returns false for any non-zero field", () => {
    expect(
      isAdjustNeutral({
        brightness: 0,
        contrast: 0,
        saturation: 0,
        exposure: 0,
        warmth: 0,
        hue: 0,
        shadows: 0,
        highlights: 0,
        clarity: 0,
        sharpen: 5,
      }),
    ).toBe(false);
  });
});

describe("layer adjust rendering", () => {
  it("neutral adjust produces identical output to no adjust", async () => {
    const plain = await renderScene(rectScene());
    const neutral = await renderScene(
      rectScene({
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
      }),
    );
    expect(Buffer.compare(plain.data, neutral.data)).toBe(0);
  });

  it("brightness shifts pixel values additively", async () => {
    const plain = await renderScene(rectScene());
    const bright = await renderScene(rectScene({ brightness: 50 }));
    const [r0] = pixelAt(plain, 60, 40);
    const [r1] = pixelAt(bright, 60, 40);
    // 128 + 50% * 255 = 128 + 127.5 = 255 (clamped)
    expect(r1).toBeGreaterThan(r0);
    expect(r1).toBe(255);
  });

  it("negative brightness darkens", async () => {
    const dark = await renderScene(rectScene({ brightness: -50 }));
    const [r] = pixelAt(dark, 60, 40);
    // 128 - 127.5 = 0.5 -> 0 or 1
    expect(r).toBeLessThanOrEqual(1);
  });

  it("contrast pushes off-midpoint pixels away from the pivot", async () => {
    // Two halves: left dark (32), right bright (224).  Both are equidistant
    // from the 128 pivot, so contrast=50 (multiplier 1.5, bias -64) should
    // push them further from 128 by the same magnitude.
    const scene = {
      path: "/tmp/adjust-test/scene.json",
      scene: parseScene({
        canvas: { width: 120, height: 80 },
        layers: [
          {
            id: "dark",
            type: "shape",
            shape: "rect",
            rect: { x: 0, y: 0, w: 60, h: 80 },
            fill: "#202020ff",
          },
          {
            id: "bright",
            type: "shape",
            shape: "rect",
            rect: { x: 60, y: 0, w: 60, h: 80 },
            fill: "#e0e0e0ff",
          },
        ],
      }),
    };
    const plain = await renderScene(scene);
    const high = await renderScene({
      path: scene.path,
      scene: {
        ...scene.scene,
        layers: scene.scene.layers.map((l) => ({
          ...l,
          adjust: {
            brightness: 0,
            contrast: 50,
            saturation: 0,
            exposure: 0,
            warmth: 0,
            hue: 0,
            shadows: 0,
            highlights: 0,
            clarity: 0,
            sharpen: 0,
          },
        })),
      },
    });
    const [dark0] = pixelAt(plain, 30, 40);
    const [dark1] = pixelAt(high, 30, 40);
    const [bright0] = pixelAt(plain, 90, 40);
    const [bright1] = pixelAt(high, 90, 40);
    // dark pixel gets darker, bright pixel gets brighter
    expect(dark1).toBeLessThan(dark0);
    expect(bright1).toBeGreaterThan(bright0);
  });

  it("saturation -100 produces grayscale", async () => {
    const scene = {
      path: "/tmp/adjust-test/scene.json",
      scene: parseScene({
        canvas: { width: 120, height: 80 },
        layers: [
          {
            id: "box",
            type: "shape",
            shape: "rect",
            rect: { x: 20, y: 20, w: 80, h: 40 },
            fill: "#ff8800ff",
            adjust: { saturation: -100 },
          },
        ],
      }),
    };
    const result = await renderScene(scene);
    const [r, g, b] = pixelAt(result, 60, 40);
    // grayscale should have R==G==B (approximately, via luminance)
    expect(Math.abs(r - g)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(2);
  });

  it("exposure multiplies brightness", async () => {
    const plain = await renderScene(rectScene());
    const exposed = await renderScene(rectScene({ exposure: 50 }));
    const [r0] = pixelAt(plain, 60, 40);
    const [r1] = pixelAt(exposed, 60, 40);
    // exposure=50 => brightness multiplier = 1.5 => 128*1.5 ≈ 192
    expect(r1).toBeGreaterThan(r0);
    expect(r1).toBeGreaterThanOrEqual(190);
  });

  it("warmth shifts R up and B down", async () => {
    const warm = await renderScene(rectScene({ warmth: 100 }));
    const [r, , b] = pixelAt(warm, 60, 40);
    // warmth=100 => rGain=1.2, bGain=0.8
    // 128*1.2 ≈ 153-154, 128*0.8 ≈ 102
    expect(r).toBeGreaterThan(b);
    expect(r).toBeGreaterThanOrEqual(152);
    expect(b).toBeLessThanOrEqual(103);
  });

  it("shadows lifts dark regions more than midtones", async () => {
    const scene = {
      path: "/tmp/adjust-test/scene.json",
      scene: parseScene({
        canvas: { width: 120, height: 80 },
        layers: [
          {
            id: "dark",
            type: "shape",
            shape: "rect",
            rect: { x: 0, y: 0, w: 60, h: 80 },
            fill: "#101010ff",
          },
          {
            id: "mid",
            type: "shape",
            shape: "rect",
            rect: { x: 60, y: 0, w: 60, h: 80 },
            fill: "#808080ff",
          },
        ],
      }),
    };
    const plain = await renderScene(scene);
    const lifted = await renderScene({
      path: scene.path,
      scene: {
        ...scene.scene,
        layers: scene.scene.layers.map((l) => ({
          ...l,
          adjust: {
            brightness: 0,
            contrast: 0,
            saturation: 0,
            exposure: 0,
            warmth: 0,
            hue: 0,
            shadows: 50,
            highlights: 0,
            clarity: 0,
            sharpen: 0,
          },
        })),
      },
    });

    const darkDelta = pixelAt(lifted, 30, 40)[0] - pixelAt(plain, 30, 40)[0];
    const midDelta = pixelAt(lifted, 90, 40)[0] - pixelAt(plain, 90, 40)[0];
    // Shadow lift should affect dark pixels more than midtone pixels
    expect(darkDelta).toBeGreaterThan(0);
    expect(darkDelta).toBeGreaterThan(midDelta);
  });

  it("highlights affects bright regions more than dark regions", async () => {
    const scene = {
      path: "/tmp/adjust-test/scene.json",
      scene: parseScene({
        canvas: { width: 120, height: 80 },
        layers: [
          {
            id: "bright",
            type: "shape",
            shape: "rect",
            rect: { x: 0, y: 0, w: 60, h: 80 },
            fill: "#f0f0f0ff",
          },
          {
            id: "dark",
            type: "shape",
            shape: "rect",
            rect: { x: 60, y: 0, w: 60, h: 80 },
            fill: "#101010ff",
          },
        ],
      }),
    };
    const plain = await renderScene(scene);
    const darkened = await renderScene({
      path: scene.path,
      scene: {
        ...scene.scene,
        layers: scene.scene.layers.map((l) => ({
          ...l,
          adjust: {
            brightness: 0,
            contrast: 0,
            saturation: 0,
            exposure: 0,
            warmth: 0,
            hue: 0,
            shadows: 0,
            highlights: -50,
            clarity: 0,
            sharpen: 0,
          },
        })),
      },
    });

    const brightDelta = pixelAt(plain, 30, 40)[0] - pixelAt(darkened, 30, 40)[0];
    const darkDelta = pixelAt(plain, 90, 40)[0] - pixelAt(darkened, 90, 40)[0];
    // Highlight reduction should affect bright pixels more than dark pixels
    expect(brightDelta).toBeGreaterThan(0);
    expect(brightDelta).toBeGreaterThan(darkDelta);
  });

  it("sharpen modifies edge pixels while leaving the interior untouched", async () => {
    // A rotated rect has anti-aliased edges that the unsharp mask can act on
    // (an axis-aligned rect produces perfectly aliased edges, whose sharpening
    // artifacts live only in transparent pixels that compositing overwrites).
    const scene = {
      path: "/tmp/adjust-test/scene.json",
      scene: parseScene({
        canvas: { width: 120, height: 80, background: "#404040ff" },
        layers: [
          {
            id: "box",
            type: "shape",
            shape: "rect",
            rect: { x: 20, y: 10, w: 80, h: 60, rotation: 15 },
            fill: "#c0c0c0ff",
          },
        ],
      }),
    };
    const plain = await renderScene(scene);
    const sharpened = await renderScene({
      path: scene.path,
      scene: {
        ...scene.scene,
        layers: scene.scene.layers.map((l) => ({
          ...l,
          adjust: {
            brightness: 0,
            contrast: 0,
            saturation: 0,
            exposure: 0,
            warmth: 0,
            hue: 0,
            shadows: 0,
            highlights: 0,
            clarity: 0,
            sharpen: 80,
          },
        })),
      },
    });
    // Sharpening is not a no-op: the buffer should differ at the anti-aliased
    // edges of the rotated rect.
    expect(Buffer.compare(plain.data, sharpened.data)).not.toBe(0);
    // Interior pixel (uniform region) should be barely affected.
    const [r2] = pixelAt(plain, 60, 40);
    const [r3] = pixelAt(sharpened, 60, 40);
    expect(Math.abs(r3 - r2)).toBeLessThanOrEqual(2);
  });

  it("adjustEnabled=false bypasses adjustments (render matches no-adjust)", async () => {
    // Two scenes: one with brightness=50 + adjustEnabled=false, one with no
    // adjust at all.  The bypassed scene should be pixel-identical to the
    // plain scene, proving the adjust values are kept but not applied.
    const scene = {
      path: "/tmp/adjust-test/scene.json",
      scene: parseScene({
        canvas: { width: 120, height: 80 },
        layers: [
          {
            id: "box",
            type: "shape",
            shape: "rect",
            rect: { x: 20, y: 20, w: 80, h: 40 },
            fill: "#808080ff",
          },
        ],
      }),
    };
    const plain = await renderScene(scene);
    const bypassed = await renderScene({
      path: scene.path,
      scene: {
        ...scene.scene,
        layers: scene.scene.layers.map((l) => ({
          ...l,
          adjust: {
            brightness: 50,
            contrast: 0,
            saturation: 0,
            exposure: 0,
            warmth: 0,
            hue: 0,
            shadows: 0,
            highlights: 0,
            clarity: 0,
            sharpen: 0,
          },
          adjustEnabled: false,
        })),
      },
    });
    // The bypassed render should match the plain render exactly.
    expect(Buffer.compare(plain.data, bypassed.data)).toBe(0);
    // But the adjust values are still present in the parsed scene.
    const parsed = parseScene(
      JSON.parse(
        JSON.stringify({
          ...scene.scene,
          layers: scene.scene.layers.map((l) => ({
            ...l,
            adjust: {
              brightness: 50,
              contrast: 0,
              saturation: 0,
              exposure: 0,
              warmth: 0,
              hue: 0,
              shadows: 0,
              highlights: 0,
              clarity: 0,
              sharpen: 0,
            },
            adjustEnabled: false,
          })),
        }),
      ),
    );
    expect(parsed.layers[0]?.adjust?.brightness).toBe(50);
    expect(parsed.layers[0]?.adjustEnabled).toBe(false);
  });
});

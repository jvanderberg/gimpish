import { describe, expect, it } from "vitest";
import { normalizeU2NetInput, saliencyToAlpha, U2NET_INPUT_SIZE } from "../src/electron/background";

const PIXELS = U2NET_INPUT_SIZE * U2NET_INPUT_SIZE;

describe("browser U²-Net preprocessing", () => {
  it("normalizes RGBA pixels into channel-first model input", () => {
    const rgba = new Uint8ClampedArray(PIXELS * 4);
    rgba.set([255, 128, 0, 17]);
    const input = normalizeU2NetInput(rgba);
    expect(input).toHaveLength(PIXELS * 3);
    expect(input[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(input[PIXELS]).toBeCloseTo((128 / 255 - 0.456) / 0.224, 5);
    expect(input[PIXELS * 2]).toBeCloseTo((0 - 0.406) / 0.225, 5);
  });

  it("min-max normalizes saliency with rembg truncation semantics", () => {
    const mask = new Float32Array(PIXELS);
    mask[0] = -1;
    mask[1] = 0;
    mask[2] = 3;
    const alpha = saliencyToAlpha(mask);
    expect(alpha[0]).toBe(0);
    expect(alpha[1]).toBe(63);
    expect(alpha[2]).toBe(255);
  });

  it("rejects malformed tensor buffers", () => {
    expect(() => normalizeU2NetInput(new Uint8ClampedArray(4))).toThrow(/320×320/);
    expect(() => saliencyToAlpha(new Float32Array(4))).toThrow(/undersized/);
  });
});

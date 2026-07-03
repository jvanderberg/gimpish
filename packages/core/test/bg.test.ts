/**
 * Background-removal smoke test. Skips when the u2net model isn't cached locally
 * (~/.u2net/u2net.onnx, ~176 MB) so a fresh checkout doesn't trigger a download.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { removeBackground } from "../src/bg.ts";

const MODEL = path.join(homedir(), ".u2net", "u2net.onnx");
const FIXTURES = path.resolve(import.meta.dirname, "../../../tests/fixtures");

describe.skipIf(!existsSync(MODEL))("removeBackground (u2net)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gimpish-bg-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("produces an RGBA cutout with a real alpha matte", async () => {
    const out = path.join(tmp, "cutout.png");
    await removeBackground(path.join(FIXTURES, "assets", "photo.png"), out);

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.channels).toBe(4);

    let transparent = 0;
    let opaque = 0;
    for (let p = 0; p < info.width * info.height; p += 1) {
      const a = data[p * 4 + 3] as number;
      if (a < 16) transparent += 1;
      else if (a > 239) opaque += 1;
    }
    // The matte must actually separate something: both classes well represented.
    const n = info.width * info.height;
    expect(transparent / n).toBeGreaterThan(0.05);
    expect(opaque / n).toBeGreaterThan(0.05);
  }, 60_000);
});

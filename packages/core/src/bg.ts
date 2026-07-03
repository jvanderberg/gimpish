/**
 * Background removal: U²-Net via onnxruntime — a faithful port of rembg's
 * u2net session (same model file, same ~/.u2net cache location, same pre/post
 * processing), so cutouts match what the Python engine produced.
 *
 * The model (~176 MB) is downloaded once to ~/.u2net/u2net.onnx if missing;
 * machines that already ran rembg reuse the existing file.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

const MODEL_DIR = path.join(homedir(), ".u2net");
const MODEL_PATH = path.join(MODEL_DIR, "u2net.onnx");
const MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx";

const INPUT_SIZE = 320;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

// onnxruntime-node is a heavy native module; load it lazily so the render
// path never pays for it.
type OrtModule = typeof import("onnxruntime-node");
let ortSession: import("onnxruntime-node").InferenceSession | null = null;

async function ensureModel(): Promise<string> {
  if (existsSync(MODEL_PATH)) return MODEL_PATH;
  mkdirSync(MODEL_DIR, { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) {
    throw new Error(`failed to download u2net model: HTTP ${res.status} from ${MODEL_URL}`);
  }
  const tmp = `${MODEL_PATH}.download`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, MODEL_PATH);
  return MODEL_PATH;
}

async function session(): Promise<import("onnxruntime-node").InferenceSession> {
  if (ortSession) return ortSession;
  const ort: OrtModule = await import("onnxruntime-node");
  ortSession = await ort.InferenceSession.create(await ensureModel());
  return ortSession;
}

/**
 * Write an RGBA cutout of `src` to `out` (original pixels, U²-Net alpha).
 * Returns `out`.
 */
export async function removeBackground(src: string, out: string): Promise<string> {
  const ort: OrtModule = await import("onnxruntime-node");

  // NB: no EXIF auto-orientation — neither the render path nor the original
  // rembg pipeline applies it, and metadata() reports pre-rotation dimensions,
  // so orienting here would scramble the rgba assembly for orientations 5-8.
  const image = sharp(src);
  const meta = await image.metadata();
  const { width, height } = meta;

  // Preprocess: resize to 320x320, scale by the image max, normalize per channel
  // (rembg U2netSession.normalize with mean/std above), NCHW float32.
  const resized = await image
    .clone()
    .removeAlpha()
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();

  let maxVal = 0;
  for (const v of resized) {
    if (v > maxVal) maxVal = v;
  }
  if (maxVal === 0) maxVal = 1;

  const n = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * n);
  for (let p = 0; p < n; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const v = (resized[p * 3 + c] as number) / maxVal;
      input[c * n + p] = (v - (MEAN[c] as number)) / (STD[c] as number);
    }
  }

  const sess = await session();
  const inputName = sess.inputNames[0] ?? "input.1";
  const outputName = sess.outputNames[0] ?? "1959";
  const results = await sess.run({
    [inputName]: new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]),
  });
  const pred = results[outputName];
  if (!pred) throw new Error("u2net returned no output tensor");
  const mask = pred.data as Float32Array;

  // Postprocess: min-max normalize the 320x320 saliency map, upscale to the
  // source size, and attach it as the alpha channel of the original image.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of mask) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo || 1;
  const maskBytes = Buffer.alloc(n);
  for (let p = 0; p < n; p += 1) {
    // trunc, not round: matches rembg's `(pred * 255).astype("uint8")`
    maskBytes[p] = Math.trunc((((mask[p] as number) - lo) / range) * 255);
  }

  const alpha = await sharp(maskBytes, {
    raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 1 },
  })
    .resize(width, height, { fit: "fill" })
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const rgb = await sharp(src).removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    rgba[p * 4] = rgb[p * 3] as number;
    rgba[p * 4 + 1] = rgb[p * 3 + 1] as number;
    rgba[p * 4 + 2] = rgb[p * 3 + 2] as number;
    rgba[p * 4 + 3] = alpha[p] as number;
  }

  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(out);
  return out;
}

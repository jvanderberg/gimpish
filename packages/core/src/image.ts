import { statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const sizeCache = new Map<string, { width: number; height: number }>();

/** Read intrinsic image dimensions without participating in composition. */
export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const resolved = path.resolve(file);
  const key = `${resolved}@${statSync(resolved).mtimeMs}`;
  const hit = sizeCache.get(key);
  if (hit) return hit;
  const meta = await sharp(resolved).metadata();
  const size = { width: meta.width, height: meta.height };
  sizeCache.set(key, size);
  return size;
}

/** Validate uploaded image bytes and return their intrinsic metadata. */
export async function imageMeta(
  data: Uint8Array,
): Promise<{ width: number; height: number; format: string }> {
  const meta = await sharp(data).metadata();
  return { width: meta.width, height: meta.height, format: meta.format ?? "png" };
}

/**
 * Editor uploads (drag-and-drop / upload button). Image bytes are written into
 * assets/ next to the scene file with a deterministic slugged name, then added
 * as a top image layer — so a human drop and an LLM session working the same
 * directory agree on the layer id and asset path without coordination.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  imageMeta,
  type Layer,
  loadScene,
  saveScene,
  sceneRoot,
  slug,
  uniqueId,
} from "@gimpish/core";
import { ASSETS_DIR } from "../shared.ts";

export interface ImportedImage {
  id: string;
  source: string;
  width: number;
  height: number;
}

/** jpeg -> .jpg etc; used when the uploaded filename has no usable extension. */
function extForFormat(format: string): string {
  return format === "jpeg" ? ".jpg" : `.${format}`;
}

function sameBytes(file: string, data: Uint8Array): boolean {
  const existing = readFileSync(file);
  return existing.length === data.length && existing.equals(data);
}

/**
 * Persist uploaded bytes as assets/<slug><ext>. Re-uploading identical content
 * reuses the existing file; a name collision with different content gets a
 * -2/-3… suffix.
 */
function writeAsset(root: string, originalName: string, data: Uint8Array, format: string): string {
  const dir = path.join(root, ASSETS_DIR);
  mkdirSync(dir, { recursive: true });
  const parsed = path.parse(originalName);
  const stem = slug(parsed.name) || "image";
  const ext = /^\.[a-z0-9]+$/.test(parsed.ext.toLowerCase())
    ? parsed.ext.toLowerCase()
    : extForFormat(format);

  let file = `${stem}${ext}`;
  let n = 2;
  while (existsSync(path.join(dir, file)) && !sameBytes(path.join(dir, file), data)) {
    file = `${stem}-${n}${ext}`;
    n += 1;
  }
  const target = path.join(dir, file);
  if (!existsSync(target)) writeFileSync(target, data);
  return `${ASSETS_DIR}/${file}`;
}

/**
 * Import image bytes into the scene: save the asset, then add an image layer
 * on top, scaled down to fit the canvas if needed and centered.
 */
export async function importImage(
  scenePath: string,
  originalName: string,
  data: Uint8Array,
): Promise<ImportedImage> {
  const { width, height, format } = await imageMeta(data); // throws on non-image bytes
  const doc = loadScene(scenePath);
  const source = writeAsset(sceneRoot(doc), originalName, data, format);

  const { width: cw, height: ch } = doc.scene.canvas;
  const scale = Math.min(1, cw / width, ch / height);
  const base = slug(path.parse(originalName).name) || "image";
  const layer: Layer = {
    id: uniqueId(doc.scene, base),
    type: "image",
    name: base,
    opacity: 1,
    blend: "normal",
    visible: true,
    source,
    transform: {
      x: Math.round((cw - width * scale) / 2),
      y: Math.round((ch - height * scale) / 2),
      scale,
      rotation: 0,
    },
    mask: null,
  };
  doc.scene.layers.push(layer);
  saveScene(doc);
  return { id: layer.id, source, width, height };
}

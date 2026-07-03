/** Scene file IO (node-only): loading, saving, and path resolution. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseScene, type Scene } from "./schema.ts";

export const CACHE_DIR = ".scene_cache";

/** A scene bound to its file path — the unit every CLI verb and server op works on. */
export interface SceneDoc {
  scene: Scene;
  path: string;
}

export function loadScene(scenePath: string): SceneDoc {
  const raw = readFileSync(scenePath, "utf8");
  return { scene: parseScene(JSON.parse(raw)), path: path.resolve(scenePath) };
}

export function saveScene(doc: SceneDoc, to?: string): string {
  const target = to ? path.resolve(to) : doc.path;
  // Write-then-rename so watchers and concurrent readers never see a partial file.
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc.scene, null, 2)}\n`);
  renameSync(tmp, target);
  doc.path = target;
  return target;
}

/** Directory that relative layer sources/masks resolve against. */
export function sceneRoot(doc: SceneDoc): string {
  return path.dirname(doc.path);
}

/** Ensure and return the scene's derived-asset cache directory. */
export function cacheDir(doc: SceneDoc): string {
  const dir = path.join(sceneRoot(doc), CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Node-side .gimpish zip packing and safe extraction. */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { CACHE_DIR, type SceneDoc, sceneRoot } from "./doc.ts";
import { parseScene, type Scene, slug } from "./schema.ts";

export const BUNDLE_EXT = ".gimpish";
const SCENE_ENTRY = "scene.json";
const ASSETS_DIR = "assets";

interface RefSlot {
  kind: "source" | "cache";
  get(): string;
  set(storedPath: string): void;
}

function collectRefs(scene: Scene): RefSlot[] {
  const slots: RefSlot[] = [];
  for (const layer of scene.layers) {
    if (layer.type !== "image") continue;
    slots.push({
      kind: "source",
      get: () => layer.source,
      set: (storedPath) => {
        layer.source = storedPath;
      },
    });
    const mask = layer.mask;
    if (mask?.source) {
      slots.push({
        kind: "source",
        get: () => mask.source as string,
        set: (storedPath) => {
          mask.source = storedPath;
        },
      });
    }
    if (mask?.cache) {
      slots.push({
        kind: "cache",
        get: () => mask.cache as string,
        set: (storedPath) => {
          mask.cache = storedPath;
        },
      });
    }
  }
  return slots;
}

function bundlePathFor(stored: string, kind: RefSlot["kind"], used: ReadonlySet<string>): string {
  const parsed = path.parse(stored);
  const directory = kind === "cache" ? CACHE_DIR : ASSETS_DIR;
  const stem = kind === "cache" ? parsed.name : slug(parsed.name) || "asset";
  const extension = parsed.ext.toLowerCase();
  let candidate = `${directory}/${stem}${extension}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${directory}/${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

export function createBundle(doc: SceneDoc): Uint8Array {
  const root = sceneRoot(doc);
  const scene = parseScene(structuredClone(doc.scene));
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  const byResolved = new Map<string, string>();
  const used = new Set<string>([SCENE_ENTRY]);
  const missing: string[] = [];

  for (const slot of collectRefs(scene)) {
    const stored = slot.get();
    const resolved = path.resolve(root, stored);
    let bundlePath = byResolved.get(resolved);
    if (!bundlePath) {
      if (!existsSync(resolved)) {
        missing.push(stored);
        continue;
      }
      bundlePath = bundlePathFor(stored, slot.kind, used);
      used.add(bundlePath);
      byResolved.set(resolved, bundlePath);
      files[bundlePath] = [readFileSync(resolved), { level: 0 }];
    }
    slot.set(bundlePath);
  }
  if (missing.length > 0) {
    throw new Error(`cannot bundle, missing asset file(s): ${missing.join(", ")}`);
  }
  files[SCENE_ENTRY] = [
    new TextEncoder().encode(`${JSON.stringify(scene, null, 2)}\n`),
    { level: 6 },
  ];
  return zipSync(files);
}

function safeTarget(root: string, name: string): string {
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`unsafe path in bundle: ${JSON.stringify(name)}`);
  }
  return target;
}

export function extractBundle(data: Uint8Array, scenePath: string): Scene {
  const entries = unzipSync(data);
  const sceneBytes = entries[SCENE_ENTRY];
  if (!sceneBytes) throw new Error(`not a ${BUNDLE_EXT} bundle (no ${SCENE_ENTRY} inside)`);
  const scene = parseScene(JSON.parse(new TextDecoder().decode(sceneBytes)));
  const resolvedScene = path.resolve(scenePath);
  const root = path.dirname(resolvedScene);

  for (const [name, bytes] of Object.entries(entries)) {
    if (name === SCENE_ENTRY || name.endsWith("/")) continue;
    const target = safeTarget(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  if (existsSync(resolvedScene)) copyFileSync(resolvedScene, `${resolvedScene}.bak`);
  writeFileSync(resolvedScene, `${JSON.stringify(scene, null, 2)}\n`);
  return scene;
}

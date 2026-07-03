/**
 * .gimpish bundles: a zip holding scene.json plus every asset the scene
 * references (layer sources, mask images, cutout caches), self-contained and
 * relocatable. The bundle never encodes the source machine's directory layout:
 * every source lands flat under assets/ (slugged basename), every derived
 * cutout cache under .scene_cache/, and the scene copy is rewritten to match.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CACHE_DIR, parseScene, type Scene, type SceneDoc, sceneRoot, slug } from "@gimpish/core";
import { unzipSync, zipSync } from "fflate";
import { ASSETS_DIR } from "./shared.ts";

export const BUNDLE_EXT = ".gimpish";

const SCENE_ENTRY = "scene.json";

/** One rewritable path reference inside a scene (layer source, mask source/cache). */
interface RefSlot {
  kind: "source" | "cache";
  get(): string;
  set(p: string): void;
}

function collectRefs(scene: Scene): RefSlot[] {
  const slots: RefSlot[] = [];
  for (const layer of scene.layers) {
    if (layer.type !== "image") continue;
    slots.push({
      kind: "source",
      get: () => layer.source,
      set: (p) => {
        layer.source = p;
      },
    });
    const mask = layer.mask;
    if (mask?.source) {
      slots.push({
        kind: "source",
        get: () => mask.source as string,
        set: (p) => {
          mask.source = p;
        },
      });
    }
    if (mask?.cache) {
      slots.push({
        kind: "cache",
        get: () => mask.cache as string,
        set: (p) => {
          mask.cache = p;
        },
      });
    }
  }
  return slots;
}

/**
 * Flat zip path for a referenced file: sources become assets/<slugged-name>,
 * cutout caches .scene_cache/<name> (their names are generated from layer ids,
 * never user paths). Only the basename of the original path survives.
 */
function bundlePathFor(stored: string, kind: RefSlot["kind"], used: ReadonlySet<string>): string {
  const parsed = path.parse(stored);
  const dir = kind === "cache" ? CACHE_DIR : ASSETS_DIR;
  const stem = kind === "cache" ? parsed.name : slug(parsed.name) || "asset";
  const ext = parsed.ext.toLowerCase();
  let candidate = `${dir}/${stem}${ext}`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${dir}/${stem}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

/** Pack a scene and all referenced assets into .gimpish zip bytes. */
export function createBundle(doc: SceneDoc): Uint8Array {
  const root = sceneRoot(doc);
  // Deep copy so path rewrites never touch the live document.
  const scene = parseScene(JSON.parse(JSON.stringify(doc.scene)));

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
      // level 0: image formats are already compressed; recompressing wastes time.
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

/** Resolve a zip entry under root, rejecting absolute paths and .. escapes. */
function safeTarget(root: string, name: string): string {
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`unsafe path in bundle: ${JSON.stringify(name)}`);
  }
  return target;
}

/**
 * Unpack .gimpish bytes over the scene at `scenePath`: assets land relative to
 * the scene file, which is replaced last (the previous one is kept as .bak).
 */
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

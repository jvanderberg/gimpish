/** Helpers shared by all CLI verbs. */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { SceneDoc } from "@gimpish/core";
import { ANCHORS, loadScene, saveScene, sceneRoot } from "@gimpish/core";
import type { Command } from "commander";

export const DEFAULT_SCENE = "scene.json";

/** Where editor uploads and bundle assets live, relative to the scene file. */
export const ASSETS_DIR = "assets";

/** User-facing failure: printed without a stack trace, exit code 1. */
export class CliError extends Error {}

/**
 * The directory the user invoked gimpish from, captured before `-C` chdirs.
 * Scene paths are echoed relative to here so `-C ../banner add …` reports
 * `→ ../banner/scene.json`, not a path that pretends the chdir never happened.
 */
let invocationCwd: string | undefined;

export function setInvocationCwd(dir: string): void {
  invocationCwd = dir;
}

/** Scene path as shown to the user: relative to the invocation cwd when shorter. */
export function displayScene(absPath: string): string {
  const rel = path.relative(invocationCwd ?? process.cwd(), absPath) || ".";
  return rel.length < absPath.length ? rel : absPath;
}

/**
 * Resolve a `--scene` value to a scene file. A directory (the document) means
 * the well-known `scene.json` inside it.
 */
export function resolveScenePath(scene: string): string {
  const resolved = path.resolve(scene);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return path.join(resolved, DEFAULT_SCENE);
  }
  return resolved;
}

export function loadOrFail(scenePath: string): SceneDoc {
  const resolved = resolveScenePath(scenePath);
  if (!existsSync(resolved)) {
    throw new CliError(
      `no scene at ${displayScene(resolved)} — run \`gimpish init -w <px> -h <px>\` to create one` +
        ` (or point at an existing document with -C <dir>).`,
    );
  }
  return loadScene(resolved);
}

/** Persist the scene and append the resolved-scene echo to a verb's message. */
export function saved(doc: SceneDoc, message: string): string {
  saveScene(doc);
  return `${message} → ${displayScene(doc.path)}`;
}

/** Store paths relative to the scene file when possible. */
export function relToScene(doc: SceneDoc, file: string): string {
  const rel = path.relative(sceneRoot(doc), path.resolve(file));
  return rel.startsWith("..") && path.isAbsolute(file) ? path.resolve(file) : rel;
}

export function sceneOption(cmd: Command): Command {
  return cmd.option("--scene <path>", "Scene JSON file (or its directory).", DEFAULT_SCENE);
}

export function parseNum(value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new CliError(`expected a number, got ${JSON.stringify(value)}`);
  return n;
}

export function parseIntStrict(value: string): number {
  const n = Number(value); // Number() rejects trailing garbage ("80x"), parseInt doesn't
  if (!Number.isInteger(n)) throw new CliError(`expected an integer, got ${JSON.stringify(value)}`);
  return n;
}

/** Reject unknown anchors at input time (the renderer would silently center). */
export function requireAnchor(anchor: string): void {
  if (!(anchor in ANCHORS)) {
    throw new CliError(
      `unknown anchor '${anchor}'; choose from ${Object.keys(ANCHORS).join(", ")}`,
    );
  }
}

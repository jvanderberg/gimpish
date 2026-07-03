/** Helpers shared by all CLI verbs. */

import { existsSync } from "node:fs";
import path from "node:path";
import type { SceneDoc } from "@gimpish/core";
import { ANCHORS, loadScene, sceneRoot } from "@gimpish/core";
import type { Command } from "commander";

export const DEFAULT_SCENE = "scene.json";

/** User-facing failure: printed without a stack trace, exit code 1. */
export class CliError extends Error {}

export function loadOrFail(scenePath: string): SceneDoc {
  if (!existsSync(scenePath)) {
    throw new CliError(`${scenePath} not found — run \`gimpish init\` first.`);
  }
  return loadScene(scenePath);
}

/** Store paths relative to the scene file when possible. */
export function relToScene(doc: SceneDoc, file: string): string {
  const rel = path.relative(sceneRoot(doc), path.resolve(file));
  return rel.startsWith("..") && path.isAbsolute(file) ? path.resolve(file) : rel;
}

export function sceneOption(cmd: Command): Command {
  return cmd.option("--scene <path>", "Scene JSON file.", DEFAULT_SCENE);
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

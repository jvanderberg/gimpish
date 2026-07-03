/** Helpers shared by all CLI verbs. */

import { existsSync } from "node:fs";
import path from "node:path";
import type { SceneDoc } from "@gimpish/core";
import { loadScene, sceneRoot } from "@gimpish/core";
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
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new CliError(`expected an integer, got ${JSON.stringify(value)}`);
  return n;
}

/** Scene lifecycle verbs: init, add, layers, save. */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { type Layer, parseColor, parseScene, saveScene, uniqueId } from "@gimpish/core";
import type { Command } from "commander";
import {
  CliError,
  DEFAULT_SCENE,
  displayScene,
  loadOrFail,
  parseIntStrict,
  relToScene,
  resolveScenePath,
  saved,
  sceneOption,
} from "../shared.ts";

export function initAction(
  dir: string | undefined,
  opts: { width?: number; height?: number; bg: string; scene: string; force?: boolean },
): string {
  if (opts.width === undefined || opts.height === undefined) {
    throw new CliError(
      "canvas size is required — e.g. `gimpish init -w 1600 -h 900` (16:9), " +
        "or `gimpish init poster/ -w 1080 -h 1350` to scaffold a new document directory.",
    );
  }
  if (dir && opts.scene !== DEFAULT_SCENE) {
    throw new CliError("give either a directory to scaffold or --scene, not both.");
  }
  const target = dir ? path.join(path.resolve(dir), DEFAULT_SCENE) : resolveScenePath(opts.scene);
  if (existsSync(target) && !opts.force) {
    throw new CliError(`${displayScene(target)} already exists (use --force to overwrite).`);
  }
  if (dir) {
    mkdirSync(path.dirname(target), { recursive: true });
  } else if (opts.scene === DEFAULT_SCENE) {
    // Bare `init` in a directory that already has stuff in it is usually fine
    // (a repo root), but occasionally an accident (~). Note it, don't block.
    const visible = readdirSync(path.dirname(target)).filter((e) => !e.startsWith("."));
    if (visible.length > 0) {
      process.stderr.write(
        "note: creating scene.json in a non-empty directory — `gimpish init <dir>` scaffolds a fresh document directory.\n",
      );
    }
  }
  if (opts.bg !== "transparent") parseColor(opts.bg); // validate
  const doc = {
    scene: parseScene({
      canvas: { width: opts.width, height: opts.height, background: opts.bg },
      layers: [],
    }),
    path: target,
  };
  saveScene(doc);
  return `created ${displayScene(target)} (${opts.width}x${opts.height}, bg=${opts.bg})`;
}

export function addAction(file: string, opts: { name?: string; scene: string }): string {
  const doc = loadOrFail(opts.scene);
  if (!existsSync(file)) throw new CliError(`${file} not found.`);
  const base = opts.name ?? path.parse(file).name;
  const layer: Layer = {
    id: uniqueId(doc.scene, base),
    type: "image",
    name: base,
    opacity: 1,
    blend: "normal",
    visible: true,
    source: relToScene(doc, file),
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    mask: null,
  };
  doc.scene.layers.push(layer);
  return saved(doc, `added image layer '${layer.id}' (${file})`);
}

function layerSummary(l: Layer): string {
  switch (l.type) {
    case "image": {
      const mask = l.mask ? `  mask=${l.mask.kind}` : "";
      return `src=${l.source} scale=${Number(l.transform.scale.toPrecision(3))}${mask}`;
    }
    case "shape":
      return `${l.shape} fill=${l.fill ?? "none"} stroke=${l.stroke ?? "none"}`;
    case "gradient":
      return l.gradient.kind;
    case "arrow": {
      const a = l.arrow;
      return `(${a.from_x},${a.from_y}) -> (${a.to_x},${a.to_y})`;
    }
    case "text": {
      const content = l.text.content.replaceAll("\n", "\\n").slice(0, 28);
      return `'${content}' font=${l.text.font} size=${l.text.size}`;
    }
  }
}

export function layersAction(opts: { scene: string }): string {
  const doc = loadOrFail(opts.scene);
  const { canvas, layers } = doc.scene;
  const lines = [
    `scene ${displayScene(doc.path)} — canvas ${canvas.width}x${canvas.height}  bg=${canvas.background}`,
  ];
  if (layers.length === 0) {
    lines.push("(no layers)");
    return lines.join("\n");
  }
  const idWidth = Math.max(...layers.map((l) => l.id.length), 2);
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const l = layers[i] as Layer;
    const vis = l.visible ? " " : "·";
    lines.push(
      `${vis}[${i}] ${l.id.padEnd(idWidth)} ${l.type.padEnd(8)} ` +
        `op=${Number(l.opacity.toPrecision(2))} blend=${l.blend.padEnd(8)} ${layerSummary(l)}`,
    );
  }
  return lines.join("\n");
}

export function saveAction(out: string | undefined, opts: { scene: string }): string {
  const doc = loadOrFail(opts.scene);
  const target = saveScene(doc, out);
  return `saved ${displayScene(target)}`;
}

export function registerSceneCommands(program: Command): void {
  sceneOption(
    program
      .command("init")
      .description("Create a new empty scene (in <dir> if given, else here).")
      .argument("[dir]", "Scaffold a new document directory and put scene.json inside it.")
      .option("-w, --width <px>", "Canvas width in pixels.", parseIntStrict)
      .option("-h, --height <px>", "Canvas height in pixels.", parseIntStrict)
      .option("--bg <color>", "'transparent' or '#rrggbbaa'.", "transparent")
      .option("--force", "Overwrite an existing scene."),
  ).action((dir, opts) => console.log(initAction(dir, opts)));

  sceneOption(
    program
      .command("add")
      .description("Import an image as a new layer on top of the stack.")
      .argument("<path>", "Image file to import.")
      .option("--name <name>", "Layer name/id hint."),
  ).action((file, opts) => console.log(addAction(file, opts)));

  sceneOption(
    program.command("layers").description("Print the layer stack (top layer first)."),
  ).action((opts) => console.log(layersAction(opts)));

  sceneOption(
    program
      .command("save")
      .description("Persist the scene (or copy it to a new path).")
      .argument("[out]", "Path to write (default: same file)."),
  ).action((out, opts) => console.log(saveAction(out, opts)));
}

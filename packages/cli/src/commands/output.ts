/** Output verbs: preview, render, export. */

import { writeFileSync } from "node:fs";
import { rasterToPng, renderPreview, renderToFile } from "@gimpish/core";
import type { Command } from "commander";
import { loadOrFail, parseIntStrict, sceneOption } from "../shared.ts";

export async function previewAction(opts: {
  out: string;
  max: number;
  scene: string;
}): Promise<string> {
  const doc = loadOrFail(opts.scene);
  const img = await renderPreview(doc, opts.max);
  writeFileSync(opts.out, await rasterToPng(img));
  return `preview -> ${opts.out} (${img.width}x${img.height})`;
}

export async function renderAction(opts: {
  out: string;
  width?: number;
  height?: number;
  scene: string;
}): Promise<string> {
  const doc = loadOrFail(opts.scene);
  await renderToFile(doc, opts.out, { width: opts.width, height: opts.height });
  return `rendered -> ${opts.out}`;
}

export async function exportAction(opts: {
  out: string;
  quality: number;
  width?: number;
  height?: number;
  scene: string;
}): Promise<string> {
  const doc = loadOrFail(opts.scene);
  await renderToFile(doc, opts.out, {
    width: opts.width,
    height: opts.height,
    quality: opts.quality,
  });
  return `exported -> ${opts.out}`;
}

export function registerOutputCommands(program: Command): void {
  sceneOption(
    program
      .command("preview")
      .description("Render a quick downscaled preview PNG (for verifying scene state).")
      .option("--out <path>", "Preview PNG path.", "preview.png")
      .option("--max <px>", "Max dimension of the preview.", parseIntStrict, 1024),
  ).action(async (opts) => console.log(await previewAction(opts)));

  sceneOption(
    program
      .command("render")
      .description("Render the scene at full (or specified) resolution.")
      .requiredOption("--out <path>", "Output image path.")
      .option("--width <px>", "Output width.", parseIntStrict)
      .option("--height <px>", "Output height.", parseIntStrict),
  ).action(async (opts) => console.log(await renderAction(opts)));

  sceneOption(
    program
      .command("export")
      .description("Render and encode to a final file (png/jpg/webp).")
      .requiredOption("--out <path>", "Output .png/.jpg/.webp.")
      .option("--quality <n>", "JPEG/WebP quality.", parseIntStrict, 90)
      .option("--width <px>", "Output width.", parseIntStrict)
      .option("--height <px>", "Output height.", parseIntStrict),
  ).action(async (opts) => console.log(await exportAction(opts)));
}

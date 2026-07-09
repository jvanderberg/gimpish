/** Output verbs: preview, render, export. */

import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  EXPORT_PRESETS,
  type ExportCrop,
  type ExportSettings,
  isExportPreset,
  rasterToPng,
  renderExportToFile,
  renderPreview,
  renderToFile,
  resolveExportCrop,
  saveScene,
} from "@gimpish/core";
import type { Command } from "commander";
import { CliError, displayScene, loadOrFail, parseIntStrict, sceneOption } from "../shared.ts";

type OutFormat = "png" | "jpg" | "webp";

function coerceFormat(f: string): OutFormat {
  if (f === "png" || f === "jpg" || f === "webp") return f;
  if (f === "jpeg") return "jpg";
  throw new CliError(`--format must be png|jpg|webp, got ${JSON.stringify(f)}`);
}

function formatFromExt(out: string | undefined): OutFormat | undefined {
  if (!out) return undefined;
  const e = path.extname(out).toLowerCase();
  if (e === ".jpg" || e === ".jpeg") return "jpg";
  if (e === ".webp") return "webp";
  if (e === ".png") return "png";
  return undefined;
}

function parseCropArg(s: string): ExportCrop {
  const parts = s.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new CliError(`--crop expects "x,y,w,h" in canvas px, got ${JSON.stringify(s)}`);
  }
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w <= 0 || h <= 0) throw new CliError("--crop width and height must be > 0");
  return { x, y, w, h };
}

export async function previewAction(opts: {
  out: string;
  max: number;
  scene: string;
}): Promise<string> {
  const doc = loadOrFail(opts.scene);
  const img = await renderPreview(doc, opts.max);
  writeFileSync(opts.out, await rasterToPng(img));
  return `preview -> ${opts.out} (${img.width}x${img.height}) [scene: ${displayScene(doc.path)}]`;
}

export async function renderAction(opts: {
  out: string;
  width?: number;
  height?: number;
  scene: string;
}): Promise<string> {
  const doc = loadOrFail(opts.scene);
  await renderToFile(doc, opts.out, { width: opts.width, height: opts.height });
  return `rendered -> ${opts.out} [scene: ${displayScene(doc.path)}]`;
}

export async function exportAction(opts: {
  out?: string;
  format?: string;
  quality?: number;
  width?: number;
  height?: number;
  preset?: string;
  crop?: string;
  save?: boolean;
  scene: string;
}): Promise<string> {
  const doc = loadOrFail(opts.scene);
  const saved = doc.scene.export;

  let presetDims: { width: number; height: number } | undefined;
  if (opts.preset) {
    if (!isExportPreset(opts.preset)) {
      throw new CliError(
        `unknown --preset ${JSON.stringify(opts.preset)}; one of: ${Object.keys(EXPORT_PRESETS).join(", ")}`,
      );
    }
    presetDims = EXPORT_PRESETS[opts.preset];
  }

  const width = opts.width ?? presetDims?.width ?? saved?.width;
  const height = opts.height ?? presetDims?.height ?? saved?.height;
  const format: OutFormat =
    (opts.format ? coerceFormat(opts.format) : formatFromExt(opts.out)) ?? saved?.format ?? "png";
  const quality = opts.quality ?? saved?.quality ?? 90;

  // A fixed output size (from flags, a preset, or saved settings) triggers the
  // crop+resize export path. Otherwise fall back to a plain full-canvas render.
  if (width != null && height != null) {
    // Reuse a saved crop only when the size also came purely from saved settings;
    // a new size via flags/preset gets a fresh centered cover crop (unless --crop).
    const sizeFromFlags = opts.width != null || opts.height != null || presetDims != null;
    const crop = opts.crop ? parseCropArg(opts.crop) : sizeFromFlags ? null : (saved?.crop ?? null);
    const settings: ExportSettings = {
      width,
      height,
      format,
      quality,
      crop,
      preset: opts.preset ?? (sizeFromFlags ? null : (saved?.preset ?? null)),
    };
    const out = opts.out ?? `export.${format}`;
    await renderExportToFile(doc, out, settings);
    if (opts.save) {
      doc.scene.export = settings;
      saveScene(doc);
    }
    const eff = resolveExportCrop(doc.scene.canvas, settings);
    const savedNote = opts.save ? " · saved export settings" : "";
    return `exported -> ${out} (${width}x${height}, crop ${eff.x},${eff.y} ${eff.w}x${eff.h})${savedNote} [scene: ${displayScene(doc.path)}]`;
  }

  if (!opts.out) {
    throw new CliError(
      "nothing to export: pass --out, or --preset / --width+--height (or save export settings first)",
    );
  }
  await renderToFile(doc, opts.out, { width: opts.width, height: opts.height, quality });
  return `exported -> ${opts.out} [scene: ${displayScene(doc.path)}]`;
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
      .description("Render to a final file, using saved export settings (size + crop) or flags.")
      .option("--out <path>", "Output .png/.jpg/.webp (default export.<fmt>).")
      .option("--format <fmt>", "png|jpg|webp (else inferred from --out or saved).")
      .option("--preset <name>", `Output size preset: ${Object.keys(EXPORT_PRESETS).join(", ")}.`)
      .option("--width <px>", "Output width.", parseIntStrict)
      .option("--height <px>", "Output height.", parseIntStrict)
      .option("--crop <x,y,w,h>", "Source crop in canvas px (else centered cover).")
      .option("--quality <n>", "JPEG/WebP quality.", parseIntStrict)
      .option("--save", "Persist these export settings into scene.json."),
  ).action(async (opts) => console.log(await exportAction(opts)));
}

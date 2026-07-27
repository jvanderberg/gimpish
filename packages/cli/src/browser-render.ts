import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExportCrop, Scene } from "@gimpish/core";
import { CliError } from "./shared.ts";

export type BrowserRenderFormat = "png" | "jpg" | "webp";

export interface BrowserRenderRequest {
  scenePath: string;
  scene?: Scene;
  out: string;
  width: number;
  height: number;
  crop?: ExportCrop;
  format: BrowserRenderFormat;
  quality: number;
}

function headlessHost(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "../headless/main.mjs"),
    path.resolve(import.meta.dirname, "../../headless/main.mjs"),
  ];
  const host = candidates.find((candidate) => existsSync(candidate));
  if (!host) throw new CliError("headless browser renderer is missing from this installation");
  return host;
}

const require = createRequire(import.meta.url);

function electronBinary(): string {
  try {
    const binary = require("electron");
    if (typeof binary === "string") return binary;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new CliError(
    "rendering requires Electron (the canonical browser renderer); install the optional electron dependency",
  );
}

/** Render through hidden Chromium using the exact same module as serve/Electron. */
export async function renderInBrowser(request: BrowserRenderRequest): Promise<void> {
  const webDist = [
    path.resolve(import.meta.dirname, "web"),
    path.resolve(import.meta.dirname, "../../web/dist"),
  ].find((candidate) => existsSync(path.join(candidate, "index.html")));
  if (!webDist) throw new CliError("built browser renderer is missing; run npm run build");
  const temporary = mkdtempSync(path.join(tmpdir(), "gimpish-render-"));
  const requestPath = path.join(temporary, "request.json");
  writeFileSync(
    requestPath,
    JSON.stringify({
      ...request,
      scenePath: path.resolve(request.scenePath),
      out: path.resolve(request.out),
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(electronBinary(), [headlessHost()], {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          GIMPISH_HEADLESS_REQUEST: requestPath,
          GIMPISH_WEB_DIST: webDist,
        },
      });
      let error = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        error += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new CliError(error.trim() || `headless renderer exited with code ${code}`));
      });
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

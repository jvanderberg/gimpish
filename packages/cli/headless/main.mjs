import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const requestPath = process.env.GIMPISH_HEADLESS_REQUEST;
if (!requestPath) throw new Error("GIMPISH_HEADLESS_REQUEST is required");

const request = JSON.parse(readFileSync(requestPath, "utf8"));
const scenePath = path.resolve(request.scenePath);
const sceneRoot = path.dirname(scenePath);
const scene = request.scene ?? JSON.parse(readFileSync(scenePath, "utf8"));
const referenced = new Set();
for (const layer of scene.layers ?? []) {
  if (layer.type !== "image") continue;
  referenced.add(layer.source);
  if (layer.mask?.source) referenced.add(layer.mask.source);
  if (layer.mask?.cache) referenced.add(layer.mask.cache);
}

const mimeTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

let finished = false;
let window = null;

function finish(code, error) {
  if (finished) return;
  finished = true;
  if (error) console.error(error);
  process.exitCode = code;
  window?.destroy();
  app.quit();
}

ipcMain.handle("headless:request", () => ({
  scene,
  width: request.width,
  height: request.height,
  ...(request.crop ? { crop: request.crop } : {}),
  format: request.format,
  quality: request.quality,
}));

ipcMain.handle("headless:asset", (_event, storedPath) => {
  if (typeof storedPath !== "string" || !referenced.has(storedPath)) {
    throw new Error("asset is not referenced by the scene");
  }
  const file = path.resolve(sceneRoot, storedPath);
  const mimeType = mimeTypes[path.extname(file).toLowerCase()];
  if (!mimeType) throw new Error(`unsupported asset type: ${path.extname(file)}`);
  return { mimeType, data: readFileSync(file).toString("base64") };
});

ipcMain.handle("headless:complete", (_event, data) => {
  if (typeof data !== "string") throw new Error("renderer returned invalid image data");
  writeFileSync(path.resolve(request.out), Buffer.from(data, "base64"));
  finish(0);
});

ipcMain.handle("headless:fail", (_event, error) => {
  finish(1, typeof error === "string" ? error : "headless renderer failed");
});

app.whenReady().then(() => {
  const webDist = process.env.GIMPISH_WEB_DIST ?? path.resolve(here, "../dist/web");
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    finish(1, `headless renderer exited: ${details.reason}`);
  });
  void window.loadFile(path.join(webDist, "index.html"));
});

setTimeout(() => finish(1, "headless renderer timed out"), 120_000).unref();

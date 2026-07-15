import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { BUNDLE_EXT, createBundle, extractBundle } from "@gimpish/core/bundle";
import {
  type DocumentCommand,
  type EditReceipt,
  parseScene,
  type Scene,
} from "@gimpish/core/model";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { z } from "zod";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const MCP_PORT = 8767;
const COMMAND_TIMEOUT_MS = 30_000;
const BACKGROUND_TIMEOUT_MS = 5 * 60_000;
const U2NET_MODEL_PATH = path.join(homedir(), ".u2net", "u2net.onnx");
const U2NET_MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx";
const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "add",
] as const;
const ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
let modelDownload: Promise<string> | null = null;

interface OpenDocument {
  path: string;
  scene: Scene;
  revision: number;
  bundlePath?: string;
}

interface RendererRequest {
  requestId: string;
  kind:
    | "apply-command"
    | "replace-scene"
    | "history"
    | "render-preview"
    | "render-image"
    | "remove-background";
  command?: DocumentCommand;
  layerId?: string;
  scene?: Scene;
  historyOp?: "undo" | "redo";
  max?: number;
  width?: number;
  height?: number;
}

interface RendererResponse {
  requestId: string;
  scene?: Scene;
  receipt?: EditReceipt;
  preview?: { mimeType: "image/png"; data: string; width: number; height: number };
  error?: string;
}

let win: BrowserWindow | null = null;
let document: OpenDocument;
const pending = new Map<
  string,
  {
    resolve: (response: RendererResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

function documentDisplayName(): string {
  return document.bundlePath
    ? path.basename(document.bundlePath, BUNDLE_EXT)
    : path.basename(path.dirname(document.path));
}

function initialDocumentPath(): string {
  const { GIMPISH_SCENE: configured } = process.env;
  if (configured) return path.resolve(configured);
  const arg = process.argv.find(
    (value) => value.endsWith(".json") || value.toLowerCase().endsWith(BUNDLE_EXT),
  );
  if (arg) return path.resolve(arg);

  const workspace = path.join(app.getPath("userData"), "workspaces", "welcome");
  const scenePath = path.join(workspace, "scene.json");
  if (!existsSync(scenePath)) {
    mkdirSync(workspace, { recursive: true });
    const welcome = parseScene({
      canvas: { width: 1200, height: 675, background: "#111722ff" },
      layers: [
        {
          id: "card",
          type: "shape",
          shape: "rect",
          name: "card",
          rect: { x: 180, y: 150, w: 840, h: 375 },
          fill: "#23408eff",
          stroke: "#6d8cffff",
          stroke_width: 5,
        },
        {
          id: "headline",
          type: "text",
          name: "headline",
          text: {
            content: "Browser-owned Gimpish",
            x: 600,
            y: 285,
            align: "center",
            font: "Helvetica Neue",
            size: 82,
            weight: "800",
          },
        },
      ],
    });
    writeFileSync(scenePath, `${JSON.stringify(welcome, null, 2)}\n`);
  }
  return scenePath;
}

function loadDocument(scenePath: string, bundlePath?: string): OpenDocument {
  const resolved = path.resolve(scenePath);
  const scene = parseScene(JSON.parse(readFileSync(resolved, "utf8")));
  return {
    path: resolved,
    scene,
    revision: 0,
    ...(bundlePath ? { bundlePath: path.resolve(bundlePath) } : {}),
  };
}

function loadBundleDocument(bundlePath: string): OpenDocument {
  const resolvedBundle = path.resolve(bundlePath);
  const identity = createHash("sha256").update(resolvedBundle).digest("hex").slice(0, 12);
  const stem =
    path
      .basename(resolvedBundle, BUNDLE_EXT)
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "") || "bundle";
  const workspace = path.join(
    app.getPath("userData"),
    "workspaces",
    "bundles",
    `${stem}-${identity}`,
  );
  const scenePath = path.join(workspace, "scene.json");
  if (!existsSync(scenePath)) {
    mkdirSync(workspace, { recursive: true });
    extractBundle(readFileSync(resolvedBundle), scenePath);
  }
  return loadDocument(scenePath, resolvedBundle);
}

function loadDocumentPath(documentPath: string): OpenDocument {
  return documentPath.toLowerCase().endsWith(BUNDLE_EXT)
    ? loadBundleDocument(documentPath)
    : loadDocument(documentPath);
}

function persistScene(scene: unknown): OpenDocument {
  const parsed = parseScene(scene);
  const tmp = `${document.path}.electron-tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`);
  renameSync(tmp, document.path);
  document = { ...document, scene: parsed, revision: document.revision + 1 };
  return document;
}

function referencedAssetPaths(scene: Scene): Set<string> {
  const referenced = new Set<string>();
  for (const layer of scene.layers) {
    if (layer.type !== "image") continue;
    referenced.add(layer.source);
    if (layer.mask?.source) referenced.add(layer.mask.source);
    if (layer.mask?.cache) referenced.add(layer.mask.cache);
  }
  return referenced;
}

function saveBundleTo(bundlePath: string): string {
  const target = path.resolve(bundlePath);
  const bundle = createBundle({ path: document.path, scene: document.scene });
  const tmp = `${target}.electron-tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(tmp, bundle);
  renameSync(tmp, target);
  document = { ...document, bundlePath: target };
  win?.setTitle(`Gimpish — ${documentDisplayName()}`);
  return target;
}

async function ensureU2NetModel(): Promise<string> {
  if (existsSync(U2NET_MODEL_PATH)) return U2NET_MODEL_PATH;
  if (modelDownload) return modelDownload;
  modelDownload = (async () => {
    mkdirSync(path.dirname(U2NET_MODEL_PATH), { recursive: true });
    const response = await fetch(U2NET_MODEL_URL);
    if (!response.ok || !response.body) {
      throw new Error(`failed to download U²-Net: HTTP ${response.status}`);
    }
    const temporary = `${U2NET_MODEL_PATH}.download`;
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    renameSync(temporary, U2NET_MODEL_PATH);
    return U2NET_MODEL_PATH;
  })().finally(() => {
    modelDownload = null;
  });
  return modelDownload;
}

function sendRendererRequest(
  request: Omit<RendererRequest, "requestId">,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<RendererResponse> {
  if (!win || win.isDestroyed())
    return Promise.reject(new Error("no active Gimpish document window"));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`renderer did not answer ${request.kind} within ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    win?.webContents.send("document:command", { ...request, requestId });
  });
}

function registerIpc(): void {
  ipcMain.handle("document:load", () => ({
    path: document.path,
    scene: document.scene,
    revision: document.revision,
  }));

  ipcMain.handle("document:open", async () => {
    const options: OpenDialogOptions = {
      title: "Open Gimpish scene",
      properties: ["openFile"],
      filters: [
        { name: "Gimpish document", extensions: ["gimpish", "json"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;
    document = loadDocumentPath(selected);
    win?.setTitle(`Gimpish — ${documentDisplayName()}`);
    return { path: document.path, scene: document.scene, revision: document.revision };
  });

  ipcMain.handle("document:persist", (_event, scene: unknown) => {
    const saved = persistScene(scene);
    return { revision: saved.revision };
  });

  ipcMain.handle("bundle:save", async () => {
    let target = document.bundlePath;
    if (!target) {
      const options: SaveDialogOptions = {
        title: "Save Gimpish bundle",
        defaultPath: path.join(path.dirname(document.path), `${documentDisplayName()}.gimpish`),
        filters: [{ name: "Gimpish bundle", extensions: ["gimpish"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }
    return { path: saveBundleTo(target) };
  });

  ipcMain.handle("model:background", async () => {
    await ensureU2NetModel();
    return { url: `http://127.0.0.1:${MCP_PORT}/models/u2net.onnx` };
  });

  ipcMain.handle("asset:read", (_event, storedPath: string) => {
    if (typeof storedPath !== "string" || storedPath.length === 0)
      throw new Error("invalid asset path");
    if (!referencedAssetPaths(document.scene).has(storedPath)) {
      throw new Error("asset path is not referenced by the active scene");
    }
    const resolved = path.resolve(path.dirname(document.path), storedPath);
    const bytes = readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mimeType =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : "image/png";
    return { mimeType, data: bytes.toString("base64") };
  });

  ipcMain.handle("asset:import", (_event, name: unknown, data: unknown) => {
    if (typeof name !== "string" || typeof data !== "string") throw new Error("invalid asset");
    const extension = path.extname(name).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
      throw new Error(`unsupported image type: ${extension || "none"}`);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > 100 * 1024 * 1024) {
      throw new Error("image must be between 1 byte and 100 MB");
    }
    const assets = path.join(path.dirname(document.path), "assets");
    mkdirSync(assets, { recursive: true });
    const stem =
      path
        .basename(name, extension)
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-|-$/g, "") || "image";
    let filename = `${stem}${extension}`;
    let suffix = 2;
    while (existsSync(path.join(assets, filename))) {
      filename = `${stem}-${suffix}${extension}`;
      suffix += 1;
    }
    writeFileSync(path.join(assets, filename), bytes);
    return { path: `assets/${filename}` };
  });

  ipcMain.handle(
    "export:save",
    async (_event, data: unknown, suggestedName: unknown, mimeType: unknown) => {
      if (typeof data !== "string") throw new Error("invalid export data");
      const formats: Record<string, { extension: string; name: string }> = {
        "image/png": { extension: "png", name: "PNG image" },
        "image/jpeg": { extension: "jpg", name: "JPEG image" },
        "image/webp": { extension: "webp", name: "WebP image" },
      };
      const format = typeof mimeType === "string" ? formats[mimeType] : undefined;
      if (!format) throw new Error("unsupported export format");
      const safeName =
        typeof suggestedName === "string" && suggestedName.trim()
          ? path.basename(suggestedName)
          : `${path.basename(path.dirname(document.path))}.${format.extension}`;
      const options: SaveDialogOptions = {
        title: "Export image",
        defaultPath: path.join(path.dirname(document.path), safeName),
        filters: [{ name: format.name, extensions: [format.extension] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      writeFileSync(result.filePath, Buffer.from(data, "base64"));
      return { path: result.filePath };
    },
  );

  ipcMain.handle("document:command-result", (_event, raw: unknown) => {
    const response = raw as RendererResponse;
    const waiter = pending.get(response.requestId);
    if (!waiter) return { accepted: false };
    pending.delete(response.requestId);
    clearTimeout(waiter.timer);
    if (response.error) {
      waiter.reject(new Error(response.error));
      return { accepted: true };
    }
    if (response.scene) {
      const saved = persistScene(response.scene);
      response.scene = saved.scene;
    }
    waiter.resolve(response);
    return { accepted: true, revision: document.revision };
  });
}

function createWindow(): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#11131a",
    title: `Gimpish — ${documentDisplayName()}`,
    webPreferences: {
      preload: path.join(APP_ROOT, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void browserWindow.loadFile(path.join(APP_ROOT, "web/index.html"));
  browserWindow.on("closed", () => {
    win = null;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Gimpish document window closed"));
    }
    pending.clear();
  });
  return browserWindow;
}

function toolText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "gimpish", version: "0.2.0" });

  server.registerTool(
    "list_documents",
    { description: "List documents currently available through Gimpish." },
    async () =>
      toolText({
        documents: [
          {
            id: "active",
            name: documentDisplayName(),
            path: document.path,
            revision: document.revision,
            active: true,
          },
        ],
      }),
  );

  server.registerTool(
    "get_scene",
    { description: "Return the scene currently open in Gimpish." },
    async () =>
      toolText({ path: document.path, revision: document.revision, scene: document.scene }),
  );

  server.registerTool(
    "set_scene",
    {
      description:
        "Replace the active Gimpish scene with a complete scene object. The browser validates, applies, renders, and persists it.",
      inputSchema: { scene: z.unknown() },
    },
    async ({ scene }) => {
      const parsed = parseScene(scene);
      const response = await sendRendererRequest({ kind: "replace-scene", scene: parsed });
      return toolText({ revision: document.revision, receipt: response.receipt });
    },
  );

  server.registerTool(
    "transform_layer",
    {
      description: "Move, rotate, or scale a layer in the active Gimpish document.",
      inputSchema: {
        layerId: z.string(),
        dx: z.number().optional(),
        dy: z.number().optional(),
        drot: z.number().optional(),
        scale: z.number().positive().optional(),
      },
    },
    async ({ layerId, dx, dy, drot, scale }) => {
      const command = {
        kind: "transform-layer",
        layerId,
        ...(dx === undefined ? {} : { dx }),
        ...(dy === undefined ? {} : { dy }),
        ...(drot === undefined ? {} : { drot }),
        ...(scale === undefined ? {} : { scale }),
      } as DocumentCommand;
      const response = await sendRendererRequest({ kind: "apply-command", command });
      return toolText({ revision: document.revision, receipt: response.receipt });
    },
  );

  server.registerTool(
    "fit_layer",
    {
      description:
        "Fit, fill, or cover the canvas with an image layer at a percentage and anchor. The browser resolves the image dimensions and exact placement.",
      inputSchema: {
        layerId: z.string(),
        mode: z.enum(["fit", "fill", "cover"]).default("fit"),
        percent: z.number().positive().default(100),
        anchor: z.enum(ANCHORS).default("center"),
      },
    },
    async ({ layerId, mode, percent, anchor }) => {
      const response = await sendRendererRequest({
        kind: "apply-command",
        command: { kind: "fit-layer", layerId, mode, percent, anchor },
      });
      return toolText({ revision: document.revision, receipt: response.receipt });
    },
  );

  server.registerTool(
    "edit_layer",
    {
      description:
        "Edit common visual properties on one layer. Omitted properties stay unchanged; null removes blur, shadow, or adjustments.",
      inputSchema: {
        layerId: z.string(),
        name: z.string().optional(),
        opacity: z.number().min(0).max(1).optional(),
        visible: z.boolean().optional(),
        blend: z.enum(BLEND_MODES).optional(),
        blur: z.number().nonnegative().nullable().optional(),
        shadow: z
          .object({
            color: z.string().optional(),
            dx: z.number().optional(),
            dy: z.number().optional(),
            blur: z.number().nonnegative().optional(),
          })
          .nullable()
          .optional(),
        adjust: z
          .object({
            brightness: z.number().min(-100).max(100).optional(),
            contrast: z.number().min(-100).max(100).optional(),
            saturation: z.number().min(-100).max(100).optional(),
            exposure: z.number().min(-100).max(100).optional(),
            warmth: z.number().min(-100).max(100).optional(),
            hue: z.number().min(-180).max(180).optional(),
            shadows: z.number().min(-100).max(100).optional(),
            highlights: z.number().min(-100).max(100).optional(),
            clarity: z.number().min(0).max(100).optional(),
            sharpen: z.number().min(0).max(100).optional(),
          })
          .nullable()
          .optional(),
        adjustEnabled: z.boolean().optional(),
      },
    },
    async ({ layerId, ...patch }) => {
      const command = {
        kind: "edit-layer",
        layerId,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
        ...(patch.visible === undefined ? {} : { visible: patch.visible }),
        ...(patch.blend === undefined ? {} : { blend: patch.blend }),
        ...(patch.blur === undefined ? {} : { blur: patch.blur }),
        ...(patch.shadow === undefined ? {} : { shadow: patch.shadow }),
        ...(patch.adjust === undefined ? {} : { adjust: patch.adjust }),
        ...(patch.adjustEnabled === undefined ? {} : { adjustEnabled: patch.adjustEnabled }),
      } as DocumentCommand;
      const response = await sendRendererRequest({
        kind: "apply-command",
        command,
      });
      return toolText({ revision: document.revision, receipt: response.receipt });
    },
  );

  server.registerTool(
    "reorder_layer",
    {
      description: "Move a layer to an absolute paint-order index (0 is the back/bottom).",
      inputSchema: { layerId: z.string(), index: z.number().int().nonnegative() },
    },
    async ({ layerId, index }) => {
      const response = await sendRendererRequest({
        kind: "apply-command",
        command: { kind: "reorder-layer", layerId, index },
      });
      return toolText({ revision: document.revision, receipt: response.receipt });
    },
  );

  server.registerTool(
    "export_png",
    {
      description:
        "Render the active scene in the browser and write an exact-size PNG to a local path.",
      inputSchema: {
        out: z.string().min(1),
        width: z.number().int().positive().max(10000).optional(),
        height: z.number().int().positive().max(10000).optional(),
      },
    },
    async ({ out, width, height }) => {
      const response = await sendRendererRequest({
        kind: "render-image",
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      });
      if (!response.preview) throw new Error("renderer returned no PNG");
      const resolved = path.resolve(out);
      writeFileSync(resolved, Buffer.from(response.preview.data, "base64"));
      return toolText({
        out: resolved,
        width: response.preview.width,
        height: response.preview.height,
        revision: document.revision,
      });
    },
  );

  server.registerTool(
    "save_bundle",
    {
      description:
        "Pack the active browser-owned document and every referenced asset into a relocatable .gimpish bundle.",
      inputSchema: { out: z.string().min(1) },
    },
    async ({ out }) => toolText({ out: saveBundleTo(out), revision: document.revision }),
  );

  server.registerTool(
    "remove_background",
    {
      description:
        "Remove an image layer's background locally in the browser with U²-Net and attach the generated cutout mask.",
      inputSchema: { layerId: z.string().min(1) },
    },
    async ({ layerId }) => {
      const response = await sendRendererRequest(
        { kind: "remove-background", layerId },
        BACKGROUND_TIMEOUT_MS,
      );
      return toolText({ revision: document.revision, receipt: response.receipt });
    },
  );

  server.registerTool(
    "preview",
    {
      description: "Render the active Gimpish document and return an inline PNG preview.",
      inputSchema: { max: z.number().int().positive().max(2048).default(1024) },
    },
    async ({ max }) => {
      const response = await sendRendererRequest({ kind: "render-preview", max });
      if (!response.preview) throw new Error("renderer returned no preview");
      return {
        content: [
          {
            type: "image" as const,
            mimeType: response.preview.mimeType,
            data: response.preview.data,
          },
          {
            type: "text" as const,
            text: `browser-rendered preview ${response.preview.width}x${response.preview.height}, revision ${document.revision}`,
          },
        ],
      };
    },
  );

  for (const historyOp of ["undo", "redo"] as const) {
    server.registerTool(
      historyOp,
      { description: `${historyOp === "undo" ? "Undo" : "Redo"} the last document transaction.` },
      async () => {
        const response = await sendRendererRequest({ kind: "history", historyOp });
        return toolText({ revision: document.revision, receipt: response.receipt });
      },
    );
  }

  return server;
}

async function startMcpServer(): Promise<ReturnType<typeof createServer>> {
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host?.toLowerCase();
    if (host !== `127.0.0.1:${MCP_PORT}` && host !== `localhost:${MCP_PORT}`) {
      res.writeHead(403).end("forbidden host");
      return;
    }
    if (req.url === "/models/u2net.onnx") {
      if (req.method !== "GET") {
        res.writeHead(405).end("method not allowed");
        return;
      }
      void ensureU2NetModel()
        .then((modelPath) => {
          const size = statSync(modelPath).size;
          res.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "private, max-age=31536000, immutable",
            "Content-Length": size,
            "Content-Type": "application/octet-stream",
          });
          createReadStream(modelPath).pipe(res);
        })
        .catch((error: unknown) => {
          console.error("Model request failed", error);
          if (!res.headersSent) res.writeHead(500).end("model unavailable");
          else res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end("not found");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
      );
      return;
    }
    void (async () => {
      const server = createMcpServer();
      // The SDK's declaration is not exactOptionalPropertyTypes-clean:
      // stateless mode is documented as sessionIdGenerator: undefined, while
      // its property type excludes undefined. Keep that mismatch here.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      } as never);
      await server.connect(transport as unknown as Transport);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(req, res);
    })().catch((error: unknown) => {
      console.error("MCP request failed", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(MCP_PORT, "127.0.0.1", () => resolve());
  });
  return httpServer;
}

app.name = "Gimpish";
registerIpc();

let mcpHttp: ReturnType<typeof createServer> | null = null;
void app.whenReady().then(async () => {
  document = loadDocumentPath(initialDocumentPath());
  win = createWindow();
  mcpHttp = await startMcpServer();
  console.log(`Gimpish MCP: http://127.0.0.1:${MCP_PORT}/mcp`);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  mcpHttp?.close();
});

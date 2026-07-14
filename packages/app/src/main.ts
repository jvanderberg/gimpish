import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DocumentCommand,
  type EditReceipt,
  parseScene,
  type Scene,
} from "@gimpish/core/model";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { app, BrowserWindow, ipcMain } from "electron";
import { z } from "zod";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const MCP_PORT = 8767;
const COMMAND_TIMEOUT_MS = 30_000;

interface OpenDocument {
  path: string;
  scene: Scene;
  revision: number;
}

interface RendererRequest {
  requestId: string;
  kind: "apply-command" | "replace-scene" | "history" | "render-preview" | "render-image";
  command?: DocumentCommand;
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

function initialScenePath(): string {
  const { GIMPISH_SCENE: configured } = process.env;
  if (configured) return path.resolve(configured);
  const arg = process.argv.find((value) => value.endsWith(".json"));
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

function loadDocument(scenePath: string): OpenDocument {
  const resolved = path.resolve(scenePath);
  const scene = parseScene(JSON.parse(readFileSync(resolved, "utf8")));
  return { path: resolved, scene, revision: 0 };
}

function persistScene(scene: unknown): OpenDocument {
  const parsed = parseScene(scene);
  const tmp = `${document.path}.electron-tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`);
  renameSync(tmp, document.path);
  document = { ...document, scene: parsed, revision: document.revision + 1 };
  return document;
}

function sendRendererRequest(
  request: Omit<RendererRequest, "requestId">,
): Promise<RendererResponse> {
  if (!win || win.isDestroyed())
    return Promise.reject(new Error("no active Gimpish document window"));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`renderer did not answer ${request.kind} within ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);
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

  ipcMain.handle("document:persist", (_event, scene: unknown) => {
    const saved = persistScene(scene);
    return { revision: saved.revision };
  });

  ipcMain.handle("asset:read", (_event, storedPath: string) => {
    if (typeof storedPath !== "string" || storedPath.length === 0)
      throw new Error("invalid asset path");
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
    title: `Gimpish — ${path.basename(path.dirname(document.path))}`,
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
            name: path.basename(path.dirname(document.path)),
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
      const command: DocumentCommand = {
        kind: "transform-layer",
        layerId,
        ...(dx === undefined ? {} : { dx }),
        ...(dy === undefined ? {} : { dy }),
        ...(drot === undefined ? {} : { drot }),
        ...(scale === undefined ? {} : { scale }),
      };
      const response = await sendRendererRequest({ kind: "apply-command", command });
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
  document = loadDocument(initialScenePath());
  win = createWindow();
  mcpHttp = await startMcpServer();
  console.log(`Gimpish MCP: http://127.0.0.1:${MCP_PORT}/mcp`);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  mcpHttp?.close();
});

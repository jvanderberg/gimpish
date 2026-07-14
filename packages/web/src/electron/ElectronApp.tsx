import {
  applyDocumentCommand,
  type DocumentCommand,
  type EditReceipt,
  findLayer,
  parseScene,
  type Scene,
} from "@gimpish/core/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { electronApi, type RendererRequest, type RendererResponse } from "./api";
import { imageNaturalSize, renderScene } from "./render";

interface Point {
  x: number;
  y: number;
}

interface ActiveDrag {
  layerId: string;
  start: Point;
  base: Scene;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + size)));
  }
  return btoa(chunks.join(""));
}

function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height,
  };
}

function hitLayer(scene: Scene, point: Point): string | null {
  for (let i = scene.layers.length - 1; i >= 0; i -= 1) {
    const layer = scene.layers[i];
    if (!layer?.visible) continue;
    if (layer.type === "shape") {
      const r = layer.rect;
      if (point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h)
        return layer.id;
    } else if (layer.type === "text") {
      const t = layer.text;
      const width = Math.max(t.size, t.content.length * t.size * 0.62);
      const x = t.align === "center" ? t.x - width / 2 : t.align === "right" ? t.x - width : t.x;
      if (point.x >= x && point.x <= x + width && point.y >= t.y && point.y <= t.y + t.size * 1.3)
        return layer.id;
    } else if (layer.type === "image") {
      // Natural image bounds are resolved for transforms, but this conservative
      // hit region keeps the first vertical slice synchronous.
      if (point.x >= layer.transform.x && point.y >= layer.transform.y) return layer.id;
    }
  }
  return null;
}

export function ElectronApp() {
  const api = useMemo(() => electronApi(), []);
  const [scene, setScene] = useState<Scene | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [path, setPath] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const historyRef = useRef<{ undo: Scene[]; redo: Scene[] }>({ undo: [], redo: [] });
  const [historyDepths, setHistoryDepths] = useState({ undo: 0, redo: 0 });
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    document.title = "Gimpish";
    api
      .loadDocument()
      .then((snapshot) => {
        setScene(snapshot.scene);
        sceneRef.current = snapshot.scene;
        setPath(snapshot.path);
        setRevision(snapshot.revision);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api]);

  useEffect(() => {
    sceneRef.current = scene;
    const canvas = canvasRef.current;
    if (!canvas || !scene) return;
    void renderScene(canvas, scene, api).catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api, scene]);

  const persist = useCallback(
    async (next: Scene) => {
      const saved = await api.persistScene(next);
      setRevision(saved.revision);
    },
    [api],
  );

  const syncHistoryDepths = useCallback(() => {
    setHistoryDepths({
      undo: historyRef.current.undo.length,
      redo: historyRef.current.redo.length,
    });
  }, []);

  const recordBefore = useCallback(
    (before: Scene) => {
      const history = historyRef.current;
      history.undo.push(structuredClone(before));
      if (history.undo.length > 100) history.undo.shift();
      history.redo = [];
      syncHistoryDepths();
    },
    [syncHistoryDepths],
  );

  const applyHistory = useCallback(
    async (op: "undo" | "redo", save: boolean): Promise<Scene> => {
      const current = sceneRef.current;
      if (!current) throw new Error("document is not loaded");
      const history = historyRef.current;
      const source = op === "undo" ? history.undo : history.redo;
      const target = source.pop();
      if (!target) throw new Error(`nothing to ${op}`);
      const destination = op === "undo" ? history.redo : history.undo;
      destination.push(structuredClone(current));
      sceneRef.current = target;
      setScene(target);
      syncHistoryDepths();
      if (save) await persist(target);
      return target;
    },
    [persist, syncHistoryDepths],
  );

  const applyCommand = useCallback(
    async (
      command: DocumentCommand,
      save: boolean,
    ): Promise<{ scene: Scene; receipt: EditReceipt }> => {
      const current = sceneRef.current;
      if (!current) throw new Error("document is not loaded");
      let effective = command;
      const layer = findLayer(current, command.layerId);
      if (command.scale !== undefined && layer.type === "image" && !command.naturalSize) {
        effective = { ...command, naturalSize: await imageNaturalSize(api, layer.source) };
      }
      const result = applyDocumentCommand(current, effective);
      recordBefore(current);
      sceneRef.current = result.scene;
      setScene(result.scene);
      if (save) await persist(result.scene);
      return result;
    },
    [api, persist, recordBefore],
  );

  useEffect(() => {
    return api.onCommand((request: RendererRequest) => {
      const finish = async () => {
        let response: RendererResponse;
        try {
          if (request.kind === "apply-command") {
            if (!request.command) throw new Error("missing document command");
            const result = await applyCommand(request.command, false);
            response = {
              requestId: request.requestId,
              scene: result.scene,
              receipt: result.receipt,
            };
          } else if (request.kind === "replace-scene") {
            const before = sceneRef.current;
            if (!before) throw new Error("document is not loaded");
            const next = parseScene(request.scene);
            recordBefore(before);
            sceneRef.current = next;
            setScene(next);
            response = {
              requestId: request.requestId,
              scene: next,
              receipt: {
                summary: "replaced scene",
                operations: [{ kind: "replace-scene", before, after: structuredClone(next) }],
              },
            };
          } else if (request.kind === "history") {
            if (!request.historyOp) throw new Error("missing history operation");
            const before = sceneRef.current;
            if (!before) throw new Error("document is not loaded");
            const next = await applyHistory(request.historyOp, false);
            response = {
              requestId: request.requestId,
              scene: next,
              receipt: {
                summary: request.historyOp,
                operations: [{ kind: "replace-scene", before, after: structuredClone(next) }],
              },
            };
          } else {
            const current = sceneRef.current;
            if (!current) throw new Error("document is not loaded");
            const max = request.max ?? 1024;
            const scale = Math.min(1, max / Math.max(current.canvas.width, current.canvas.height));
            const width =
              request.kind === "render-image"
                ? (request.width ?? current.canvas.width)
                : Math.max(1, Math.round(current.canvas.width * scale));
            const height =
              request.kind === "render-image"
                ? (request.height ?? current.canvas.height)
                : Math.max(1, Math.round(current.canvas.height * scale));
            const preview = new OffscreenCanvas(width, height);
            await renderScene(preview, current, api, preview.width, preview.height);
            const blob = await preview.convertToBlob({ type: "image/png" });
            const data = await blobToBase64(blob);
            response = {
              requestId: request.requestId,
              preview: {
                mimeType: "image/png",
                data,
                width: preview.width,
                height: preview.height,
              },
            };
          }
        } catch (cause) {
          response = { requestId: request.requestId, error: errorMessage(cause) };
        }
        const ack = await api.completeCommand(response);
        if (ack.revision !== undefined) setRevision(ack.revision);
      };
      void finish();
    });
  }, [api, applyCommand, applyHistory, recordBefore]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const current = sceneRef.current;
    if (!canvas || !current) return;
    const point = canvasPoint(canvas, event.clientX, event.clientY);
    const layerId = hitLayer(current, point);
    setSelected(layerId);
    if (!layerId) return;
    canvas.setPointerCapture(event.pointerId);
    setDrag({ layerId, start: point, base: current });
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !drag) return;
      const point = canvasPoint(canvas, event.clientX, event.clientY);
      const command: DocumentCommand = {
        kind: "transform-layer",
        layerId: drag.layerId,
        dx: point.x - drag.start.x,
        dy: point.y - drag.start.y,
      };
      const result = applyDocumentCommand(drag.base, command);
      sceneRef.current = result.scene;
      setScene(result.scene);
    },
    [drag],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      setDrag(null);
      const current = sceneRef.current;
      if (drag && current) {
        recordBefore(drag.base);
        void persist(current).catch((cause: unknown) => setError(errorMessage(cause)));
      }
    },
    [drag, persist, recordBefore],
  );

  const selectedLayer =
    scene && selected ? scene.layers.find((layer) => layer.id === selected) : null;

  return (
    <div className="electron-app">
      <header className="electron-topbar">
        <div>
          <strong>gimpish</strong>
          <span>browser engine · rev {revision}</span>
        </div>
        <span className="electron-path">{path}</span>
        <div className="electron-history">
          <button
            type="button"
            disabled={historyDepths.undo === 0}
            onClick={() =>
              void applyHistory("undo", true).catch((cause) => setError(errorMessage(cause)))
            }
          >
            Undo
          </button>
          <button
            type="button"
            disabled={historyDepths.redo === 0}
            onClick={() =>
              void applyHistory("redo", true).catch((cause) => setError(errorMessage(cause)))
            }
          >
            Redo
          </button>
        </div>
      </header>
      <main className="electron-workspace">
        <section className="electron-stage">
          {scene ? (
            <canvas
              ref={canvasRef}
              className="electron-canvas"
              style={{ aspectRatio: `${scene.canvas.width} / ${scene.canvas.height}` }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          ) : (
            <div className="electron-loading">Loading document…</div>
          )}
        </section>
        <aside className="electron-panel">
          <h2>Layers</h2>
          {[...(scene?.layers ?? [])].reverse().map((layer) => (
            <button
              type="button"
              className={layer.id === selected ? "electron-layer selected" : "electron-layer"}
              key={layer.id}
              onClick={() => setSelected(layer.id)}
            >
              <strong>{layer.name || layer.id}</strong>
              <span>{layer.type}</span>
            </button>
          ))}
          {selectedLayer ? (
            <div className="electron-selection">
              Selected <strong>{selectedLayer.id}</strong>. Drag it directly on the canvas.
            </div>
          ) : null}
          <div className="electron-mcp">MCP: http://127.0.0.1:8767/mcp</div>
          {error ? <div className="err">{error}</div> : null}
        </aside>
      </main>
    </div>
  );
}

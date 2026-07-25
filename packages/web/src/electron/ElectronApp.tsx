import {
  applyDocumentCommand,
  type DocumentCommand,
  type EditReceipt,
  type ExportSettings,
  findLayer,
  type LayerBox,
  layerBox,
  moveLayerTo,
  parseScene,
  removeLayer,
  resolveExportCrop,
  rotatePoint,
  type Scene,
  uniqueId,
} from "@gimpish/core/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExportModal, type ExportModalRuntime } from "../components/ExportModal";
import {
  ICON_DOWNLOAD,
  ICON_IMPORT,
  ICON_REDO,
  ICON_REFRESH,
  ICON_UNDO,
} from "../components/icons";
import { LayerPanel } from "../components/LayerPanel";
import { useElementSize } from "../hooks/useElementSize";
import { containBox, preferredHitTest } from "../lib/geometry";
import { electronApi, type RendererRequest, type RendererResponse } from "./api";
import { removeBackgroundInWorker } from "./background-worker-client";
import {
  clearRendererCaches,
  imageNaturalSize,
  renderScene,
  sceneRendersResolutionIndependently,
} from "./render";
import { canvasFontFamily } from "./vector";

interface Point {
  x: number;
  y: number;
}

interface ActiveDrag {
  layerId: string;
  mode: "move" | "rotate" | "scale";
  start: Point;
  base: Scene;
  box: LayerBox;
  startAngle: number;
  startDistance: number;
}

type LayerBoxes = Map<string, LayerBox>;

const ZOOM_STEPS = [0.25, 0.5, 1, 2, 4] as const;
const ZOOM_LABELS: Readonly<Record<number, string>> = {
  0.25: "1:4",
  0.5: "1:2",
  1: "1:1",
  2: "2:1",
  4: "4:1",
};

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleFrom(origin: Point, point: Point): number {
  return Math.atan2(point.y - origin.y, point.x - origin.x);
}

function rotateAround(point: Point, origin: Point, degrees: number): Point {
  return rotatePoint(point.x, point.y, origin.x, origin.y, degrees);
}

function boxPoint(box: LayerBox, x: number, y: number): Point {
  return rotateAround({ x: box.cx + x, y: box.cy + y }, { x: box.cx, y: box.cy }, box.rotation);
}

function boxHandles(box: LayerBox, offset: number): { scale: Point[]; rotate: Point } {
  return {
    scale: [
      boxPoint(box, -box.w / 2, -box.h / 2),
      boxPoint(box, box.w / 2, -box.h / 2),
      boxPoint(box, box.w / 2, box.h / 2),
      boxPoint(box, -box.w / 2, box.h / 2),
    ],
    rotate: boxPoint(box, 0, -box.h / 2 - offset),
  };
}

function textLayerBox(scene: Scene, layerId: string): LayerBox | null {
  const layer = findLayer(scene, layerId);
  if (layer.type !== "text") return null;
  const t = layer.text;
  const measure = new OffscreenCanvas(1, 1).getContext("2d");
  if (!measure) return null;
  measure.font = `${t.style} ${t.weight} ${t.size}px ${canvasFontFamily(t.font)}`;
  measure.letterSpacing = `${t.letter_spacing}px`;
  const lines = t.content.split("\n");
  const width = Math.max(t.size * 0.25, ...lines.map((line) => measure.measureText(line).width));
  const height = Math.max(t.size, lines.length * t.size * t.line_height);
  const left = t.align === "center" ? t.x - width / 2 : t.align === "right" ? t.x - width : t.x;
  const unrotatedCenter = { x: left + width / 2, y: t.y + height / 2 };
  const center = rotateAround(unrotatedCenter, { x: t.x, y: t.y }, t.rotation);
  return {
    id: layer.id,
    type: layer.type,
    cx: center.x,
    cy: center.y,
    w: width,
    h: height,
    rotation: t.rotation,
    pivotx: t.x,
    pivoty: t.y,
    move: true,
    rotate: true,
    scale: true,
  };
}

async function resolveLayerBoxes(
  scene: Scene,
  api: ReturnType<typeof electronApi>,
): Promise<LayerBoxes> {
  const boxes: LayerBoxes = new Map();
  await Promise.all(
    scene.layers.map(async (layer) => {
      if (!layer.visible) return;
      if (layer.type === "text") {
        const resolved = textLayerBox(scene, layer.id);
        if (resolved) boxes.set(layer.id, resolved);
        return;
      }
      const resolved =
        layer.type === "image"
          ? layerBox(scene, layer, { naturalSize: await imageNaturalSize(api, layer.source) })
          : layerBox(scene, layer);
      if (resolved) boxes.set(layer.id, resolved);
    }),
  );
  return boxes;
}

function drawSelection(canvas: HTMLCanvasElement, box: LayerBox | undefined): void {
  if (!box) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cssScale = canvas.getBoundingClientRect().width / canvas.width || 1;
  const lineWidth = 1.5 / cssScale;
  const handleRadius = 5 / cssScale;
  const rotateOffset = 28 / cssScale;
  const handles = boxHandles(box, rotateOffset);

  ctx.save();
  ctx.strokeStyle = "#75a0ff";
  ctx.fillStyle = "#f7f9ff";
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([5 / cssScale, 3 / cssScale]);
  ctx.translate(box.cx, box.cy);
  ctx.rotate((box.rotation * Math.PI) / 180);
  ctx.strokeRect(-box.w / 2, -box.h / 2, box.w, box.h);
  ctx.beginPath();
  ctx.moveTo(0, -box.h / 2);
  ctx.lineTo(0, -box.h / 2 - rotateOffset);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = "#426fd4";
  ctx.fillStyle = "#f7f9ff";
  for (const point of handles.scale) {
    ctx.beginPath();
    ctx.rect(point.x - handleRadius, point.y - handleRadius, handleRadius * 2, handleRadius * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(handles.rotate.x, handles.rotate.y, handleRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function hitHandle(
  canvas: HTMLCanvasElement,
  box: LayerBox,
  point: Point,
): "rotate" | "scale" | null {
  const cssScale = canvas.getBoundingClientRect().width / canvas.width || 1;
  const radius = 10 / cssScale;
  const handles = boxHandles(box, 28 / cssScale);
  if (box.rotate && distance(point, handles.rotate) <= radius) return "rotate";
  if (box.scale && handles.scale.some((handle) => distance(point, handle) <= radius)) {
    return "scale";
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + size)));
  }
  return btoa(chunks.join(""));
}

function base64ToBuffer(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height,
  };
}

export function ElectronApp() {
  const api = useMemo(() => electronApi(), []);
  const [scene, setScene] = useState<Scene | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [path, setPath] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const [boxes, setBoxes] = useState<LayerBoxes>(new Map());
  const historyRef = useRef<{ undo: Scene[]; redo: Scene[] }>({ undo: [], redo: [] });
  const [historyDepths, setHistoryDepths] = useState({ undo: 0, redo: 0 });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreviewSrc, setExportPreviewSrc] = useState<string | null>(null);
  const exportPreviewUrl = useRef<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [zoom, setZoom] = useState(1);
  const { ref: canvasWrapRef, size: availableCanvas } = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const renderGeneration = useRef(0);

  const closeExport = useCallback(() => {
    setExportOpen(false);
    setExportPreviewSrc(null);
    if (exportPreviewUrl.current) URL.revokeObjectURL(exportPreviewUrl.current);
    exportPreviewUrl.current = null;
  }, []);

  useEffect(() => closeExport, [closeExport]);

  const stepZoom = useCallback((direction: number) => {
    setZoom((current) => {
      const currentIndex = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number]);
      const from = currentIndex < 0 ? ZOOM_STEPS.indexOf(1) : currentIndex;
      const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, from + direction));
      return ZOOM_STEPS[next] ?? 1;
    });
  }, []);

  const acceptSnapshot = useCallback((snapshot: Awaited<ReturnType<typeof api.loadDocument>>) => {
    clearRendererCaches();
    setScene(snapshot.scene);
    sceneRef.current = snapshot.scene;
    setPath(snapshot.path);
    setRevision(snapshot.revision);
    setSelected(null);
    historyRef.current = { undo: [], redo: [] };
    setHistoryDepths({ undo: 0, redo: 0 });
    setError(null);
  }, []);

  useEffect(() => {
    document.title = "Gimpish";
    api
      .loadDocument()
      .then(acceptSnapshot)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [acceptSnapshot, api]);

  useEffect(() => {
    sceneRef.current = scene;
    const canvas = canvasRef.current;
    if (!canvas || !scene) return;
    const generation = renderGeneration.current + 1;
    renderGeneration.current = generation;
    const surface = new OffscreenCanvas(scene.canvas.width, scene.canvas.height);
    void renderScene(surface, scene, api)
      .then(() => {
        if (renderGeneration.current !== generation || canvasRef.current !== canvas) return;
        canvas.width = surface.width;
        canvas.height = surface.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("2D canvas is unavailable");
        context.drawImage(surface, 0, 0);
        drawSelection(canvas, selected ? boxes.get(selected) : undefined);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api, boxes, scene, selected]);

  useEffect(() => {
    if (!scene) return;
    let active = true;
    void resolveLayerBoxes(scene, api)
      .then((next) => {
        if (active) setBoxes(next);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
    return () => {
      active = false;
    };
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
      if (
        layer.type === "image" &&
        ((command.kind === "transform-layer" &&
          command.scale !== undefined &&
          !command.naturalSize) ||
          (command.kind === "fit-layer" && !command.naturalSize))
      ) {
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

  const mutateScene = useCallback(
    (mutate: (draft: Scene) => void) => {
      const current = sceneRef.current;
      if (!current) return;
      const next = parseScene(structuredClone(current));
      mutate(next);
      const validated = parseScene(next);
      recordBefore(current);
      sceneRef.current = validated;
      setScene(validated);
      void persist(validated).catch((cause: unknown) => setError(errorMessage(cause)));
    },
    [persist, recordBefore],
  );

  const removeLayerBackground = useCallback(
    async (layerId: string, save: boolean): Promise<{ scene: Scene; receipt: EditReceipt }> => {
      const current = sceneRef.current;
      if (!current) throw new Error("document is not loaded");
      const layer = findLayer(current, layerId);
      if (layer.type !== "image") throw new Error("background removal requires an image layer");
      setNotice("Preparing local background removal…");
      const [{ url }, asset] = await Promise.all([
        api.backgroundModel(),
        api.readAsset(layer.source),
      ]);
      setNotice("Removing background locally…");
      const png = await removeBackgroundInWorker(url, asset.mimeType, base64ToBuffer(asset.data));
      const uploaded = await api.importAsset(
        `${layer.id}-cutout.png`,
        bytesToBase64(new Uint8Array(png)),
      );
      const next = parseScene(structuredClone(current));
      const updated = findLayer(next, layerId);
      if (updated.type !== "image") throw new Error("background removal requires an image layer");
      updated.mask = { kind: "cutout", cache: uploaded.path, feather: 0, invert: false };
      const validated = parseScene(next);
      recordBefore(current);
      sceneRef.current = validated;
      setScene(validated);
      if (save) await persist(validated);
      setNotice(`Removed background from ${layer.name || layer.id}`);
      return {
        scene: validated,
        receipt: {
          summary: `removed background from ${layer.id}`,
          operations: [
            { kind: "replace-scene", before: current, after: structuredClone(validated) },
          ],
        },
      };
    },
    [api, persist, recordBefore],
  );

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    mutateScene((draft) => removeLayer(draft, selected));
    setSelected(null);
  }, [mutateScene, selected]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault();
          const op = key === "y" || event.shiftKey ? "redo" : "undo";
          void applyHistory(op, true).catch((cause) => setError(errorMessage(cause)));
          return;
        }
        if (event.key === "=" || event.key === "+") {
          event.preventDefault();
          stepZoom(1);
          return;
        }
        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          stepZoom(-1);
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          setZoom(1);
        }
        return;
      }
      if (event.key === "Escape") {
        setSelected(null);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selected && !drag) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      const deltas: Record<string, Point> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      };
      const delta = deltas[event.key];
      const box = selected ? boxes.get(selected) : undefined;
      if (!delta || !selected || !box?.move || drag) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      void applyCommand(
        {
          kind: "transform-layer",
          layerId: selected,
          dx: delta.x * step,
          dy: delta.y * step,
        },
        true,
      ).catch((cause) => setError(errorMessage(cause)));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyCommand, applyHistory, boxes, deleteSelected, drag, selected, stepZoom]);

  useEffect(() => {
    return api.onCommand((request: RendererRequest) => {
      const finish = async () => {
        let response: RendererResponse;
        try {
          if (request.kind === "apply-command") {
            if (!request.command) throw new Error("missing document command");
            const result = await applyCommand(request.command, false);
            setSelected(request.command.layerId);
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
          } else if (request.kind === "remove-background") {
            if (!request.layerId) throw new Error("missing image layer id");
            const result = await removeLayerBackground(request.layerId, false);
            setSelected(request.layerId);
            response = {
              requestId: request.requestId,
              scene: result.scene,
              receipt: result.receipt,
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
            const crop =
              request.kind === "render-image" &&
              current.export &&
              width === current.export.width &&
              height === current.export.height
                ? resolveExportCrop(current.canvas, current.export)
                : undefined;
            await renderScene(preview, current, api, preview.width, preview.height, crop);
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
  }, [api, applyCommand, applyHistory, recordBefore, removeLayerBackground]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const current = sceneRef.current;
      if (!canvas || !current) return;
      const point = canvasPoint(canvas, event.clientX, event.clientY);
      const selectedBox = selected ? boxes.get(selected) : undefined;
      const selectedMode = selectedBox ? hitHandle(canvas, selectedBox, point) : null;
      const orderedBoxes = current.layers.flatMap((layer) => {
        const box = layer.visible ? boxes.get(layer.id) : undefined;
        return box ? [box] : [];
      });
      const layerId =
        selectedMode && selectedBox
          ? selectedBox.id
          : preferredHitTest(orderedBoxes, point, selected);
      setSelected(layerId);
      if (!layerId) return;
      const box = boxes.get(layerId);
      if (!box) return;
      const mode = selectedMode ?? "move";
      if ((mode === "move" && !box.move) || (mode === "rotate" && !box.rotate)) return;
      canvas.setPointerCapture(event.pointerId);
      const pivot = { x: box.pivotx, y: box.pivoty };
      setDrag({
        layerId,
        mode,
        start: point,
        base: current,
        box,
        startAngle: angleFrom(pivot, point),
        startDistance: Math.max(0.001, distance(pivot, point)),
      });
    },
    [boxes, selected],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !drag) return;
      const point = canvasPoint(canvas, event.clientX, event.clientY);
      const pivot = { x: drag.box.pivotx, y: drag.box.pivoty };
      const command: DocumentCommand = { kind: "transform-layer", layerId: drag.layerId };
      if (drag.mode === "move") {
        command.dx = point.x - drag.start.x;
        command.dy = point.y - drag.start.y;
      } else if (drag.mode === "rotate") {
        command.drot = ((angleFrom(pivot, point) - drag.startAngle) * 180) / Math.PI;
      } else {
        command.scale = distance(pivot, point) / drag.startDistance;
        const layer = findLayer(drag.base, drag.layerId);
        if (layer.type === "image") {
          command.naturalSize = {
            width: drag.box.w / layer.transform.scale,
            height: drag.box.h / layer.transform.scale,
          };
        }
      }
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

  const openDocument = useCallback(() => {
    void api
      .openDocument()
      .then((snapshot) => {
        if (snapshot) acceptSnapshot(snapshot);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [acceptSnapshot, api]);

  const saveBundle = useCallback(async () => {
    setNotice(null);
    const saved = await api.saveBundle();
    if (saved) setNotice(`Saved ${saved.path}`);
  }, [api]);

  const saveExportSettings = useCallback(
    async (settings: ExportSettings) => {
      const current = sceneRef.current;
      if (!current) throw new Error("document is not loaded");
      const next = parseScene({ ...structuredClone(current), export: settings });
      recordBefore(current);
      sceneRef.current = next;
      setScene(next);
      await persist(next);
      setNotice("Saved export settings");
    },
    [persist, recordBefore],
  );

  const exportDocument = useCallback(
    async (settings: ExportSettings) => {
      const current = sceneRef.current;
      if (!current) throw new Error("document is not loaded");
      const format = settings.format;
      const mimeType =
        format === "jpg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
      const output = new OffscreenCanvas(settings.width, settings.height);
      const crop = resolveExportCrop(current.canvas, settings);
      await renderScene(output, current, api, settings.width, settings.height, crop);
      const blob = await output.convertToBlob({
        type: mimeType,
        quality: settings.quality / 100,
      });
      const data = await blobToBase64(blob);
      const base = path.split(/[\\/]/).at(-2) || "gimpish";
      const extension = format === "jpg" ? "jpg" : format;
      const saved = await api.saveExport(data, `${base}.${extension}`, mimeType);
      if (saved) setNotice(`Exported ${saved.path}`);
    },
    [api, path],
  );

  const openExport = useCallback(() => {
    const current = sceneRef.current;
    if (!current || exporting) return;
    setExporting(true);
    setNotice(null);
    void (async () => {
      const preview = new OffscreenCanvas(current.canvas.width, current.canvas.height);
      await renderScene(preview, current, api);
      const blob = await preview.convertToBlob({ type: "image/png" });
      if (exportPreviewUrl.current) URL.revokeObjectURL(exportPreviewUrl.current);
      const url = URL.createObjectURL(blob);
      exportPreviewUrl.current = url;
      setExportPreviewSrc(url);
      setExportOpen(true);
    })()
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setExporting(false));
  }, [api, exporting]);

  const exportRuntime = useMemo<ExportModalRuntime | null>(
    () =>
      exportPreviewSrc
        ? {
            previewSrc: exportPreviewSrc,
            resolutionIndependent: scene ? sceneRendersResolutionIndependently(scene) : false,
            saveSettings: saveExportSettings,
            download: exportDocument,
            saveBundle,
          }
        : null,
    [exportDocument, exportPreviewSrc, saveBundle, saveExportSettings, scene],
  );

  const importFiles = useCallback(
    (files: FileList | File[]) => {
      void (async () => {
        for (const file of Array.from(files)) {
          if (!file.type.startsWith("image/") && !/\.(png|jpe?g|svg|webp)$/i.test(file.name)) {
            throw new Error(`${file.name} is not a supported image`);
          }
          const uploaded = await api.importAsset(file.name, await blobToBase64(file));
          const natural = await imageNaturalSize(api, uploaded.path);
          const current = sceneRef.current;
          if (!current) throw new Error("document is not loaded");
          let addedId = "";
          mutateScene((draft) => {
            addedId = uniqueId(draft, file.name.replace(/\.[^.]+$/, ""));
            const scale = Math.min(
              1,
              (draft.canvas.width * 0.8) / natural.width,
              (draft.canvas.height * 0.8) / natural.height,
            );
            const width = natural.width * scale;
            const height = natural.height * scale;
            draft.layers.push({
              id: addedId,
              name: file.name,
              type: "image",
              source: uploaded.path,
              transform: {
                x: (draft.canvas.width - width) / 2,
                y: (draft.canvas.height - height) / 2,
                scale,
                rotation: 0,
              },
              opacity: 1,
              blend: "normal",
              visible: true,
              adjustEnabled: true,
            });
          });
          setSelected(addedId);
          setNotice(`Added ${file.name}`);
        }
      })().catch((cause: unknown) => setError(errorMessage(cause)));
    },
    [api, mutateScene],
  );

  const displayedLayers = useMemo(() => [...(scene?.layers ?? [])].reverse(), [scene]);
  const selectedLayer = scene?.layers.find((layer) => layer.id === selected) ?? null;
  const canvasAspect = scene ? scene.canvas.width / scene.canvas.height : 1;
  const fittedCanvas = containBox(availableCanvas.w, availableCanvas.h, canvasAspect);
  const canvasFrame = { w: fittedCanvas.w * zoom, h: fittedCanvas.h * zoom };
  const zoomLabel = ZOOM_LABELS[zoom] ?? "1:1";

  const refreshDocument = useCallback(() => {
    void api
      .loadDocument()
      .then(acceptSnapshot)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [acceptSnapshot, api]);

  return (
    <div className="app">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(event) => {
          if (event.currentTarget.files) importFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: file drop target with an equivalent import button */}
      <div
        className="stage"
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDropActive(true);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropActive(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDropActive(false);
          importFiles(event.dataTransfer.files);
        }}
      >
        <div className="topbar">
          <h1>gimpish</h1>
          <span className="meta" title={path}>
            <span className="dot ok" />
            live
            {scene
              ? `  ·  ${scene.canvas.width}×${scene.canvas.height}  ·  bg ${scene.canvas.background}`
              : ""}
            {path ? `  ·  rev ${revision}` : ""}
          </span>
          <div className="actions">
            <button
              className="btn icon"
              type="button"
              title="Undo (⌘Z)"
              aria-label="Undo"
              disabled={historyDepths.undo === 0}
              onClick={() =>
                void applyHistory("undo", true).catch((cause) => setError(errorMessage(cause)))
              }
            >
              {ICON_UNDO}
            </button>
            <button
              className="btn icon"
              type="button"
              title="Redo (⇧⌘Z)"
              aria-label="Redo"
              disabled={historyDepths.redo === 0}
              onClick={() =>
                void applyHistory("redo", true).catch((cause) => setError(errorMessage(cause)))
              }
            >
              {ICON_REDO}
            </button>
            <div className="zoom">
              <button
                className="btn icon"
                type="button"
                title="Zoom out (⌘−)"
                aria-label="Zoom out"
                disabled={zoom <= ZOOM_STEPS[0]}
                onClick={() => stepZoom(-1)}
              >
                −
              </button>
              <button
                className="btn zoom-label"
                type="button"
                title="Reset zoom to fit (⌘0)"
                onClick={() => setZoom(1)}
              >
                {zoomLabel}
              </button>
              <button
                className="btn icon"
                type="button"
                title="Zoom in (⌘+)"
                aria-label="Zoom in"
                disabled={zoom >= (ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 4)}
                onClick={() => stepZoom(1)}
              >
                +
              </button>
            </div>
            <button
              className="btn"
              type="button"
              title="Open a scene or bundle"
              onClick={openDocument}
            >
              Open…
            </button>
            <button
              className="btn icon"
              type="button"
              title="Import images"
              aria-label="Import images"
              onClick={() => fileInputRef.current?.click()}
            >
              {ICON_IMPORT}
            </button>
            <button
              className="btn"
              type="button"
              disabled={!scene}
              onClick={() => void saveBundle().catch((cause) => setError(errorMessage(cause)))}
            >
              Save Bundle…
            </button>
            <button
              className="btn icon"
              type="button"
              title="Export"
              aria-label="Export"
              disabled={!scene || exporting}
              onClick={openExport}
            >
              {ICON_DOWNLOAD}
            </button>
            <button
              className="btn icon"
              type="button"
              title="Refresh"
              aria-label="Refresh"
              onClick={refreshDocument}
            >
              {ICON_REFRESH}
            </button>
          </div>
        </div>
        <div className="canvas-wrap" ref={canvasWrapRef}>
          {scene ? (
            <div
              className="electron-canvas-frame"
              style={{ width: `${canvasFrame.w}px`, height: `${canvasFrame.h}px` }}
            >
              <canvas
                ref={canvasRef}
                className="electron-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            </div>
          ) : (
            <div className="electron-loading">Loading document…</div>
          )}
        </div>
        {dropActive ? <div className="drop-overlay">Drop to import images as layers</div> : null}
        {notice ? (
          <div className="toasts">
            <div className="toast ok">{notice}</div>
          </div>
        ) : null}
      </div>
      <LayerPanel
        scene={scene}
        layers={displayedLayers}
        sel={selected}
        onSelect={(id) => setSelected((current) => (current === id ? null : id))}
        onDelete={(id) => {
          mutateScene((draft) => removeLayer(draft, id));
          if (selected === id) setSelected(null);
        }}
        onToggleAdjust={(id, enabled) =>
          mutateScene((draft) => {
            findLayer(draft, id).adjustEnabled = enabled;
          })
        }
        onToggleVisible={(id, visible) =>
          mutateScene((draft) => {
            findLayer(draft, id).visible = visible;
          })
        }
        onReorder={(id, index) => mutateScene((draft) => moveLayerTo(draft, id, index))}
        err={error}
        selLayer={selectedLayer}
      />
      {exportOpen && scene && exportRuntime ? (
        <ExportModal
          canvas={scene.canvas}
          scene={scene}
          ts={revision}
          onClose={closeExport}
          runtime={exportRuntime}
        />
      ) : null}
    </div>
  );
}

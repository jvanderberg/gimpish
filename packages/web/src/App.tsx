import type { DragEvent as ReactDragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteLayer,
  importFile,
  postHistoryOp,
  postTransform,
  previewUrl,
  reorderLayer,
  setLayerVisible,
  spriteUrl,
  type TransformDelta,
  toggleAdjust,
} from "./api";
import { ExportModal } from "./components/ExportModal";
import { LayerPanel } from "./components/LayerPanel";
import { Stage, type Toast } from "./components/Stage";
import { useDrag } from "./hooks/useDrag";
import { useElementSize } from "./hooks/useElementSize";
import { useLiveScene } from "./hooks/useLiveScene";
import { applyDragToBox, containBox, ghostStyleFor } from "./lib/geometry";

/** True when the drag payload contains OS files (vs an in-page drag). */
function hasFiles(e: ReactDragEvent): boolean {
  return (e.dataTransfer?.types ?? []).includes("Files");
}

const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

// Discrete zoom levels as a factor over the fit-to-window size. 1 (= "1:1") is
// the default fit view; below it the canvas shrinks (margin around it, so
// off-canvas handles come into reach), above it it enlarges for detail work.
const ZOOM_STEPS = [0.25, 0.5, 1, 2, 4];
const ZOOM_LABELS: Record<number, string> = {
  0.25: "1:4",
  0.5: "1:2",
  1: "1:1",
  2: "2:1",
  4: "4:1",
};

export function App() {
  const { scene, geometry, history, err, setErr, ts, live, refresh } = useLiveScene();
  const [sel, setSel] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const { ref: wrapRef, size: avail } = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);

  const canvas = scene?.canvas;
  const cw = canvas?.width ?? 1;
  const ch = canvas?.height ?? 1;
  const [zoom, setZoom] = useState(1);
  const fit = containBox(avail.w, avail.h, cw / ch);
  const frame = { w: fit.w * zoom, h: fit.h * zoom };
  const k = frame.w > 0 ? cw / frame.w : 1;

  const stepZoom = useCallback((dir: number) => {
    setZoom((z) => {
      const i = ZOOM_STEPS.indexOf(z);
      const from = i < 0 ? ZOOM_STEPS.indexOf(1) : i;
      const j = Math.max(0, Math.min(ZOOM_STEPS.length - 1, from + dir));
      return ZOOM_STEPS[j] ?? 1;
    });
  }, []);
  const zoomLabel = ZOOM_LABELS[zoom] ?? "1:1";
  const canZoomIn = zoom < (ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 4);
  const canZoomOut = zoom > (ZOOM_STEPS[0] ?? 0.25);

  const boxes = geometry.boxes;
  const rawSelBox = useMemo(() => boxes.find((b) => b.id === sel) ?? null, [boxes, sel]);

  const onCommit = useCallback(
    (id: string, delta: TransformDelta) => {
      postTransform(id, delta).catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e));
      });
      // The save trips the file watcher -> ws reload -> refresh(); no manual refetch.
    },
    [setErr],
  );

  const { drag, onPointerDown, onPointerMove, onPointerUp } = useDrag({
    svgRef,
    boxes,
    selBox: rawSelBox,
    setSel,
    k,
    onCommit,
  });

  const selBox = rawSelBox ? applyDragToBox(rawSelBox, drag) : null;

  // Arrow-key nudge for the selection (1px, Shift = 10px). Esc deselects.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSel(null);
        return;
      }
      if (!rawSelBox?.move || drag) return;
      const step = e.shiftKey ? 10 : 1;
      const d = ARROW_DELTAS[e.key];
      if (!d) return;
      e.preventDefault();
      onCommit(rawSelBox.id, { dx: d[0] * step, dy: d[1] * step });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rawSelBox, drag, onCommit]);

  const previewSrc = drag ? previewUrl(drag.stamp, drag.id) : previewUrl(ts);
  const ghostSrc = sel ? spriteUrl(sel, ts) : null;
  const ghostStyle = ghostStyleFor(drag, selBox !== null, k);

  // ---- file import (drag-drop + upload button) --------------------------------

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const toastSeq = useRef(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const pushToast = useCallback((text: string, kind: Toast["kind"]) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((list) => [...list.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 8000);
  }, []);

  const importFiles = useCallback(
    async (files: Iterable<File>) => {
      for (const file of files) {
        try {
          const result = await importFile(file);
          if (result.kind === "image") {
            // Surface the exact handle an agent session sees in scene.json.
            pushToast(`added layer '${result.id}' — ${result.source}`, "ok");
            setSel(result.id);
          } else {
            pushToast(`opened ${file.name} (${result.layers} layers)`, "ok");
            setSel(null);
          }
        } catch (e) {
          pushToast(`${file.name}: ${e instanceof Error ? e.message : String(e)}`, "err");
        }
      }
    },
    [pushToast],
  );

  const onDelete = useCallback(
    (id: string) => {
      deleteLayer(id)
        .then(() => {
          pushToast(`deleted layer '${id}'`, "ok");
          setSel((s) => (s === id ? null : s));
        })
        .catch((e: unknown) => {
          pushToast(`delete '${id}': ${e instanceof Error ? e.message : String(e)}`, "err");
        });
    },
    [pushToast],
  );

  const onReorder = useCallback(
    (id: string, index: number) => {
      reorderLayer(id, index).catch((e: unknown) => {
        pushToast(`reorder '${id}': ${e instanceof Error ? e.message : String(e)}`, "err");
      });
    },
    [pushToast],
  );

  const onToggleAdjust = useCallback(
    (id: string, enabled: boolean) => {
      toggleAdjust(id, enabled).catch((e: unknown) => {
        pushToast(`adjust toggle '${id}': ${e instanceof Error ? e.message : String(e)}`, "err");
      });
    },
    [pushToast],
  );

  const onToggleVisible = useCallback(
    (id: string, visible: boolean) => {
      setLayerVisible(id, visible).catch((e: unknown) => {
        pushToast(`visibility '${id}': ${e instanceof Error ? e.message : String(e)}`, "err");
      });
    },
    [pushToast],
  );

  const onHistory = useCallback(
    (op: "undo" | "redo") => {
      // The write trips the watcher -> ws reload; scene + depths refresh themselves.
      postHistoryOp(op).catch((e: unknown) => {
        pushToast(e instanceof Error ? e.message : String(e), "err");
      });
    },
    [pushToast],
  );

  // Delete/Backspace removes the selected layer; Cmd/Ctrl+Z undoes (Shift or Y = redo).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === "z" || key === "y") {
          e.preventDefault();
          onHistory(key === "y" || e.shiftKey ? "redo" : "undo");
          return;
        }
        // Editor zoom (overrides the browser's page zoom on ⌘/Ctrl +/−/0).
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          stepZoom(1);
          return;
        }
        if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          stepZoom(-1);
          return;
        }
        if (e.key === "0") {
          e.preventDefault();
          setZoom(1);
          return;
        }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!sel || drag) return;
      e.preventDefault();
      onDelete(sel);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, drag, onDelete, onHistory, stepZoom]);

  const onDragEnter = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDropActive(true);
  }, []);
  const onDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (hasFiles(e)) e.preventDefault();
  }, []);
  const onDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  }, []);
  const onDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDropActive(false);
      void importFiles(Array.from(e.dataTransfer.files));
    },
    [importFiles],
  );

  const layers = scene ? [...scene.layers].reverse() : [];
  const selLayer = scene?.layers.find((l) => l.id === sel) ?? null;

  return (
    <div className="app">
      <input
        ref={fileInput}
        type="file"
        accept="image/*,.gimpish"
        multiple
        hidden
        onChange={(e) => {
          void importFiles(Array.from(e.target.files ?? []));
          e.target.value = ""; // allow re-picking the same file
        }}
      />
      <Stage
        canvas={canvas}
        frame={frame}
        wrapRef={wrapRef}
        svgRef={svgRef}
        previewSrc={previewSrc}
        ghostSrc={ghostSrc}
        ghostStyle={ghostStyle}
        selBox={selBox}
        k={k}
        live={live}
        dropActive={dropActive}
        toasts={toasts}
        history={history}
        zoomLabel={zoomLabel}
        canZoomIn={canZoomIn}
        canZoomOut={canZoomOut}
        onZoomIn={() => stepZoom(1)}
        onZoomOut={() => stepZoom(-1)}
        onZoomReset={() => setZoom(1)}
        onExportOpen={() => setExportOpen(true)}
        onHistory={onHistory}
        onRefresh={() => void refresh()}
        onImportClick={() => fileInput.current?.click()}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <LayerPanel
        scene={scene}
        layers={layers}
        sel={sel}
        onSelect={(id) => setSel((s) => (s === id ? null : id))}
        onDelete={onDelete}
        onToggleAdjust={onToggleAdjust}
        onToggleVisible={onToggleVisible}
        onReorder={onReorder}
        err={err}
        selLayer={selLayer}
      />
      {exportOpen && canvas ? (
        <ExportModal canvas={canvas} scene={scene} ts={ts} onClose={() => setExportOpen(false)} />
      ) : null}
    </div>
  );
}

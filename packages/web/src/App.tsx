import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postTransform, previewUrl, spriteUrl, type TransformDelta } from "./api";
import { LayerPanel } from "./components/LayerPanel";
import { Stage } from "./components/Stage";
import { useDrag } from "./hooks/useDrag";
import { useElementSize } from "./hooks/useElementSize";
import { useLiveScene } from "./hooks/useLiveScene";
import { applyDragToBox, containBox, ghostStyleFor } from "./lib/geometry";

const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function App() {
  const { scene, geometry, err, setErr, ts, live, refresh } = useLiveScene();
  const [sel, setSel] = useState<string | null>(null);
  const { ref: wrapRef, size: avail } = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);

  const canvas = scene?.canvas;
  const cw = canvas?.width ?? 1;
  const ch = canvas?.height ?? 1;
  const frame = containBox(avail.w, avail.h, cw / ch);
  const k = frame.w > 0 ? cw / frame.w : 1;

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
      if (!rawSelBox || drag) return;
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

  const layers = scene ? [...scene.layers].reverse() : [];
  const selLayer = scene?.layers.find((l) => l.id === sel) ?? null;

  return (
    <div className="app">
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
        onRefresh={() => void refresh()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <LayerPanel
        scene={scene}
        layers={layers}
        sel={sel}
        onSelect={setSel}
        err={err}
        selLayer={selLayer}
      />
    </div>
  );
}

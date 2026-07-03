import type { DragEvent as ReactDragEvent } from "react";
import { useCallback, useState } from "react";
import type { Layer, Scene } from "../api";
import { layerSubtitle, shapeIcon } from "../lib/layerDisplay";
import { Readout } from "./Readout";

interface LayerRowProps {
  layer: Layer;
  selected: boolean;
  dragging: boolean;
  dropAbove: boolean;
  dropBelow: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverRow: (e: ReactDragEvent<HTMLElement>) => void;
  onDrop: () => void;
}

function LayerRow({
  layer,
  selected,
  dragging,
  dropAbove,
  dropBelow,
  onSelect,
  onDelete,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDrop,
}: LayerRowProps) {
  const classes = [
    "layer-row",
    layer.visible ? "" : "hidden",
    selected ? "sel" : "",
    dragging ? "dragging" : "",
    dropAbove ? "drop-above" : "",
    dropBelow ? "drop-below" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <button
        type="button"
        className="layer"
        draggable
        onClick={() => onSelect(layer.id)}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-gimpish-layer", layer.id);
          e.dataTransfer.effectAllowed = "move";
          onDragStart(layer.id);
        }}
        onDragEnd={onDragEnd}
        onDragOver={onDragOverRow}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
      >
        <div className="swatch">{shapeIcon(layer)}</div>
        <div className="info">
          <div className="name">{layer.name || layer.id}</div>
          <div className="sub">
            <span className="tag">{layer.type}</span>
            {layer.blend !== "normal" ? <span className="tag">{layer.blend}</span> : null}
            {layer.opacity < 1 ? (
              <span className="tag">{Math.round(layer.opacity * 100)}%</span>
            ) : null}
            {layerSubtitle(layer)}
          </div>
        </div>
      </button>
      <button
        type="button"
        className="del"
        title={`Delete layer '${layer.id}'`}
        onClick={() => onDelete(layer.id)}
      >
        ×
      </button>
    </div>
  );
}

interface LayerPanelProps {
  scene: Scene | null;
  layers: Layer[]; // displayed order: top (front) first
  sel: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** `index` uses `layer move --to` semantics: paint-order slot after removal, 0 = back. */
  onReorder: (id: string, index: number) => void;
  err: string | null;
  selLayer: Layer | null;
}

/** Right 320px panel: layer list (drag to reorder, × to delete) + transform readout. */
export function LayerPanel({
  scene,
  layers,
  sel,
  onSelect,
  onDelete,
  onReorder,
  err,
  selLayer,
}: LayerPanelProps) {
  // Reorder state: dragId is the layer being dragged; gap is the insertion
  // slot in displayed coordinates (0 = above the top row … n = below the last).
  const [dragId, setDragId] = useState<string | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const n = layers.length;

  const clearDrag = useCallback(() => {
    setDragId(null);
    setGap(null);
  }, []);

  const commitDrop = useCallback(() => {
    if (dragId !== null && gap !== null) {
      const pFrom = layers.findIndex((l) => l.id === dragId);
      if (pFrom >= 0) {
        const i = n - 1 - pFrom; // paint index of the dragged layer
        const paintGap = n - gap; // insertion slot in paint order, 0..n
        const j = paintGap > i ? paintGap - 1 : paintGap; // slot after removal
        if (j !== i) onReorder(dragId, j);
      }
    }
    clearDrag();
  }, [dragId, gap, layers, n, onReorder, clearDrag]);

  /** Hovering the top half of a row targets the gap above it; bottom half, below. */
  const dragOverRow = useCallback(
    (p: number) => (e: ReactDragEvent<HTMLElement>) => {
      if (dragId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      setGap(e.clientY < r.top + r.height / 2 ? p : p + 1);
    },
    [dragId],
  );

  return (
    <div className="panel">
      <h2>Layers {scene ? `(${scene.layers.length})` : ""}</h2>
      {err ? <div className="err">{err}</div> : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for the row drag; the same reorder is reachable per-row */}
      <div
        className="layers"
        onDragOver={(e) => {
          // Below the last row (or empty space): target the very back.
          if (dragId === null) return;
          e.preventDefault();
          if (e.target === e.currentTarget) setGap(n);
        }}
        onDrop={(e) => {
          e.preventDefault();
          commitDrop();
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget) setGap(null);
        }}
      >
        {layers.length === 0 && !err ? <div className="empty">No layers yet.</div> : null}
        {layers.map((l, p) => (
          <LayerRow
            key={l.id}
            layer={l}
            selected={l.id === sel}
            dragging={l.id === dragId}
            dropAbove={gap === p}
            dropBelow={p === n - 1 && gap === n}
            onSelect={onSelect}
            onDelete={onDelete}
            onDragStart={setDragId}
            onDragEnd={clearDrag}
            onDragOverRow={dragOverRow(p)}
            onDrop={commitDrop}
          />
        ))}
      </div>
      {selLayer ? (
        <div className="xform">
          <b>{selLayer.name || selLayer.id}</b> — {selLayer.type}
          <br />
          <Readout layer={selLayer} />
        </div>
      ) : null}
      <div className="hint">
        Click a layer to select · drag rows to reorder · × or Delete key removes · drag on canvas
        moves · top handle rotates · arrows nudge · Esc clears.
      </div>
    </div>
  );
}

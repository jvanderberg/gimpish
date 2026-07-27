import type { Layer, Scene, TextLayer, TextPatch } from "@gimpish/core/model";
import type { DragEvent as ReactDragEvent, FocusEvent as ReactFocusEvent } from "react";
import { useCallback, useState } from "react";
import { adjustSubtitle, layerSubtitle, shapeIcon } from "../lib/layerDisplay";
import { ICON_EYE, ICON_EYE_OFF } from "./icons";
import { Readout } from "./Readout";

interface LayerRowProps {
  layer: Layer;
  selected: boolean;
  dragging: boolean;
  dropAbove: boolean;
  dropBelow: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleAdjust: (id: string, enabled: boolean) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
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
  onToggleAdjust,
  onToggleVisible,
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

  const hasAdjust = !!layer.adjust && adjustSubtitle(layer) !== "";
  const adjustOff = hasAdjust && layer.adjustEnabled === false;
  const adjSummary = hasAdjust ? adjustSubtitle(layer) : "";
  const adjTooltip = hasAdjust
    ? `${adjSummary} (${adjustOff ? "off — click to enable" : "on — click to bypass"})`
    : "";

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
        className={`vis-toggle ${layer.visible ? "on" : "off"}`}
        title={layer.visible ? "Hide layer" : "Show layer"}
        aria-label={layer.visible ? `Hide layer '${layer.id}'` : `Show layer '${layer.id}'`}
        aria-pressed={!layer.visible}
        onClick={() => onToggleVisible(layer.id, !layer.visible)}
      >
        {layer.visible ? ICON_EYE : ICON_EYE_OFF}
      </button>
      {hasAdjust ? (
        <button
          type="button"
          className={`adj-toggle ${adjustOff ? "off" : "on"}`}
          title={adjTooltip}
          onClick={() => onToggleAdjust(layer.id, adjustOff)}
        >
          {adjustOff ? "◐" : "◑"}
        </button>
      ) : null}
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
  onToggleAdjust: (id: string, enabled: boolean) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  onEditText: (id: string, patch: TextPatch) => void;
  /** `index` uses `layer move --to` semantics: paint-order slot after removal, 0 = back. */
  onReorder: (id: string, index: number) => void;
  err: string | null;
  selLayer: Layer | null;
}

function TextControls({ layer, onEdit }: { layer: TextLayer; onEdit: (patch: TextPatch) => void }) {
  const text = layer.text;
  const numberPatch =
    (key: "size" | "letter_spacing") => (event: ReactFocusEvent<HTMLInputElement>) => {
      const value = Number(event.currentTarget.value);
      if (Number.isFinite(value)) onEdit({ [key]: value });
    };
  const arcNumberPatch =
    (key: "radius" | "angle") => (event: ReactFocusEvent<HTMLInputElement>) => {
      const value = Number(event.currentTarget.value);
      if (Number.isFinite(value)) onEdit({ arc: { [key]: value } });
    };

  return (
    <div className="text-controls">
      <label>
        Text
        <input
          type="text"
          defaultValue={text.content}
          onBlur={(event) => onEdit({ content: event.currentTarget.value })}
        />
      </label>
      <div className="text-control-grid">
        <label>
          Font
          <input
            type="text"
            defaultValue={text.font}
            onBlur={(event) => onEdit({ font: event.currentTarget.value })}
          />
        </label>
        <label>
          Weight
          <input
            type="text"
            defaultValue={text.weight}
            onBlur={(event) => onEdit({ weight: event.currentTarget.value })}
          />
        </label>
        <label>
          Stretch
          <select
            value={text.stretch}
            onChange={(event) =>
              onEdit({
                stretch: event.currentTarget.value as typeof text.stretch,
              })
            }
          >
            <option value="ultra-condensed">Ultra condensed</option>
            <option value="extra-condensed">Extra condensed</option>
            <option value="condensed">Condensed</option>
            <option value="semi-condensed">Semi condensed</option>
            <option value="normal">Normal</option>
            <option value="semi-expanded">Semi expanded</option>
            <option value="expanded">Expanded</option>
          </select>
        </label>
        <label>
          Size
          <input type="number" min="1" defaultValue={text.size} onBlur={numberPatch("size")} />
        </label>
        <label>
          Tracking
          <input
            type="number"
            defaultValue={text.letter_spacing}
            onBlur={numberPatch("letter_spacing")}
          />
        </label>
      </div>
      <label className="text-arc-toggle">
        <input
          type="checkbox"
          checked={!!text.arc}
          onChange={(event) =>
            onEdit({
              arc: event.currentTarget.checked
                ? { radius: Math.max(100, text.size * 2), angle: -90, direction: "clockwise" }
                : null,
            })
          }
        />
        Arc text
      </label>
      {text.arc ? (
        <div className="text-control-grid">
          <label>
            Radius
            <input
              type="number"
              min="1"
              defaultValue={text.arc.radius}
              onBlur={arcNumberPatch("radius")}
            />
          </label>
          <label>
            Angle
            <input type="number" defaultValue={text.arc.angle} onBlur={arcNumberPatch("angle")} />
          </label>
          <label>
            Direction
            <select
              value={text.arc.direction}
              onChange={(event) =>
                onEdit({
                  arc: {
                    direction: event.currentTarget.value as "clockwise" | "counterclockwise",
                  },
                })
              }
            >
              <option value="clockwise">Clockwise</option>
              <option value="counterclockwise">Counterclockwise</option>
            </select>
          </label>
        </div>
      ) : null}
    </div>
  );
}

/** Right 320px panel: layer list (drag to reorder, × to delete) + transform readout. */
export function LayerPanel({
  scene,
  layers,
  sel,
  onSelect,
  onDelete,
  onToggleAdjust,
  onToggleVisible,
  onEditText,
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
            onToggleAdjust={onToggleAdjust}
            onToggleVisible={onToggleVisible}
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
          {selLayer.type === "text" ? (
            <TextControls
              key={JSON.stringify(selLayer.text)}
              layer={selLayer}
              onEdit={(patch) => onEditText(selLayer.id, patch)}
            />
          ) : null}
        </div>
      ) : null}
      <div className="hint">
        Click a layer to select · drag rows to reorder · × or Delete key removes · drag on canvas
        moves · top handle rotates · arrows nudge · Esc clears.
      </div>
    </div>
  );
}

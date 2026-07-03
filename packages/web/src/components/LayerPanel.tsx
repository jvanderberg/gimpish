import type { Layer, Scene } from "../api";
import { layerSubtitle, shapeIcon } from "../lib/layerDisplay";
import { Readout } from "./Readout";

interface LayerRowProps {
  layer: Layer;
  selected: boolean;
  onSelect: (id: string) => void;
}

function LayerRow({ layer, selected, onSelect }: LayerRowProps) {
  const classes = ["layer", layer.visible ? "" : "hidden", selected ? "sel" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={classes} onClick={() => onSelect(layer.id)}>
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
  );
}

interface LayerPanelProps {
  scene: Scene | null;
  layers: Layer[];
  sel: string | null;
  onSelect: (id: string) => void;
  err: string | null;
  selLayer: Layer | null;
}

/** Right 320px panel: layer list, transform readout, and the hint line. */
export function LayerPanel({ scene, layers, sel, onSelect, err, selLayer }: LayerPanelProps) {
  return (
    <div className="panel">
      <h2>Layers {scene ? `(${scene.layers.length})` : ""}</h2>
      {err ? <div className="err">{err}</div> : null}
      <div className="layers">
        {layers.length === 0 && !err ? <div className="empty">No layers yet.</div> : null}
        {layers.map((l) => (
          <LayerRow key={l.id} layer={l} selected={l.id === sel} onSelect={onSelect} />
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
        Click a layer to select · drag to move · top handle rotates · arrows nudge · Esc clears.
        Radial gradients move their center; linear gradients rotate their angle.
      </div>
    </div>
  );
}

import type { Layer } from "../api";

interface ReadoutProps {
  layer: Layer;
}

/** Monospace transform readout for the selected layer, shaped per type. */
export function Readout({ layer }: ReadoutProps) {
  switch (layer.type) {
    case "image": {
      const t = layer.transform;
      return (
        <>
          x <b>{t.x.toFixed(1)}</b> y <b>{t.y.toFixed(1)}</b> scale <b>{t.scale.toPrecision(3)}</b>{" "}
          rot <b>{t.rotation.toFixed(1)}°</b>
        </>
      );
    }
    case "text": {
      const t = layer.text;
      return (
        <>
          x <b>{t.x.toFixed(1)}</b> y <b>{t.y.toFixed(1)}</b> rot{" "}
          <b>{(t.rotation ?? 0).toFixed(1)}°</b>
        </>
      );
    }
    case "arrow": {
      const a = layer.arrow;
      return (
        <>
          (<b>{a.from_x.toFixed(0)}</b>, <b>{a.from_y.toFixed(0)}</b>) → (<b>{a.to_x.toFixed(0)}</b>
          , <b>{a.to_y.toFixed(0)}</b>)
        </>
      );
    }
    case "shape": {
      const r = layer.rect;
      return (
        <>
          x <b>{r.x.toFixed(1)}</b> y <b>{r.y.toFixed(1)}</b> rot{" "}
          <b>{(r.rotation ?? 0).toFixed(1)}°</b>
        </>
      );
    }
    case "gradient": {
      const g = layer.gradient;
      return g.kind === "radial" ? (
        <>radial · drag to move center</>
      ) : (
        <>
          linear · <b>{(g.angle ?? 0).toFixed(1)}°</b> · handle rotates
        </>
      );
    }
  }
}

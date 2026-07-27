import { findLayer, type LayerBox, layerBox, rotatePoint, type Scene } from "@gimpish/core/model";
import { type BrowserRenderApi, imageNaturalSize } from ".";
import { measureTextLocalBounds } from "./text";

export type LayerBoxes = Map<string, LayerBox>;

function textLayerBox(scene: Scene, layerId: string): LayerBox | null {
  const layer = findLayer(scene, layerId);
  if (layer.type !== "text") return null;
  const t = layer.text;
  const measure = new OffscreenCanvas(1, 1).getContext("2d");
  if (!measure) return null;
  const bounds = measureTextLocalBounds(measure, t);
  const center = rotatePoint(
    t.x + bounds.left + bounds.width / 2,
    t.y + bounds.top + bounds.height / 2,
    t.x,
    t.y,
    t.rotation,
  );
  return {
    id: layer.id,
    type: layer.type,
    cx: center.x,
    cy: center.y,
    w: bounds.width,
    h: bounds.height,
    rotation: t.rotation,
    pivotx: t.x,
    pivoty: t.y,
    move: true,
    rotate: true,
    scale: true,
  };
}

/** Resolve selection geometry with the same browser asset/font metrics as rendering. */
export async function resolveLayerBoxes(scene: Scene, api: BrowserRenderApi): Promise<LayerBoxes> {
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

/** Browser-safe document commands shared by direct UI, IPC, CLI, and MCP. */

import { applyMove, applyRotate, applyScale } from "./editor.ts";
import { type FitMode, resolveFit } from "./geometry.ts";
import {
  type Adjust,
  findLayer,
  moveLayerTo,
  parseScene,
  type Scene,
  type Shadow,
  type TextArc,
  type TextSpec,
} from "./schema.ts";

export interface TransformLayerCommand {
  kind: "transform-layer";
  layerId: string;
  dx?: number;
  dy?: number;
  drot?: number;
  scale?: number;
  naturalSize?: { width: number; height: number };
}

export interface FitLayerCommand {
  kind: "fit-layer";
  layerId: string;
  mode: FitMode;
  percent: number;
  anchor: string;
  naturalSize?: { width: number; height: number };
}

export interface EditLayerCommand {
  kind: "edit-layer";
  layerId: string;
  name?: string;
  opacity?: number;
  visible?: boolean;
  blend?: string;
  blur?: number | null;
  shadow?: Partial<Shadow> | null;
  adjust?: Partial<Adjust> | null;
  adjustEnabled?: boolean;
}

export type TextPatch = Partial<Omit<TextSpec, "arc">> & {
  arc?: Partial<TextArc> | null;
};

export interface EditTextCommand {
  kind: "edit-text";
  layerId: string;
  patch: TextPatch;
}

export interface ReorderLayerCommand {
  kind: "reorder-layer";
  layerId: string;
  index: number;
}

export type DocumentCommand =
  | TransformLayerCommand
  | FitLayerCommand
  | EditLayerCommand
  | EditTextCommand
  | ReorderLayerCommand;

export interface OperationReceipt {
  kind: DocumentCommand["kind"] | "replace-scene";
  layerId?: string;
  before: unknown;
  after: unknown;
}

export interface EditReceipt {
  summary: string;
  operations: OperationReceipt[];
}

function definedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

/** Apply one command to a cloned scene, returning the new scene and concrete receipt. */
export function applyDocumentCommand(
  input: Scene,
  command: DocumentCommand,
): { scene: Scene; receipt: EditReceipt } {
  const scene = parseScene(structuredClone(input));
  const layer = findLayer(scene, command.layerId);
  const before = structuredClone(layer);

  if (command.kind === "transform-layer") {
    if (command.dx !== undefined || command.dy !== undefined) {
      applyMove(scene, layer, command.dx ?? 0, command.dy ?? 0);
    }
    if (command.drot !== undefined) applyRotate(scene, layer, command.drot);
    if (command.scale !== undefined) applyScale(layer, command.scale, command.naturalSize);
  } else if (command.kind === "fit-layer") {
    if (layer.type !== "image") throw new Error("fit applies to image layers");
    if (!command.naturalSize) throw new Error("fit requires the image's natural size");
    const fit = resolveFit(
      command.naturalSize.width,
      command.naturalSize.height,
      scene.canvas.width,
      scene.canvas.height,
      command.mode,
      command.percent,
      command.anchor,
    );
    layer.transform = { ...layer.transform, ...fit };
  } else if (command.kind === "edit-layer") {
    if (command.name !== undefined) layer.name = command.name;
    if (command.opacity !== undefined) layer.opacity = Math.max(0, Math.min(1, command.opacity));
    if (command.visible !== undefined) layer.visible = command.visible;
    if (command.blend !== undefined) layer.blend = command.blend;
    if (command.blur !== undefined) layer.blur = command.blur === null ? undefined : command.blur;
    if (command.shadow !== undefined) {
      layer.shadow =
        command.shadow === null
          ? undefined
          : {
              color: "#00000080",
              dx: 12,
              dy: 16,
              blur: 16,
              ...layer.shadow,
              ...definedProperties(command.shadow),
            };
    }
    if (command.adjust !== undefined) {
      layer.adjust =
        command.adjust === null
          ? undefined
          : {
              brightness: 0,
              contrast: 0,
              saturation: 0,
              exposure: 0,
              warmth: 0,
              hue: 0,
              shadows: 0,
              highlights: 0,
              clarity: 0,
              sharpen: 0,
              ...layer.adjust,
              ...definedProperties(command.adjust),
            };
    }
    if (command.adjustEnabled !== undefined) layer.adjustEnabled = command.adjustEnabled;
  } else if (command.kind === "edit-text") {
    if (layer.type !== "text") throw new Error("edit-text applies to text layers");
    const { arc, ...patch } = command.patch;
    Object.assign(layer.text, definedProperties(patch));
    if (arc !== undefined) {
      layer.text.arc =
        arc === null
          ? undefined
          : {
              radius: 400,
              angle: -90,
              direction: "clockwise",
              ...layer.text.arc,
              ...definedProperties(arc),
            };
    }
  } else {
    moveLayerTo(scene, command.layerId, command.index);
  }

  const validated = parseScene(scene);
  const after = structuredClone(findLayer(validated, command.layerId));

  return {
    scene: validated,
    receipt: {
      summary: `${command.kind.replace("-layer", "")} layer '${command.layerId}'`,
      operations: [
        {
          kind: command.kind,
          layerId: command.layerId,
          before,
          after,
        },
      ],
    },
  };
}

/** Browser-safe document commands shared by direct UI, IPC, CLI, and MCP. */

import { applyMove, applyRotate, applyScale } from "./editor.ts";
import { findLayer, parseScene, type Scene } from "./schema.ts";

export type DocumentCommand = {
  kind: "transform-layer";
  layerId: string;
  dx?: number;
  dy?: number;
  drot?: number;
  scale?: number;
  naturalSize?: { width: number; height: number };
};

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

/** Apply one command to a cloned scene, returning the new scene and concrete receipt. */
export function applyDocumentCommand(
  input: Scene,
  command: DocumentCommand,
): { scene: Scene; receipt: EditReceipt } {
  const scene = parseScene(structuredClone(input));
  const layer = findLayer(scene, command.layerId);
  const before = structuredClone(layer);

  if (command.dx !== undefined || command.dy !== undefined) {
    applyMove(scene, layer, command.dx ?? 0, command.dy ?? 0);
  }
  if (command.drot !== undefined) applyRotate(scene, layer, command.drot);
  if (command.scale !== undefined) applyScale(layer, command.scale, command.naturalSize);

  return {
    scene,
    receipt: {
      summary: `transformed layer '${command.layerId}'`,
      operations: [
        {
          kind: command.kind,
          layerId: command.layerId,
          before,
          after: structuredClone(layer),
        },
      ],
    },
  };
}

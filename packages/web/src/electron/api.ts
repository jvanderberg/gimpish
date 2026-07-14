import type { DocumentCommand, EditReceipt, Scene } from "@gimpish/core/model";

export interface DocumentSnapshot {
  path: string;
  scene: Scene;
  revision: number;
}

export interface RendererRequest {
  requestId: string;
  kind: "apply-command" | "replace-scene" | "history" | "render-preview" | "render-image";
  command?: DocumentCommand;
  scene?: Scene;
  historyOp?: "undo" | "redo";
  max?: number;
  width?: number;
  height?: number;
}

export interface RendererResponse {
  requestId: string;
  scene?: Scene;
  receipt?: EditReceipt;
  preview?: { mimeType: "image/png"; data: string; width: number; height: number };
  error?: string;
}

export interface GimpishElectronApi {
  loadDocument(): Promise<DocumentSnapshot>;
  persistScene(scene: Scene): Promise<{ revision: number }>;
  readAsset(path: string): Promise<{ mimeType: string; data: string }>;
  onCommand(callback: (request: RendererRequest) => void): () => void;
  completeCommand(response: RendererResponse): Promise<{ accepted: boolean; revision?: number }>;
}

declare global {
  interface Window {
    gimpish?: GimpishElectronApi;
  }
}

export function electronApi(): GimpishElectronApi {
  if (!window.gimpish) throw new Error("Electron preload API is unavailable");
  return window.gimpish;
}

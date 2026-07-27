import type { Adjust } from "@gimpish/core/model";
import { applyBrowserAdjustments } from "./adjust";

interface AdjustWorkerRequest {
  id: number;
  width: number;
  height: number;
  adjust: Adjust;
  buffer: ArrayBuffer;
}

interface AdjustWorkerResponse {
  id: number;
  buffer?: ArrayBuffer;
  error?: string;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<AdjustWorkerRequest>) => void) | null;
  postMessage(message: AdjustWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  const request = event.data;
  try {
    const pixels = new Uint8ClampedArray(request.buffer);
    applyBrowserAdjustments(pixels, request.width, request.height, request.adjust);
    scope.postMessage({ id: request.id, buffer: request.buffer }, [request.buffer]);
  } catch (cause) {
    scope.postMessage({
      id: request.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

import type { Adjust } from "@gimpish/core/model";

interface AdjustWorkerResponse {
  id: number;
  buffer?: ArrayBuffer;
  error?: string;
}

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (pixels: Uint8ClampedArray<ArrayBuffer>) => void; reject: (cause: Error) => void }
>();

function rejectPending(cause: Error): void {
  for (const request of pending.values()) request.reject(cause);
  pending.clear();
}

function adjustmentWorker(): Worker {
  if (worker) return worker;
  const next = new Worker(new URL("./adjust-worker.ts", import.meta.url), { type: "module" });
  next.addEventListener("message", (event: MessageEvent<AdjustWorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.error) request.reject(new Error(event.data.error));
    else if (event.data.buffer) request.resolve(new Uint8ClampedArray(event.data.buffer));
    else request.reject(new Error("adjustment worker returned no pixel buffer"));
  });
  next.addEventListener("error", (event) => {
    rejectPending(new Error(event.message || "adjustment worker failed"));
    next.terminate();
    if (worker === next) worker = null;
  });
  worker = next;
  return next;
}

export function applyAdjustmentsInWorker(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  adjust: Adjust,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const id = sequence + 1;
  sequence = id;
  const buffer = pixels.buffer as ArrayBuffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    adjustmentWorker().postMessage({ id, width, height, adjust, buffer }, [buffer]);
  });
}

export function stopAdjustmentWorker(): void {
  worker?.terminate();
  worker = null;
  rejectPending(new Error("adjustment worker stopped"));
}

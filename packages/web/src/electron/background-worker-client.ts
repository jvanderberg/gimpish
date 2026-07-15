interface BackgroundWorkerResponse {
  id: number;
  buffer?: ArrayBuffer;
  error?: string;
}

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (png: ArrayBuffer) => void; reject: (cause: Error) => void }
>();

function rejectPending(cause: Error): void {
  for (const request of pending.values()) request.reject(cause);
  pending.clear();
}

function backgroundWorker(): Worker {
  if (worker) return worker;
  const next = new Worker(new URL("./background-worker.ts", import.meta.url), { type: "module" });
  next.addEventListener("message", (event: MessageEvent<BackgroundWorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.error) request.reject(new Error(event.data.error));
    else if (event.data.buffer) request.resolve(event.data.buffer);
    else request.reject(new Error("background worker returned no PNG"));
  });
  next.addEventListener("error", (event) => {
    rejectPending(new Error(event.message || "background worker failed"));
    next.terminate();
    if (worker === next) worker = null;
  });
  worker = next;
  return next;
}

export function removeBackgroundInWorker(
  modelUrl: string,
  mimeType: string,
  bytes: ArrayBuffer,
): Promise<ArrayBuffer> {
  const id = sequence + 1;
  sequence = id;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    backgroundWorker().postMessage({ id, modelUrl, mimeType, buffer: bytes }, [bytes]);
  });
}

export function stopBackgroundWorker(): void {
  worker?.terminate();
  worker = null;
  rejectPending(new Error("background worker stopped"));
}

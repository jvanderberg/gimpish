import runtimeUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import * as ort from "onnxruntime-web/webgpu";
import { normalizeU2NetInput, saliencyToAlpha, U2NET_INPUT_SIZE } from "./background";

interface BackgroundWorkerRequest {
  id: number;
  modelUrl: string;
  mimeType: string;
  buffer: ArrayBuffer;
}

interface BackgroundWorkerResponse {
  id: number;
  buffer?: ArrayBuffer;
  error?: string;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<BackgroundWorkerRequest>) => void) | null;
  postMessage(message: BackgroundWorkerResponse, transfer?: Transferable[]): void;
}

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: runtimeUrl };

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function session(modelUrl: string): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
    sessionPromise = ort.InferenceSession.create(modelUrl, {
      executionProviders: gpu ? ["webgpu", "wasm"] : ["wasm"],
      graphOptimizationLevel: "all",
    }).catch((cause: unknown) => {
      sessionPromise = null;
      throw cause;
    });
  }
  return sessionPromise;
}

async function cutout(request: BackgroundWorkerRequest): Promise<ArrayBuffer> {
  const image = await createImageBitmap(new Blob([request.buffer], { type: request.mimeType }), {
    imageOrientation: "from-image",
  });
  try {
    const source = new OffscreenCanvas(image.width, image.height);
    const sourceContext = source.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) throw new Error("2D canvas is unavailable");
    sourceContext.drawImage(image, 0, 0);
    const sourcePixels = sourceContext.getImageData(0, 0, image.width, image.height);

    const inputCanvas = new OffscreenCanvas(U2NET_INPUT_SIZE, U2NET_INPUT_SIZE);
    const inputContext = inputCanvas.getContext("2d", { willReadFrequently: true });
    if (!inputContext) throw new Error("2D canvas is unavailable");
    inputContext.drawImage(image, 0, 0, U2NET_INPUT_SIZE, U2NET_INPUT_SIZE);
    const input = normalizeU2NetInput(
      inputContext.getImageData(0, 0, U2NET_INPUT_SIZE, U2NET_INPUT_SIZE).data,
    );

    const inference = await session(request.modelUrl);
    const inputName = inference.inputNames[0] ?? "input.1";
    const outputName = inference.outputNames[0] ?? "1959";
    const results = await inference.run({
      [inputName]: new ort.Tensor("float32", input, [1, 3, U2NET_INPUT_SIZE, U2NET_INPUT_SIZE]),
    });
    const result = results[outputName];
    if (!result || !(result.data instanceof Float32Array)) {
      throw new Error("U²-Net returned no float saliency map");
    }
    const alpha = saliencyToAlpha(result.data);
    const maskPixels = inputContext.createImageData(U2NET_INPUT_SIZE, U2NET_INPUT_SIZE);
    for (let pixel = 0; pixel < alpha.length; pixel += 1) {
      const offset = pixel * 4;
      const value = alpha[pixel] ?? 0;
      maskPixels.data[offset] = value;
      maskPixels.data[offset + 1] = value;
      maskPixels.data[offset + 2] = value;
      maskPixels.data[offset + 3] = 255;
    }
    inputContext.putImageData(maskPixels, 0, 0);

    const scaledMask = new OffscreenCanvas(image.width, image.height);
    const maskContext = scaledMask.getContext("2d", { willReadFrequently: true });
    if (!maskContext) throw new Error("2D canvas is unavailable");
    maskContext.drawImage(inputCanvas, 0, 0, image.width, image.height);
    const scaledAlpha = maskContext.getImageData(0, 0, image.width, image.height).data;
    for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
      sourcePixels.data[pixel * 4 + 3] = scaledAlpha[pixel * 4] ?? 0;
    }
    sourceContext.putImageData(sourcePixels, 0, 0);
    const blob = await source.convertToBlob({ type: "image/png" });
    return blob.arrayBuffer();
  } finally {
    image.close();
  }
}

const scope = globalThis as unknown as WorkerScope;
let queue = Promise.resolve();
scope.onmessage = (event) => {
  queue = queue.then(async () => {
    try {
      const buffer = await cutout(event.data);
      scope.postMessage({ id: event.data.id, buffer }, [buffer]);
    } catch (cause) {
      scope.postMessage({
        id: event.data.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });
};

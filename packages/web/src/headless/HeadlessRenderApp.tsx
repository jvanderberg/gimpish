import type { ExportCrop, Scene } from "@gimpish/core/model";
import { useEffect, useState } from "react";
import { renderScene } from "../render";

type RenderFormat = "png" | "jpg" | "webp";

interface HeadlessRenderRequest {
  scene: Scene;
  width: number;
  height: number;
  crop?: ExportCrop;
  format: RenderFormat;
  quality: number;
}

interface HeadlessRenderApi {
  request(): Promise<HeadlessRenderRequest>;
  readAsset(path: string): Promise<{ mimeType: string; data: string }>;
  complete(data: string): Promise<void>;
  fail(error: string): Promise<void>;
}

declare global {
  interface Window {
    gimpishHeadless?: HeadlessRenderApi;
  }
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("failed to read rendered image"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** Hidden Chromium host used by CLI preview/render/export. */
export function HeadlessRenderApp() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.gimpishHeadless;
    if (!api) {
      setError("headless renderer preload API is unavailable");
      return;
    }
    void (async () => {
      const request = await api.request();
      const canvas = new OffscreenCanvas(request.width, request.height);
      await renderScene(canvas, request.scene, api, request.width, request.height, request.crop);
      const mimeType =
        request.format === "jpg"
          ? "image/jpeg"
          : request.format === "webp"
            ? "image/webp"
            : "image/png";
      const blob = await canvas.convertToBlob({
        type: mimeType,
        quality: request.quality / 100,
      });
      await api.complete(await blobBase64(blob));
    })().catch(async (cause: unknown) => {
      const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
      setError(message);
      await api.fail(message).catch(() => undefined);
    });
  }, []);

  return error ? <pre>{error}</pre> : null;
}

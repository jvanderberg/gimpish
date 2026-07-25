import path from "node:path";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function assetMimeType(file: string): string {
  return IMAGE_MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function isSupportedImageExtension(extension: string): boolean {
  return extension.toLowerCase() in IMAGE_MIME_TYPES;
}

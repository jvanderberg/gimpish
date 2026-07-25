import { describe, expect, it } from "vitest";
import { assetMimeType, isSupportedImageExtension } from "../src/assets.ts";

describe("desktop image asset formats", () => {
  it("serves SVG with its real MIME type", () => {
    expect(assetMimeType("assets/logo.svg")).toBe("image/svg+xml");
    expect(assetMimeType("assets/LOGO.SVG")).toBe("image/svg+xml");
  });

  it("accepts supported raster and SVG imports", () => {
    for (const extension of [".png", ".jpg", ".jpeg", ".webp", ".svg"]) {
      expect(isSupportedImageExtension(extension)).toBe(true);
    }
    expect(isSupportedImageExtension(".pdf")).toBe(false);
  });
});

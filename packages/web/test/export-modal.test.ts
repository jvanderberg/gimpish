import { parseScene } from "@gimpish/core/model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExportModal, type ExportModalRuntime } from "../src/components/ExportModal";

const scene = parseScene({
  canvas: { width: 1200, height: 675, background: "transparent" },
  layers: [],
});

function markup(runtime?: ExportModalRuntime): string {
  const props = {
    canvas: scene.canvas,
    scene,
    ts: 7,
    onClose: vi.fn(),
  };
  return renderToStaticMarkup(createElement(ExportModal, runtime ? { ...props, runtime } : props));
}

describe("ExportModal runtimes", () => {
  it("keeps server downloads on HTTP endpoints", () => {
    const html = markup();
    expect(html).toContain("/api/preview.png?");
    expect(html).toContain("/api/export?");
    expect(html).toContain("/api/bundle");
    expect(html).toContain("4K 3840×2160");
    expect(html).toContain("Print 16×12 in · 300 DPI 4800×3600");
  });

  it("uses Electron callbacks and its browser-rendered preview", () => {
    const html = markup({
      previewSrc: "blob:gimpish-preview",
      resolutionIndependent: true,
      saveSettings: vi.fn(),
      download: vi.fn(),
      saveBundle: vi.fn(),
    });
    expect(html).toContain('src="blob:gimpish-preview"');
    expect(html).toContain("<button");
    expect(html).toContain("Download PNG");
    expect(html).toContain("Bundle (.gimpish)");
    expect(html).toContain("Output");
    expect(html).toContain("1280×720 px");
    expect(html).toContain("Full composition");
    expect(html).toContain("Vector artwork stays sharp");
    expect(html).toContain('class="export-crop"');
    expect(html).toContain('aria-label="Resize crop nw"');
    expect(html).not.toContain("will soften");
    expect(html).not.toContain("/api/export?");
    expect(html).not.toContain("/api/bundle");
  });
});

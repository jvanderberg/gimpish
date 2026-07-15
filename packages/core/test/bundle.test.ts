import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createBundle, extractBundle, parseScene } from "../src/index.ts";

const workspaces: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "gimpish-bundle-"));
  workspaces.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of workspaces.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("shared bundle codec", () => {
  it("packs referenced assets and extracts a relocatable scene", () => {
    const source = workspace();
    const asset = path.join(source, "photo with spaces.png");
    writeFileSync(asset, new Uint8Array([1, 2, 3, 4]));
    const scene = parseScene({
      canvas: { width: 320, height: 180 },
      layers: [{ id: "photo", type: "image", source: "photo with spaces.png" }],
    });
    const bundle = createBundle({ path: path.join(source, "scene.json"), scene });

    const destination = workspace();
    const scenePath = path.join(destination, "scene.json");
    const extracted = extractBundle(bundle, scenePath);
    const layer = extracted.layers[0];
    if (layer?.type !== "image") throw new Error("expected image layer");
    expect(layer.source).toBe("assets/photo-with-spaces.png");
    expect([...readFileSync(path.join(destination, layer.source))]).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(readFileSync(scenePath, "utf8"))).toMatchObject({ canvas: { width: 320 } });
  });

  it("rejects zip entries that escape the destination", () => {
    const destination = workspace();
    const scene = new TextEncoder().encode(
      JSON.stringify({ canvas: { width: 10, height: 10 }, layers: [] }),
    );
    const malicious = zipSync({
      "scene.json": scene,
      "../outside.txt": new TextEncoder().encode("nope"),
    });
    expect(() => extractBundle(malicious, path.join(destination, "scene.json"))).toThrow(
      /unsafe path/,
    );
  });
});

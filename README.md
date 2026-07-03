# gimpish

Agent-native image composition for LLM workflows.

`gimpish` is a local-first image editor built around a stable command-line API and
a live browser editor. An agent edits a plain `scene.json` through semantic verbs
like `add`, `layer fit`, `layer remove-bg`, `draw gradient`, and `export`; a human
can keep the editor open, watch each change land, and nudge layers directly —
drag to move, handles to rotate and scale.

The goal is "Photoshop for LLM agents": layers, masks, foreground cutouts,
primitive drawing, and deterministic rendering without requiring a GUI automation
loop or a cloud image service.

## What it does

- Imports source images as non-destructive layers.
- Stores all composition state in `scene.json` (a versioned, zod-validated contract).
- Renders through one sharp/libvips pipeline for preview, export, and the web UI.
- Supports image, shape, gradient, arrow, and styled text layers, plus opacity,
  blend modes, and layer ordering.
- Removes image backgrounds locally (U²-Net via onnxruntime; the model is
  downloaded once to `~/.u2net/u2net.onnx`).
- Saves derived cutouts and masks in `.scene_cache/`.
- Serves a live web editor with a layer panel and direct manipulation:
  select, drag, rotate, scale — one scene write per gesture.

## Install

Requirements: Node 24.18+ (see `.nvmrc`).

```bash
nvm use              # or any Node 24.18+
npm install
```

Inside the repo the CLI is `npx gimpish` (or `npm link -w gimpish` for a global
`gimpish`). Node 24 runs the TypeScript sources directly — the CLI and server
have no build step. Two things are deferred until first use:

- `npm run build` — bundles the web editor; only needed before `gimpish serve`.
- `gimpish layer remove-bg` — downloads the U²-Net model (~176 MB) to
  `~/.u2net/u2net.onnx` on first run, then works offline.

## Quickstart

Create a scene, add a background, add a foreground subject, remove the subject
background, and export the result:

```bash
gimpish init --width 1920 --height 1080

gimpish add downloads/background.jpg --name bg
gimpish layer fit bg --mode fill

gimpish draw gradient --over bg --kind linear --anchor top-left \
  --stops "0:#000000ff, 1:#00000000"

gimpish add downloads/image1.jpg --name subject
gimpish layer remove-bg subject
gimpish layer fit subject --mode fit --percent 75
gimpish layer move subject --top

gimpish preview --out preview.png
gimpish export --out final.png
```

## Live editor

Run the editor server beside the scene:

```bash
gimpish serve
```

Then open `http://127.0.0.1:8765`.

The browser renders through the same pipeline as `preview`/`render`/`export`.
When `scene.json` or `.scene_cache/` changes, the server pushes a reload over
WebSocket and the view refreshes — CLI edits appear live.

The canvas is directly manipulable: click a layer (on the canvas or in the
panel) to select it; drag to move, top handle to rotate, corner handles to
scale. Radial gradients drag their glow center; linear gradients rotate their
angle. Arrow keys nudge 1px (Shift = 10px). While dragging, the moved layer
floats as a live ghost sprite; releasing commits a single delta to `scene.json`.

Use a different scene or port:

```bash
gimpish serve --scene examples/radial-badge.scene.json --port 8766
```

## Command overview

Scene lifecycle:

```bash
gimpish init --width 1920 --height 1080 [--bg transparent|#rrggbbaa]
gimpish add path/to/image.jpg --name layer-name
gimpish layers
gimpish save [copy.json]
```

Render/export:

```bash
gimpish preview --out preview.png --max 1024
gimpish render --out render.png [--width 3840] [--height 2160]
gimpish export --out final.png
gimpish export --out final.jpg --quality 90
gimpish export --out final.webp --quality 90
```

Layer operations:

```bash
gimpish layer fit subject --mode fit --percent 75 --anchor center
gimpish layer transform subject --x 120 --y 80 --scale 0.8 --rotation 5
gimpish layer rotate headline --ccw 12
gimpish layer move subject --top
gimpish layer opacity subject 0.65
gimpish layer blend subject multiply
gimpish layer visible subject false
gimpish layer delete subject
```

Masks and background removal:

```bash
gimpish layer remove-bg subject
gimpish layer mask subject --from mask.png
gimpish layer mask subject --shape ellipse --x 100 --y 100 --w 600 --h 400
gimpish layer mask subject --shape rect --x 0 --y 0 --w 500 --h 500 --feather 12
```

Drawing:

```bash
gimpish draw rect --x 80 --y 80 --w 500 --h 280 --fill "#20242cff"
gimpish draw ellipse --x 300 --y 160 --w 240 --h 240 --fill "#ff3366ff"
gimpish draw arrow --from-x 900 --from-y 220 --to-x 650 --to-y 480 \
  --width 54 --head-length 88 --head-width 112 --color "#e61e2dff"
gimpish draw text "Gradient Text" --x 500 --y 145 --align center \
  --font "Helvetica Neue" --size 96 --weight 800 \
  --gradient-stops "0:#f97316ff, 1:#38bdf8ff" \
  --stroke "#ffffffff" --stroke-width 4 \
  --shadow-color "#00000099" --shadow-angle 45 \
  --shadow-distance 18 --shadow-blur 10
gimpish draw gradient --kind linear --anchor top-left \
  --stops "0:#000000cc, 1:#00000000"
gimpish draw alpha-gradient --color "#000000" --from 0.75 --to 0 \
  --kind radial --anchor bottom-right
```

All commands operate on `./scene.json` by default. Pass `--scene path/to/scene.json`
to use a different file.

## Scene model

`scene.json` is the source of truth. It contains:

- A fixed design canvas: width, height, and background.
- An ordered layer list. Index `0` is the bottom layer; the last layer is topmost.
- Image layer sources stored as paths relative to the scene where possible.
- Canvas-space transforms: `x`, `y`, `scale`, and `rotation`.
- Optional masks: cutout, image, or shape.
- Shape and gradient definitions.
- Arrow definitions with canvas-space tail and tip coordinates.
- Text definitions with font, size, weight, style, fill/gradient, stroke,
  shadow, alignment, line height, letter spacing, and rotation.

Example layer:

```json
{
  "id": "subject",
  "type": "image",
  "name": "subject",
  "source": "downloads/image1.jpg",
  "transform": { "x": 555, "y": 135, "scale": 0.9, "rotation": 0 },
  "opacity": 1.0,
  "blend": "normal",
  "visible": true,
  "mask": { "kind": "cutout", "cache": ".scene_cache/subject_cutout.png" }
}
```

Source images are never modified. Generated assets live in `.scene_cache/`.

The file is zod-validated on every load, so editing it directly (by hand or by
an agent) is as legitimate as using the CLI — malformed edits fail loudly with
a precise error. Use the CLI for semantic operations (`fit`, `remove-bg`,
reordering); edit the JSON directly for batch tweaks to existing values.

## Conventions

- **Coordinates** are canvas pixels; the origin is top-left and y grows
  downward. All positions, sizes, and stroke widths live in this one space —
  render/export scales the whole canvas, so output resolution never changes
  the numbers.
- **Layer order**: array order is paint order. Index `0` is the back layer;
  the last entry is frontmost. `layer move --up` moves toward the front.
- **Colors**: `#rgb`, `#rrggbb`, or `#rrggbbaa` (alpha defaults to opaque).
- **Anchors** (for `fit`, gradients): `top-left`, `top`, `top-right`, `left`,
  `center`, `right`, `bottom-left`, `bottom`, `bottom-right`.
- **Blend modes**: `normal`, `multiply`, `screen`, `overlay`, `darken`,
  `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`,
  `difference`, `exclusion`, `add`.
- **Placement semantics**: an image layer's `transform.x/y` is the top-left
  corner of the scaled image; `rotation` is clockwise degrees about its
  center. Text `x/y` is the anchor point (its meaning follows `--align`);
  arrows use absolute tail/tip coordinates. Prefer `layer fit` over doing
  placement arithmetic yourself.
- **Rotation direction**: positive = clockwise everywhere (screen-space
  y-down); `layer rotate --ccw/--cw` speaks visual direction instead.

## Repository layout

```text
packages/core/    scene schema (zod), geometry, editor ops, sharp render
                  engine, U²-Net background removal
packages/cli/     gimpish CLI (commander) + Fastify editor server
packages/web/     live editor (Vite + React + TypeScript)
tests/fixtures/   golden renders + scenes for the pixel-parity suite
examples/         sanitized scene files (shapes, gradients, arrows, text only)
```

Other useful files:

- `DESIGN.md`: architecture and rationale.
- `scene.json`: default local working scene path, ignored by git.

Local working scenes are intentionally ignored by default. Commit only sanitized
examples under `examples/`.

## Design principles

- CLI-first: the command surface is the agent API.
- Non-destructive: source images are referenced, not overwritten.
- One render path: preview and final output use the same compositor.
- Semantic placement: commands like `fit --percent 75 --anchor center` avoid
  forcing the agent to do canvas arithmetic.
- Local-first: rendering and background removal run locally.
- Direct manipulation stays scoped to continuous spatial properties (move,
  rotate, scale); everything structural or semantic goes through the CLI.

## Current limitations

- Background removal is U²-Net saliency; text-prompted or SAM-style object
  selection is not implemented yet.
- Masks support one mask per layer.
- Adjustment layers and filters are not in the command surface.
- The editor server watches the scene directory, so very noisy directories can
  trigger extra refreshes.

## Development

```bash
npm run check       # biome lint/format + tsc across all packages
npm test            # vitest: model, CLI, server API, and pixel-parity suites
npm run dev         # vite dev server for the web app (proxies /api to :8765)
npm run build       # production web bundle (served by gimpish serve)
```

The renderer's output is pinned by golden fixtures (`tests/fixtures/`); the
parity suite requires the render pipeline to reproduce them within tight pixel
tolerances.

# gimpish

Agent-native image composition for LLM workflows.

`gimpish` is a local-first image editor built around a stable command-line API and
a live browser preview. An agent edits a plain `scene.json` through semantic verbs
like `add`, `layer fit`, `layer remove-bg`, `draw gradient`, and `export`; a human
can keep the preview open and see each change as it lands.

The goal is "Photoshop for LLM agents": layers, masks, foreground cutouts,
primitive drawing, and deterministic rendering without requiring a GUI automation
loop or a cloud image service.

## What it does

- Imports source images as non-destructive layers.
- Stores all composition state in `scene.json`.
- Renders through one pyvips pipeline for preview, export, and the web UI.
- Supports image layers, shape layers, gradient layers, opacity, blend modes, and
  layer ordering.
- Removes image backgrounds with optional local `rembg` support.
- Saves derived cutouts and masks in `.scene_cache/`.
- Serves a read-only live preview with a layer stack panel.

## Install

Requirements:

- Python 3.11+
- libvips

On macOS:

```bash
brew install vips
python -m venv .venv
source .venv/bin/activate
pip install -e '.[bg,serve]'
```

Extras:

- `bg`: installs `rembg` and `onnxruntime` for background removal.
- `serve`: installs FastAPI, Uvicorn, and watchfiles for live preview.

For rendering only:

```bash
pip install -e .
```

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

## Live preview

Run the preview server beside the scene:

```bash
gimpish serve
```

Then open:

```text
http://127.0.0.1:8765
```

The browser fetches the same render path used by `preview`, `render`, and
`export`. When `scene.json` or `.scene_cache/` changes, the server pushes a reload
event over WebSocket and the browser refreshes the image.

Use a different scene or port:

```bash
gimpish serve --scene scratch/scene.json --port 8766
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

## Repository layout

```text
src/gimpish/
  cli.py          Typer command surface for agents and humans
  scene.py        scene dataclasses and JSON persistence
  render.py       pyvips renderer shared by preview/export/server
  bg.py           optional rembg background removal
  server.py       FastAPI live preview server
  web/index.html  browser UI for preview and layer stack
```

Other useful files:

- `DESIGN.md`: architecture and rationale.
- `scratch/`: demo scenes, generated outputs, and local test assets.
- `scene.json`: current root scene.

## Design principles

- CLI-first: the command surface is the agent API.
- Non-destructive: source images are referenced, not overwritten.
- One render path: preview and final output use the same compositor.
- Semantic placement: commands like `fit --percent 75 --anchor center` avoid
  forcing the agent to do canvas arithmetic.
- Local-first: rendering and background removal run locally.

## Current limitations

- The web preview is read-only.
- Background removal uses `rembg`; text-prompted or SAM-style object selection is
  not implemented yet.
- Masks support one mask per layer.
- Text layers, adjustment layers, filters, and GUI transforms are not in the v1
  command surface.
- The live preview server watches the scene directory, so very noisy directories
  can trigger extra refreshes.

## Development checks

Basic sanity checks:

```bash
python -m compileall -q src
gimpish --help
gimpish preview --scene scene.json --out /tmp/gimpish-preview.png --max 512
```

Start a preview server against the scratch demo:

```bash
gimpish serve --scene scratch/scene.json --port 8766
```

Then fetch:

```bash
curl -fsS http://127.0.0.1:8766/api/scene
curl -fsS -o /tmp/gimpish-server-preview.png \
  'http://127.0.0.1:8766/api/preview.png?max=512'
```

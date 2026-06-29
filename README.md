# gimpish

Agent-native image composition — "Photoshop for LLM agents". A stable, verb-based CLI
for importing images, removing backgrounds, masking, layering, drawing primitives, and
rendering, plus a live web preview. Local-first (libvips + rembg), no cloud.

See [DESIGN.md](DESIGN.md) for the architecture and rationale.

## Install

Requires libvips (`brew install vips`) and Python 3.11+.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[bg,serve]'      # bg = rembg background removal, serve = web preview
```

## Quickstart

```bash
gimpish init --width 1920 --height 1080
gimpish add background.jpg --name bg
gimpish layer fit bg --mode fill
gimpish draw gradient --over bg --kind linear --anchor top-left \
        --stops "0:#000000ff, 1:#00000000"
gimpish add subject.jpg --name subject
gimpish layer remove-bg subject
gimpish layer fit subject --mode fit --percent 75
gimpish layer move subject --top
gimpish export --out final.png
```

## Live preview

```bash
gimpish serve            # opens a live React preview at http://127.0.0.1:8765
```
The browser updates the moment any CLI command changes the scene.

## Commands

| Area    | Commands |
|---------|----------|
| Scene   | `init`, `add`, `layers`, `save`, `preview`, `render`, `export`, `serve` |
| Layer   | `layer transform/fit/move/opacity/blend/visible/delete/remove-bg/mask` |
| Draw    | `draw rect`, `draw ellipse`, `draw gradient` |

State lives in `scene.json` (references source images; derived cutouts/masks go in
`.scene_cache/`). Sources are never modified.

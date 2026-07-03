# gimpish — design doc

An agent-native image composition tool. Think "Photoshop for LLM agents": a stable,
verb-based interface for importing images, removing backgrounds, masking, layering,
drawing primitives, and rendering — driven from a CLI (and later an MCP server), with
a live web preview for the human in the loop.

Status: design. Target: working end-to-end prototype of the canonical workflow below.

---

## 1. Motivation

Agentic image tooling already exists but is fragmented and under-delivers on table
stakes:

- **Thin CLI wrappers** (ImageMagick MCP servers): expose raw `magick` args. The agent
  must know gnarly syntax, gets no semantic feedback, and burns turns on trial-and-error.
- **Thick GUI-bound wrappers** (GIMP MCP servers): ~50+ low-level tools mapping 1:1 to
  GIMP primitives. The agent orchestrates menu-clicks ("create layer → set blend → select
  → fill"), which is token-expensive and inherits GIMP's dumb color-wand selection.
- **Adobe** (Photoshop API v2 + UXP + `adb-mcp`): real fidelity, but requires a Photoshop
  license or metered cloud API — not local, not free, not a single tool.

The three things every user names as table stakes — **layers, foreground object
selection, masking** — are not equally hard:

- **Layers** = a data-model choice (ordered list of composited entries). Easy; we own it.
- **Masking** = an alpha channel. Easy; every backend does it natively.
- **Foreground selection** = the actual product. Classic tools only offer brittle
  color-range / magic-wand selection. What an agent wants is *semantic* selection
  ("the person", "the foreground"), which is an **ML problem** (rembg today, SAM2 later).

The gap nobody has packaged cleanly: **semantic selection wired into a layer model with
agent-verifiable previews, fully local.** That's gimpish.

---

## 2. Goals / non-goals

### Goals (v1)
- Import multiple images as layers into a scene.
- Non-destructive editing — sources never mutated; derived assets cached.
- Remove background of a layer (rembg) → cutout mask.
- Mask a layer (from an image or a shape).
- Scale / offset / reorder layers, set opacity / blend mode.
- Draw primitives (rect, ellipse, arrows), gradients, and styled text as first-class layers.
- Preview (quick, downscaled) and render/export (any resolution) to png/jpg/webp.
- Save/load scene state as a JSON file referencing source images.
- A live web preview server (React) showing the composite + layer stack.

### Non-goals (v1, explicitly deferred)
- SAM2 / text-prompted selection ("select the red bag"). rembg only for now; slots in
  later behind the same `layer mask` verb.
- A resident model daemon. Plain per-call CLI; eat rembg cold start once. Daemon is v2.
- MCP server. The CLI is the substrate; an MCP wrapper is a thin later layer.
- Editing from the web UI (read-only preview to start).
- Free-transform rotation UX and filters/adjustments beyond gradients/text styling.

---

## 3. Architecture

```
┌──────────────┐   writes    ┌──────────────────┐   watches    ┌──────────────────┐
│  CLI / agent  │ ──────────▶ │   scene.json     │ ◀─────────── │  preview server   │
│  (gimpish ...) │             │   .scene_cache/  │              │  (FastAPI)        │
└──────┬───────┘             └────────┬─────────┘              └────────┬─────────┘
       │                              │                                 │
       │  load → mutate → save        │  rembg cutouts, rasterized      │ render via
       │                              │  masks, derived assets          │ same engine
       ▼                              ▼                                 ▼
┌─────────────────────────────────────────────┐               ┌──────────────────┐
│  render engine (pyvips)                       │               │  React app        │
│  compose layers → blend/mask/transform → out  │◀──────────────│  live canvas +    │
└─────────────────────────────────────────────┘   same path    │  layer panel      │
                                                                └──────────────────┘
```

- **Single source of truth:** `scene.json`. Every CLI command loads it, mutates, saves.
- **One render path** (`pyvips`) shared by `render`, `export`, `preview`, and the web
  server — so preview always equals the real output.
- **Derived assets** (bg-removed cutouts, rasterized masks) live in `.scene_cache/`
  next to the scene file and are referenced by path. Sources stay pristine.

---

## 4. The scene document

JSON is the wire format and the agent's state representation. Positions and sizes are in
**canvas-space pixels** (see §5).

```json
{
  "version": 1,
  "canvas": { "width": 1920, "height": 1080, "background": "transparent" },
  "layers": [
    {
      "id": "bg",
      "type": "image",
      "name": "background",
      "source": "downloads/background.jpg",
      "transform": { "x": 0, "y": 0, "scale": 1.0, "rotation": 0 },
      "opacity": 1.0,
      "blend": "normal",
      "visible": true,
      "mask": null
    },
    {
      "id": "fade",
      "type": "gradient",
      "gradient": {
        "kind": "linear",
        "anchor": "top-left",
        "stops": [
          { "at": 0.0, "color": "#000000ff" },
          { "at": 1.0, "color": "#00000000" }
        ]
      },
      "opacity": 1.0,
      "blend": "normal",
      "visible": true
    },
    {
      "id": "subject",
      "type": "image",
      "name": "subject",
      "source": "downloads/image1.jpg",
      "transform": { "x": 480, "y": 270, "scale": 0.75, "rotation": 0 },
      "opacity": 1.0,
      "blend": "normal",
      "visible": true,
      "mask": { "kind": "cutout", "cache": ".scene_cache/subject_mask.png" }
    },
    {
      "id": "badge",
      "type": "shape",
      "shape": "ellipse",
      "rect": { "x": 1600, "y": 120, "w": 200, "h": 200 },
      "fill": "#ff3366ff",
      "stroke": "#ffffffff",
      "stroke_width": 6,
      "opacity": 1.0,
      "blend": "normal",
      "visible": true
    }
  ]
}
```

### Layer types
- `image` — references a `source` path; optional `mask`.
- `shape` — `rect` | `ellipse`, with `rect` bounds, `fill`, `stroke`, `stroke_width`.
- `gradient` — `linear` | `radial`, `anchor` or `angle`, `stops[]`.
- `arrow` — canvas-space tail/tip coordinates, fill color, width, head size, stroke.
- `text` — content, position, font, size, weight/style, fill color or gradient,
  stroke, drop shadow, line height, letter spacing, alignment, rotation.

### Masks
A `mask` on a layer is one of:
- `{ "kind": "cutout", "cache": "..." }` — from `remove-bg` (rembg) or an applied alpha.
- `{ "kind": "image", "source": "mask.png" }` — external grayscale/alpha mask.
- `{ "kind": "shape", "shape": "rect|ellipse", "rect": {...}, "feather": 0 }`.

Masks compose by add/subtract/intersect later; v1 supports a single mask per layer.

### Conventions
- **Order:** array order is paint order. Index `0` = bottom (back). Last = top (front).
  "Move up" = toward the front (higher index).
- **Colors:** `#rrggbbaa` (alpha required; `ff` if opaque).
- **Non-destructive:** sources untouched; all derived pixels in `.scene_cache/`.

---

## 5. Coordinate system

**Canvas pixels for storage, semantic verbs for the interface.**

- The scene has a fixed design canvas (e.g. 1920×1080). All positions, sizes, stroke
  widths, gradient extents are in that pixel space.
- Resolution independence is free: render/export scales the whole canvas to the requested
  output size. The agent reasons in one stable space regardless of output res.
- **The agent does not type raw pixels.** Semantic placement verbs resolve to pixel
  transforms: `fit --percent 75`, `--anchor top-left|center|...`, `fill`, `cover`,
  `center`. Agents are bad at "75% of 1920 minus half the scaled width" arithmetic and
  good at intent — so intent goes in, the tool writes pixels into the doc.

Rejected: normalized 0–1 coordinates. On a non-square canvas, normalized x and y are
different physical distances, so every sizing op carries aspect-ratio bookkeeping. Canvas
pixels avoid that with no loss of resolution independence.

---

## 6. Command surface (CLI)

CLI-first; an MCP wrapper is a thin later layer over the same engine. Commands operate on
`./scene.json` by default (`--scene <path>` to override).

### Scene lifecycle
```
gimpish init    --width 1920 --height 1080 [--bg transparent|#rrggbbaa]
gimpish add     <path> [--name NAME]                     # import image layer (added on top)
gimpish layers                                           # print the stack as a table
gimpish save    [scene.json]
gimpish load    scene.json
```

### Render / preview / export
```
gimpish preview [--max 1024] [--out preview.png]         # quick downscaled render → PNG
gimpish render  --out out.png --width 3840 [--height H]  # full-res composite
gimpish export  --out final.{png,jpg,webp} [--quality 90]
```
`preview` returns the path to a PNG the agent (or web UI) can view to verify state.

### Layer ops
```
gimpish layer transform <id> [--x N] [--y N] [--scale F] [--rotation DEG]
gimpish layer fit       <id> --mode fit|fill|cover --percent 75 [--anchor center]
gimpish layer move      <id> --up | --down | --top | --bottom
gimpish layer opacity   <id> 0.5
gimpish layer blend     <id> normal|multiply|screen|overlay|...
gimpish layer remove-bg <id>                             # rembg → cutout mask
gimpish layer mask      <id> --from mask.png
gimpish layer mask      <id> --shape rect|ellipse --x N --y N --w N --h N [--feather N]
gimpish layer visible   <id> true|false
gimpish layer delete    <id>
```

### Drawing (each adds a layer)
```
gimpish draw rect     --x --y --w --h --fill "#rrggbbaa" [--stroke "#..."] [--stroke-width N]
gimpish draw ellipse  --x --y --w --h --fill "#rrggbbaa" [--stroke "#..."] [--stroke-width N]
gimpish draw arrow    --from-x --from-y --to-x --to-y [--color "#..."] [--width N]
gimpish draw text     TEXT --x --y [--font NAME] [--size N] [--weight W] \
                      [--fill "#..."] [--gradient-stops "0:#..., 1:#..."] \
                      [--stroke "#..."] [--stroke-width N] \
                      [--shadow-color "#..."] [--shadow-angle DEG] \
                      [--shadow-distance N] [--shadow-blur N]
gimpish draw gradient --kind linear|radial [--anchor top-left|...] [--angle DEG] \
                      --stops "0:#000000ff, 1:#00000000" [--over <id>]
```
`--over <id>` inserts the gradient directly above the referenced layer; otherwise on top.

### Web preview
```
gimpish serve [--port 8765]                              # FastAPI + React live preview
```

---

## 7. Canonical workflow (the acceptance test)

> "import downloads/image1.jpg, remove the background, scale it to fit about 75% of the
> window, import downloads/background.jpg, scale it to fill the window, add a gradient
> over the background to fade it to black in the upper left"

```bash
gimpish init --width 1920 --height 1080

gimpish add downloads/background.jpg --name bg
gimpish layer fit bg --mode fill                          # fills the window

gimpish draw gradient --over bg --kind linear --anchor top-left \
        --stops "0:#000000ff, 1:#00000000"                # fades to black, upper-left

gimpish add downloads/image1.jpg --name subject
gimpish layer remove-bg subject                           # rembg cutout
gimpish layer fit subject --mode fit --percent 75         # ~75% of the window
gimpish layer move subject --top

gimpish preview                                           # human/agent views preview.png
gimpish export --out final.png
gimpish save scene.json
```

If this runs end-to-end and the preview looks right, v1 core is done.

---

## 8. Web preview server

```
┌─────────────┐   writes    ┌──────────────┐   file-watch  ┌──────────────┐
│  CLI / agent │ ──────────▶ │  scene.json  │ ◀──────────── │ FastAPI server│
└─────────────┘             │ .scene_cache │               └──────┬───────┘
                            └──────────────┘    render (pyvips) +  │ WebSocket push
                                                                ┌──▼──────────┐
                                                                │  React app   │
                                                                │  composite + │
                                                                │  layer panel │
                                                                └─────────────┘
```

- **`gimpish serve`** starts FastAPI. It watches `scene.json`, re-renders on change via the
  same `pyvips` path, and pushes updates over WebSocket — the browser updates the instant a
  command runs.
- **React app:** the rendered composite plus a Photoshop-style layer panel (stack order,
  names, visibility, opacity, blend) so the human sees both result and structure.
- **Read-only** to start. Drag-to-reorder / toggle-visibility from the UI is a later nicety.
- Same render path as `render`/`export` ⇒ preview equals truth.

---

## 9. Tech stack

| Concern              | Choice                                              |
|----------------------|-----------------------------------------------------|
| Language             | TypeScript (Node 24, native type stripping — no build) |
| Compositing          | `sharp` (libvips) — native, fast, no GPU needed      |
| Background removal    | U²-Net via `onnxruntime-node` (rembg's model/cache)  |
| Semantic selection (v2) | SAM2 / Grounding DINO via ONNX or CoreML           |
| CLI                  | `commander` subcommands                              |
| Web server           | Fastify + WebSocket, `chokidar` for file-watch       |
| Web UI               | React + Vite + TypeScript                            |
| Scene schema         | JSON (versioned), validated with `zod`               |

Local-first: everything runs offline after first model download.

---

## 10. Build order

1. **Core engine + CLI** — scene model, all verbs, pyvips compositing, rembg. Get the
   canonical workflow (§7) running end-to-end from the terminal.
2. **`gimpish serve` + React app** — live preview over the same render path.

Deferred to v2: SAM2 / text-prompted selection, resident daemon, MCP server, editable
web UI.

---

## 11. Open questions / future

- **Mask composition** — add/subtract/intersect multiple masks per layer.
- **Daemon** — resident process holding ML models when chaining many selection calls.
- **MCP server** — wrap the CLI verbs as MCP tools; `preview` becomes the agent's visual
  feedback channel.
- **Text-prompted selection** — "select the person" via Grounding DINO + SAM2.
- **Color match** — adjust a layer's color temperature to match another (the "magic"
  compositing verb).
- **Effects** — drop shadow, blur, adjustments.

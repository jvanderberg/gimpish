# gimpish

Agent-native image composition. Commands load `./scene.json`, mutate it, and save back.

TypeScript monorepo (Node 24, npm workspaces): `packages/core` (schema + render
engine), `packages/cli` (CLI + editor server), `packages/web` (editor UI). Node
runs the .ts sources directly — no build step for CLI/server; `npm run build`
only bundles the web app (needed only for `gimpish serve`).

## Cold start

```bash
nvm use          # Node 24.18+ (.nvmrc); nvm install 24 first if missing
npm install
npx gimpish --help
```

That's everything for scene generation. `npm run build` is only needed before
`npx gimpish serve` (the browser editor). `layer remove-bg` downloads a ~176 MB
model to `~/.u2net/` on first use.

## Generating a scene

```bash
npx gimpish init --width 1600 --height 900 --bg "#101418ff"
npx gimpish add photo.jpg --name subject          # import an image layer
npx gimpish layer remove-bg subject               # U²-Net cutout mask
npx gimpish layer fit subject --mode fit --percent 70 --anchor right
npx gimpish draw alpha-gradient --color "#000000" --from 0.8 --to 0 --kind radial --anchor bottom-left
npx gimpish draw text "Headline" --x 800 --y 640 --size 140 --weight 900 \
    --align center --fill "#e61e2dff" --stroke "#ffffffff" --stroke-width 8
npx gimpish preview --out preview.png             # downscaled; view this to verify
npx gimpish export --out final.png                # full res, end of session only
```

Every command auto-saves. `npx gimpish layers` prints the stack. Full verb
surface: `npx gimpish --help`, plus `layer --help` / `draw --help`; option
details and conventions (coordinates, colors, anchors, blends) are in README.md.

Editing `scene.json` directly with Edit/Write is equally legitimate — it's the
source of truth, zod-validated on every load. Prefer the CLI for semantic ops
(fit, remove-bg, reorder); prefer direct JSON edits for batch tweaks to
existing values.

## Conventions that bite

- Coordinates are **canvas pixels**, y grows downward. Layer array order is
  paint order: index 0 = back, last = front.
- Colors: `#rgb`, `#rrggbb`, or `#rrggbbaa`.
- Image `transform.x/y` is the **top-left** of the scaled image; rotation
  (clockwise degrees) pivots the center. Text `x/y` is the anchor point
  (align-dependent); arrows use absolute from/to endpoints.
- `layer fit` computes scale+position for you — use it instead of doing
  placement arithmetic.

## Speed when editing scenes

- Use `npx gimpish preview` (fast downscaled) for iteration; only
  `npx gimpish render`/`export` at full res at the end.
- Don't render + read the image back for changes whose result is obvious
  (opacity/reorder/rename). Batch mechanical edits, verify visually once at
  the end.
- For a human in the loop, `npx gimpish serve` gives a live browser editor at
  :8765 (select/drag/rotate/scale writes back to scene.json). Files the human
  drags into the editor are saved as `assets/<slugged-filename>.<ext>` and
  appear as a new top layer whose id is the slugged filename (e.g.
  `My Photo.PNG` → layer `my-photo`, file `assets/my-photo.png`) — check
  `npx gimpish layers` after the user says they dropped something in.

## Checks before committing

- `npm run check` (biome lint/format + strict tsc for all packages + full
  vitest suite) must pass.
- The pixel-parity suite (`packages/core/test/parity.test.ts`) pins the
  renderer to golden fixtures in `tests/fixtures/` — if a render change is
  intentional, regenerate goldens deliberately and say so; never loosen
  tolerances to make a regression pass.

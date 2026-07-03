# gimpish

Agent-native image composition. Commands load `./scene.json`, mutate it, and save back.

TypeScript monorepo (Node 24, npm workspaces): `packages/core` (engine),
`packages/cli` (CLI + server), `packages/web` (editor UI). Node runs the .ts
sources directly — no build step for CLI/server; `npm run build` only bundles the
web app. Run the CLI as `npx gimpish …`.

## Speed when editing scenes
- Use `npx gimpish preview` (fast downscaled) for iteration; only `npx gimpish render` at full res at the end.
- Don't render + read the image back for changes whose result is obvious (opacity/reorder/rename). Batch mechanical edits, verify visually once at the end.

## Checks before committing
- `npm run check` (biome lint/format + strict tsc for all packages + full vitest suite) must pass.
- The pixel-parity suite (`packages/core/test/parity.test.ts`) pins the renderer
  to golden fixtures in `tests/fixtures/` — if a render change is intentional,
  regenerate goldens deliberately and say so; never loosen tolerances to make a
  regression pass.

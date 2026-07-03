# gimpish

Agent-native image composition. Commands load `./scene.json`, mutate it, and save back.

## Speed when editing scenes
- Use `gimpish preview` (fast downscaled) for iteration; only `gimpish render` at full res at the end.
- Activate the venv once per session, not per command.
- Don't render + read the image back for changes whose result is obvious (opacity/reorder/rename). Batch mechanical edits, verify visually once at the end.

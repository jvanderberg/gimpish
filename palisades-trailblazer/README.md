# Palisades Trailblazer — retro tee

A 70s/80s sunset-badge take on the Trailblazer shirt: banded sunset disc, dune
with dune grass off the right slope, trail winding up to the crest, hiker
silhouetted on the ridge. Only text on the shirt is "Palisades Trailblazer".

Separate from `../palisades-shirt`, which reconstructs the existing
cream-on-green printed tee. Nothing here touches that document.

## Edit in Gimpish

```bash
gimpish serve        # then open the printed URL
```

Sixteen layers. Six are full-canvas 2000×1900 SVGs sharing one viewBox, so they
stay registered. `grass-frond` is a compact standalone asset designed to be
duplicated, moved, scaled, and rotated in the editor; the scene starts with
eight independent copies. Both wordmarks are editable native text layers.

| Layer | Contents |
| --- | --- |
| `cream-background` | Toggleable full-canvas cream background; the canvas itself is transparent |
| `sky-disc` | Six sunset bands clipped to the disc, plus the outline ring |
| `dune` | Dune mass |
| `trail` | Tapered trail ribbon |
| `hiker-woman` | Organic traced woman hiker — pack, cap, trekking pole |
| `hiker-man` | Matching organic traced man hiker |
| `grass-frond` … `grass-frond-8` | Eight copies of one reusable dune-grass sprig |
| `palisades-wordmark` | Editable "PALISADES" text on a circular arc |
| `trailblazer-wordmark` | Editable straight "TRAILBLAZER" text |

## Regenerating

`build.py` is the source of truth for the artwork; the hiker contours come from
the generated traces in `assets/`, and `scene.json` only positions the layers.
Re-running rewrites the six full-canvas layer SVGs in place, and the editor
hot-reloads.

```bash
python3 build.py
```

Requires `fontTools` and `rsvg-convert` for the standalone outlined preview.
The live scene wordmarks use the locally installed Futura through Gimpish’s
native text renderer, so their content, size, tracking, and arc remain editable.

Things worth tuning at the top of `build.py`: `BANDS` (sky ramp), `DISC_*`
(disc placement), `DUNE_SEGS` (dune profile — the grass and the hiker's feet
are planted on this curve by sampling, so changing it moves them too),
`TRAIL_SEGS` / `TRAIL_W*`, `HIKER_X` / `HIKER_SCALE`, and the wordmark sizes.

The trail is clipped to the dune shape, so you can reshape `TRAIL_SEGS` freely
without it spilling over the ridge line.

## Colors

Flat spot colors, no gradients or opacity anywhere.

| Role | Hex |
| --- | --- |
| Background layer | `#E9DCBE` natural / oatmeal |
| Sky bands | `#F7E7B4` `#F3CB70` `#EDA63C` `#E0812C` `#C6521F` `#A2361A` |
| Dune, hiker, grass, type | `#3A2412` |
| Trail | `#F7E7B4` (same ink as the top sky band) |

That is **8 inks** if the cream background is printed, which is a lot of
screens. Fine for DTG or a digital
transfer as-is. For screenprint, either drop to 3–4 bands (edit `BANDS`) or
print it as a 4-color process/simulated-process job; hide `cream-background`
when the garment supplies that color.

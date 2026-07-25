"""70s-retro variant: the same tree and wordmarks over a banded sunset disc.

Flat colour bands only -- no gradients -- so it stays screenprintable, and every
band is a separate <path> you can pull a screen from. Type is outlined.
"""
import re
import subprocess

import textpath as tp
from build import (AT, TRACE_INNER, TREE_OUTER, measure_bbox, paths_to_group,
                   solve_tracking, traced_paths, wrap)

# ---------------------------------------------------------------- palette
# A flat 70s sunset: pale gold at the top down to rust at the horizon.
BANDS = ["#F6E3B0", "#F3CB70", "#EDA63C", "#E17C28", "#C6521F", "#A2361A"]
TIMBER = "#3A2412"     # tree + type
GARMENT = "#E9DCBE"    # natural/oatmeal tee, preview only

# ---------------------------------------------------------------- layout
DISC_CX, DISC_CY, DISC_R = 990.0, 815.0, 392.0
RING = 14.0            # outline weight around the disc

TOP_TEXT = "Palisades Park"
TOP_SIZE = 150.0
TOP_R = 640.0          # baseline radius, measured from the disc centre
TOP_TARGET_W = 1210.0

BOT_TEXT = "Trailblazers"
BOT_SIZE = TOP_SIZE
BOT_BASELINE = 1420.0


def disc_group():
    """Sunset disc: solid bands clipped to a circle, plus an outline ring."""
    top = DISC_CY - DISC_R
    h = (2 * DISC_R) / len(BANDS)
    parts = [f'  <clipPath id="disc">'
             f'<circle cx="{DISC_CX}" cy="{DISC_CY}" r="{DISC_R}"/></clipPath>']
    parts.append(f'  <g clip-path="url(#disc)">')
    for i, col in enumerate(BANDS):
        y = top + i * h
        # last band runs long so rounding can never leave a seam
        hh = h if i < len(BANDS) - 1 else h + 4
        parts.append(f'    <rect x="{DISC_CX-DISC_R-4:.1f}" y="{y:.2f}" '
                     f'width="{2*DISC_R+8:.1f}" height="{hh:.2f}" fill="{col}"/>')
    parts.append("  </g>")
    parts.append(f'  <circle cx="{DISC_CX}" cy="{DISC_CY}" r="{DISC_R-RING/2:.1f}" '
                 f'fill="none" stroke="{TIMBER}" stroke-width="{RING}"/>')
    return "\n".join(parts)


def traced_group(path, fill):
    inner = "".join(f'\n      <path d="{d}"/>' for d in traced_paths(path))
    return (f'  <g fill="{fill}" transform="{TREE_OUTER}">'
            f'\n    <g transform="{TRACE_INNER}">{inner}\n    </g>\n  </g>')


def build_art():
    at = tp.Face(AT, "AmericanTypewriter-Bold")
    groups = [disc_group()]

    # tree and hand lettering sit on top of the sunset
    groups.append(traced_group("tree_traced.svg", TIMBER))
    groups.append(traced_group("hug_traced.svg", TIMBER))

    t1 = solve_tracking(at, TOP_TEXT, TOP_SIZE, TOP_TARGET_W)
    top = tp.arc(at, TOP_TEXT, TOP_SIZE, DISC_CX, DISC_CY + TOP_R, TOP_R,
                 tracking=t1)
    groups.append(paths_to_group(top, TIMBER))

    tx0, _, tx1, _ = measure_bbox(paths_to_group(top, TIMBER))
    t2 = solve_tracking(at, BOT_TEXT, BOT_SIZE, tx1 - tx0)
    run = tp.measure(at, BOT_TEXT, BOT_SIZE, t2)
    bot = tp.straight(at, BOT_TEXT, BOT_SIZE, (tx0 + tx1) / 2 - run / 2,
                      BOT_BASELINE, tracking=t2)
    groups.append(paths_to_group(bot, TIMBER))

    print(f"arch spans x {tx0}..{tx1} ({tx1-tx0} px)")
    print(f"tracking: top={t1:.2f} bottom={t2:.2f}")
    return "\n".join(groups)


if __name__ == "__main__":
    art = build_art()
    bbox = measure_bbox(art)
    print("ink bbox:", bbox)
    open("retro_flat.svg", "w").write(wrap(art, bbox, 12.0, pad=10))
    open("retro_preview.svg", "w").write(wrap(art, bbox, 12.0, bg=GARMENT, pad=90))
    print("wrote retro_flat.svg, retro_preview.svg")

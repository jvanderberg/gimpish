"""Rebuild the Palisades Park Trailblazers shirt art as clean vector outlines.

Geometry is expressed in "photo pixels" (the 2000x1500 reference photo) so the
measurements taken off the original print can be used directly. The finished
art is then mapped to real print inches.
"""
import math
import re
import subprocess

import numpy as np

import textpath as tp

AT = "/System/Library/Fonts/Supplemental/AmericanTypewriter.ttc"
FUTURA = "/System/Library/Fonts/Supplemental/Futura.ttc"

# ---------------------------------------------------------------- palette
INK = "#F2E8D5"          # natural cream screenprint ink
GARMENT = "#2F3B31"      # dark forest green tee (preview only)

# ---------------------------------------------------------------- tree art
# potrace emitted tree_smooth.pbm pixel space (2350x1900) via this transform;
# tree_bw.png was crop 940x760+545+430 of the photo, scaled 250%.
TRACE_INNER = "translate(0.000000,1900.000000) scale(0.010000,-0.010000)"
TREE_OUTER = "translate(545,430) scale(0.4)"


def traced_paths(path):
    """All <path> data from a potrace SVG (same 2350x1900 bitmap space)."""
    ds = re.findall(r'<path d="(.*?)"', open(path).read(), re.S)
    if not ds:
        raise SystemExit(f"no paths in {path}")
    return ds


def traced_group(path, fill):
    inner = "".join(f'\n      <path d="{d}"/>' for d in traced_paths(path))
    return (f'  <g fill="{fill}" transform="{TREE_OUTER}">'
            f'\n    <g transform="{TRACE_INNER}">{inner}\n    </g>\n  </g>')


# ---------------------------------------------------------------- helpers
def fit_circle(pts):
    p = np.asarray(pts, float)
    x, y = p[:, 0], p[:, 1]
    sol, *_ = np.linalg.lstsq(np.c_[x, y, np.ones(len(p))], x**2 + y**2, rcond=None)
    cx, cy = sol[0] / 2, sol[1] / 2
    return cx, cy, math.sqrt(sol[2] + cx**2 + cy**2)


def solve_tracking(face, text, size, target_width):
    base = sum(face.advance(c, size) for c in text)
    return (target_width - base) / (len(text) - 1)


def paths_to_group(ds, fill):
    inner = "".join(f'\n    <path d="{d}"/>' for d in ds)
    return f'  <g fill="{fill}">{inner}\n  </g>'


# ---------------------------------------------------------------- layout
AXIS = 947.0            # vertical axis the arched type is centred on

# "Palisades Park": arched over. Baseline vertex measured at y=443.
TOP_TEXT = "Palisades Park"
TOP_SIZE = 138.0
TOP_R = 790.0
TOP_CY = 443.0 + TOP_R
TOP_TARGET_W = 1140.0   # arc length spanned by the original run

# "Trailblazers": set flat, same point size as the arch, letterspaced to the
# same horizontal width so the two wordmarks bracket the tree evenly.
BOT_TEXT = "Trailblazers"
BOT_SIZE = TOP_SIZE
BOT_BASELINE = 1195.0


def build_art():
    at = tp.Face(AT, "AmericanTypewriter-Semibold")
    groups = []

    # tree and the "hug a tree" lettering are both traced from the original
    groups.append(traced_group("tree_traced.svg", INK))
    groups.append(traced_group("hug_traced.svg", INK))

    # arched wordmarks, re-set in the original typeface as outlines
    t1 = solve_tracking(at, TOP_TEXT, TOP_SIZE, TOP_TARGET_W)
    top = tp.arc(at, TOP_TEXT, TOP_SIZE, AXIS, TOP_CY, TOP_R, tracking=t1)
    groups.append(paths_to_group(top, INK))

    # match the arch's horizontal extent exactly
    tx0, _, tx1, _ = measure_bbox(paths_to_group(top, INK))
    t2 = solve_tracking(at, BOT_TEXT, BOT_SIZE, tx1 - tx0)
    run = tp.measure(at, BOT_TEXT, BOT_SIZE, t2)
    bot = tp.straight(at, BOT_TEXT, BOT_SIZE, (tx0 + tx1) / 2 - run / 2,
                      BOT_BASELINE, tracking=t2)
    groups.append(paths_to_group(bot, INK))

    print(f"arch spans x {tx0}..{tx1} ({tx1-tx0} px)")
    print(f"tracking: top={t1:.2f} bottom={t2:.2f}  size {TOP_SIZE:.0f}/{BOT_SIZE:.0f}")
    return "\n".join(groups)


# ---------------------------------------------------------------- output
def wrap(art, bbox, inches_wide, bg=None, pad=0.0):
    x0, y0, x1, y1 = bbox
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    w, h = x1 - x0, y1 - y0
    scale = 1200.0 / w                     # 100 design units per inch
    vw, vh = 1200.0, h * scale
    inches_high = inches_wide * h / w
    rect = (f'\n  <rect x="0" y="0" width="{vw:.2f}" height="{vh:.2f}" fill="{bg}"/>'
            if bg else "")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1"\n'
            f'     width="{inches_wide:.3f}in" height="{inches_high:.3f}in"\n'
            f'     viewBox="0 0 {vw:.2f} {vh:.2f}">\n'
            f'  <title>Palisades Park Trailblazers</title>{rect}\n'
            f'  <g transform="scale({scale:.6f}) translate({-x0:.3f},{-y0:.3f})">\n'
            f'{art}\n'
            f'  </g>\n</svg>\n')


def measure_bbox(art):
    """Rasterise on a generous canvas and read back the ink bounds."""
    probe = (f'<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1500" '
             f'viewBox="0 0 2000 1500">{art}</svg>')
    open("_probe.svg", "w").write(probe)
    subprocess.run(["magick", "-density", "96", "-background", "none",
                    "_probe.svg", "_probe.png"], check=True)
    out = subprocess.run(["magick", "identify", "-format", "%@", "_probe.png"],
                         capture_output=True, text=True, check=True).stdout
    m = re.match(r"(\d+)x(\d+)\+(-?\d+)\+(-?\d+)", out.strip())
    w, h, x, y = (int(v) for v in m.groups())
    return (x, y, x + w, y + h)


if __name__ == "__main__":
    art = build_art()
    bbox = measure_bbox(art)
    print("ink bbox (photo px):", bbox)

    open("repro_flat.svg", "w").write(wrap(art, bbox, 12.0, pad=8))
    open("repro_preview.svg", "w").write(wrap(art, bbox, 12.0, bg=GARMENT, pad=60))
    print("wrote repro_flat.svg, repro_preview.svg")

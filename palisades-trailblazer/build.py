"""70s/80s retro "Palisades Trailblazer" tee art.

A banded sunset disc, a dune with dune grass off to the right, a trail winding
up to the crest, and a hiker silhouetted on the ridge against the sky.

Everything is flat colour -- no gradients, no opacity. The scene wordmarks are
editable native text layers; only the standalone preview converts them to
outlines. Generated artwork elements use registered full-canvas SVG layers,
while the reusable grass asset stays compact.

    python3 build.py          # writes the layer SVGs + preview.png
"""
import math
import subprocess
import xml.etree.ElementTree as ET

import textpath as tp

W, H = 2000.0, 1900.0

FUTURA = "/System/Library/Fonts/Supplemental/Futura.ttc"

# ---------------------------------------------------------------- palette
# Flat 70s sunset, pale gold at the top down to rust at the horizon.
BANDS = ["#F7E7B4", "#F3CB70", "#EDA63C", "#E0812C", "#C6521F", "#A2361A"]
TIMBER = "#3A2412"    # dune, hiker, grass, type
TRAIL = "#F7E7B4"     # same as the top sky band
CREAM = "#E9DCBE"     # dedicated, toggleable background layer

# ---------------------------------------------------------------- layout
DISC_CX, DISC_CY, DISC_R = 1000.0, 900.0, 545.0
RING = 22.0           # outline weight around the disc

# Dune top edge as cubic segments, left rim of the disc across to the right.
# Kept as segments (not a path string) so the surface can be sampled: the
# grass and the hiker's feet are planted on the curve rather than guessed at.
DUNE_SEGS = [
    ((430, 1250), (600, 1226), (760, 1180), (880, 1120)),
    ((880, 1120), (970, 1076), (1040, 1024), (1130, 1000)),
    ((1130, 1000), (1230, 974), (1310, 992), (1400, 1022)),
    ((1400, 1022), (1470, 1044), (1530, 1066), (1580, 1082)),
]
DUNE_FOOT = 1520.0    # dune fill runs down past the disc

# Trail centreline, bottom of the disc winding up to the crest. Clipped to the
# dune, so it can never spill over the ridge no matter how it is shaped.
TRAIL_SEGS = [
    ((1010, 1470), (952, 1360), (866, 1318), (836, 1232)),
    ((836, 1232), (806, 1130), (982, 1104), (1130, 1000)),
]
TRAIL_W0, TRAIL_W1 = 128.0, 13.0   # half-widths, start -> end

HIKER_X = 1128.0
HIKER_SCALE = 1.12
HIKER_WOMAN_TRACE = "assets/hiker-generated-trace.svg"
HIKER_MAN_TRACE = "assets/hiker-man-generated-trace.svg"

# Wordmark: "PALISADES" arcs concentrically outside the ring, "TRAILBLAZER"
# sits flat underneath.
TOP_TEXT = "PALISADES"
BOT_TEXT = "TRAILBLAZER"
TOP_SIZE = 176.0
TOP_ARC_R = 628.0
TOP_TARGET_W = 1070.0              # arc length the run should span
BOT_SIZE = 250.0
BOT_BASELINE = 1700.0


# ---------------------------------------------------------------- helpers
def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return (u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1])


def bezier_tangent(p0, p1, p2, p3, t):
    u = 1 - t
    return (3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
            3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]))


def segs_to_path(segs):
    d = f"M {segs[0][0][0]:.1f} {segs[0][0][1]:.1f}"
    for _, p1, p2, p3 in segs:
        d += f" C {p1[0]:.1f} {p1[1]:.1f} {p2[0]:.1f} {p2[1]:.1f} {p3[0]:.1f} {p3[1]:.1f}"
    return d


def dune_y(x):
    """Height of the dune surface at x, by binary search on the segment."""
    for seg in DUNE_SEGS:
        if not (seg[0][0] <= x <= seg[3][0]):
            continue
        lo, hi = 0.0, 1.0
        for _ in range(40):
            mid = (lo + hi) / 2
            if bezier(*seg, mid)[0] < x:
                lo = mid
            else:
                hi = mid
        return bezier(*seg, (lo + hi) / 2)[1]
    return DUNE_SEGS[0][0][1] if x < DUNE_SEGS[0][0][0] else DUNE_SEGS[-1][3][1]


def capsule(x0, y0, x1, y1, width):
    """A round-capped stroke. Rendered as a stroke but reads as a solid
    silhouette shape, which is all the hiker needs."""
    return (f'<path d="M {x0:.1f} {y0:.1f} L {x1:.1f} {y1:.1f}" '
            f'stroke-width="{width:.1f}" stroke-linecap="round" fill="none"/>')


def polyline(pts, width):
    d = " ".join(("M" if i == 0 else "L") + f" {x:.1f} {y:.1f}" for i, (x, y) in enumerate(pts))
    return (f'<path d="{d}" stroke-width="{width:.1f}" stroke-linecap="round" '
            f'stroke-linejoin="round" fill="none"/>')


def defs():
    return (f'<defs>'
            f'<clipPath id="disc"><circle cx="{DISC_CX}" cy="{DISC_CY}" r="{DISC_R}"/></clipPath>'
            f'<clipPath id="dune"><path d="{dune_path()}"/></clipPath>'
            f'</defs>')


def dune_path():
    return (segs_to_path(DUNE_SEGS) +
            f" L {DUNE_SEGS[-1][3][0]:.1f} {DUNE_FOOT:.1f}"
            f" L {DUNE_SEGS[0][0][0]:.1f} {DUNE_FOOT:.1f} Z")


# ---------------------------------------------------------------- elements
def sky_disc():
    """Sunset bands clipped to the disc, plus the heavy outline ring."""
    top = DISC_CY - DISC_R
    h = (2 * DISC_R) / len(BANDS)
    out = ['<g clip-path="url(#disc)">']
    for i, col in enumerate(BANDS):
        y = top + i * h
        hh = h if i < len(BANDS) - 1 else h + 6   # overrun so rounding can't seam
        out.append(f'  <rect x="{DISC_CX-DISC_R-6:.1f}" y="{y:.2f}" '
                   f'width="{2*DISC_R+12:.1f}" height="{hh:.2f}" fill="{col}"/>')
    out.append("</g>")
    out.append(f'<circle cx="{DISC_CX}" cy="{DISC_CY}" r="{DISC_R-RING/2:.1f}" '
               f'fill="none" stroke="{TIMBER}" stroke-width="{RING}"/>')
    return "\n".join(out)


def cream_background():
    """Full-canvas cream background, kept separate from the transparent canvas."""
    return f'<rect x="0" y="0" width="{W:.0f}" height="{H:.0f}" fill="{CREAM}"/>'


def dune():
    """Dune mass only; grass is a separate reusable scene layer."""
    return f'<path d="{dune_path()}" fill="{TIMBER}"/>'


def grass_frond():
    """One compact, reusable sprig of dune grass in local asset coordinates."""
    blades = [
        # base x, control x/y, tip x/y, half-width at base
        (58, 46, 78, 22, 22, 4.8),
        (60, 53, 60, 49, 6, 5.2),
        (62, 72, 72, 94, 28, 4.8),
        (59, 39, 102, 12, 62, 4.2),
        (63, 82, 105, 111, 62, 4.2),
    ]
    paths = []
    for x, cx, cy, tx, ty, half in blades:
        paths.append(
            f'<path d="M {x-half:.1f} 164 '
            f'Q {cx-half*0.45:.1f} {cy:.1f} {tx:.1f} {ty:.1f} '
            f'Q {cx+half*0.45:.1f} {cy:.1f} {x+half:.1f} 164 Z"/>'
        )
    return f'<g fill="{TIMBER}">\n  ' + "\n  ".join(paths) + "\n</g>"


def trail():
    """Tapered ribbon: sample the centreline, offset along the normal."""
    steps = 60
    left, right = [], []
    total = len(TRAIL_SEGS)
    for s, seg in enumerate(TRAIL_SEGS):
        for i in range(steps + 1):
            if s > 0 and i == 0:
                continue                      # seam already emitted
            t = i / steps
            g = (s + t) / total               # 0..1 along the whole trail
            x, y = bezier(*seg, t)
            tx, ty = bezier_tangent(*seg, t)
            n = math.hypot(tx, ty) or 1.0
            nx, ny = -ty / n, tx / n
            hw = TRAIL_W0 + (TRAIL_W1 - TRAIL_W0) * (g ** 0.78)
            left.append((x + nx * hw, y + ny * hw))
            right.append((x - nx * hw, y - ny * hw))
    pts = left + right[::-1]
    d = " ".join(("M" if i == 0 else "L") + f" {x:.1f} {y:.1f}" for i, (x, y) in enumerate(pts))
    return f'<path d="{d} Z" fill="{TRAIL}"/>'


def hiker(trace_path, trace_w, trace_h):
    """Organic generated silhouette, traced to a single-color vector."""
    root = ET.parse(trace_path).getroot()
    view_box = root.attrib["viewBox"]
    group = next(child for child in root if child.tag.endswith("g"))
    group.set("fill", TIMBER)
    body = ET.tostring(group, encoding="unicode")

    # Fit the traced figure into the same local footprint as the old hiker so
    # the scene layer's transforms and ridge placement remain stable.
    local_h = 280.0
    local_w = local_h * trace_w / trace_h
    b = (f'<svg x="{-local_w/2:.1f}" y="{-local_h:.1f}" '
         f'width="{local_w:.1f}" height="{local_h:.1f}" '
         f'viewBox="{view_box}" preserveAspectRatio="xMidYMid meet">{body}</svg>')
    y = dune_y(HIKER_X) + 4
    return (f'<g transform="translate({HIKER_X:.1f} {y:.1f}) scale({HIKER_SCALE})">\n'
            + b + "\n</g>")


def wordmarks():
    face = tp.Face(FUTURA, "Futura-CondensedExtraBold")

    base = sum(face.advance(c, TOP_SIZE) for c in TOP_TEXT)
    track = (TOP_TARGET_W - base) / (len(TOP_TEXT) - 1)
    top = tp.arc(face, TOP_TEXT, TOP_SIZE, DISC_CX, DISC_CY, TOP_ARC_R, tracking=track)

    run = tp.measure(face, BOT_TEXT, BOT_SIZE, 0.0)
    bot = tp.straight(face, BOT_TEXT, BOT_SIZE, DISC_CX - run / 2, BOT_BASELINE)

    top_paths = "".join(f'\n  <path d="{d}"/>' for d in top)
    bot_paths = "".join(f'\n  <path d="{d}"/>' for d in bot)
    return (
        f'<g fill="{TIMBER}">{top_paths}\n</g>',
        f'<g fill="{TIMBER}">{bot_paths}\n</g>',
    )


# ---------------------------------------------------------------- output
def layer(body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" '
            f'viewBox="0 0 {W:.0f} {H:.0f}">\n{defs()}\n{body}\n</svg>\n')


def art():
    """Generated SVG assets, in draw order; wordmarks stay native text layers."""
    woman = hiker(HIKER_WOMAN_TRACE, 584.617882, 958.660104)
    man = hiker(HIKER_MAN_TRACE, 597.020804, 976.549741)
    return [
        ("cream-background", cream_background()),
        ("sky-disc", sky_disc()),
        ("dune", f'<g clip-path="url(#disc)">\n{dune()}\n</g>'),
        # trail is clipped to the dune as well, so it can never cross the ridge
        ("trail", f'<g clip-path="url(#disc)"><g clip-path="url(#dune)">\n{trail()}\n</g></g>'),
        ("hiker-woman", f'<g clip-path="url(#disc)">\n{woman}\n</g>'),
        ("hiker-man", f'<g clip-path="url(#disc)">\n{man}\n</g>'),
    ]


def main():
    stack = art()
    for name, body in stack:
        open(f"{name}-layer.svg", "w").write(layer(body))
        print("wrote", f"{name}-layer.svg")

    frond = (f'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="170" '
             f'viewBox="0 0 120 170">\n{grass_frond()}\n</svg>\n')
    open("grass-frond.svg", "w").write(frond)
    print("wrote grass-frond.svg")

    flat = [defs()]
    flat += [body for _, body in stack]
    flat.append(f'<g transform="translate(1410 888)">{grass_frond()}</g>')
    # The standalone preview keeps outlined type for portability; scene.json
    # uses editable browser-native text layers instead.
    flat += list(wordmarks())
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" '
           f'viewBox="0 0 {W:.0f} {H:.0f}">\n' + "\n".join(flat) + "\n</svg>\n")
    open("preview.svg", "w").write(svg)
    subprocess.run(["rsvg-convert", "-w", "1100", "preview.svg", "-o", "preview.png"], check=True)
    print("wrote preview.svg, preview.png")


if __name__ == "__main__":
    main()

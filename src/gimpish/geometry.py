"""Pure geometry/color helpers — no pyvips dependency, easy to unit-test.

Semantic placement verbs (fit/fill/cover + anchor) resolve to concrete pixel
transforms here; the agent expresses intent and we write pixels into the scene.
"""

from __future__ import annotations

from typing import Tuple

RGBA = Tuple[int, int, int, int]

# anchor -> (fx, fy) where 0 = left/top, 0.5 = center, 1 = right/bottom
ANCHORS: dict[str, Tuple[float, float]] = {
    "top-left": (0.0, 0.0),
    "top": (0.5, 0.0),
    "top-right": (1.0, 0.0),
    "left": (0.0, 0.5),
    "center": (0.5, 0.5),
    "right": (1.0, 0.5),
    "bottom-left": (0.0, 1.0),
    "bottom": (0.5, 1.0),
    "bottom-right": (1.0, 1.0),
}


def parse_color(text: str) -> RGBA:
    """Parse '#rgb', '#rrggbb', '#rrggbbaa' (alpha optional, defaults opaque)."""
    s = text.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) == 6:
        s += "ff"
    if len(s) != 8:
        raise ValueError(f"bad color {text!r}: expected #rgb, #rrggbb, or #rrggbbaa")
    try:
        r, g, b, a = (int(s[i : i + 2], 16) for i in (0, 2, 4, 6))
    except ValueError as exc:
        raise ValueError(f"bad color {text!r}") from exc
    return (r, g, b, a)


def resolve_fit(
    src_w: int,
    src_h: int,
    canvas_w: int,
    canvas_h: int,
    mode: str,
    percent: float = 100.0,
    anchor: str = "center",
) -> Tuple[float, float, float]:
    """Return (scale, x, y) placing a src_w x src_h image on the canvas.

    mode:
      fit   -> contain inside a box of (percent% of canvas), centered/anchored
      fill  -> cover the whole canvas (percent scales the cover), overflow cropped
      cover -> alias of fill
    """
    frac = percent / 100.0
    if mode == "fit":
        box_w = canvas_w * frac
        box_h = canvas_h * frac
        scale = min(box_w / src_w, box_h / src_h)
    elif mode in ("fill", "cover"):
        scale = max(canvas_w / src_w, canvas_h / src_h) * frac
    else:
        raise ValueError(f"unknown fit mode {mode!r} (use fit|fill|cover)")

    scaled_w = src_w * scale
    scaled_h = src_h * scale
    fx, fy = ANCHORS.get(anchor, (0.5, 0.5))
    x = (canvas_w - scaled_w) * fx
    y = (canvas_h - scaled_h) * fy
    return scale, x, y


def parse_stops(text: str) -> list[dict]:
    """Parse 'at:color, at:color, ...' e.g. '0:#000000ff, 1:#00000000'."""
    stops = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        at_str, _, color = part.partition(":")
        if not color:
            raise ValueError(f"bad gradient stop {part!r}: expected 'position:#color'")
        stops.append({"at": float(at_str), "color": color.strip()})
    if len(stops) < 2:
        raise ValueError("gradient needs at least 2 stops")
    return sorted(stops, key=lambda s: s["at"])

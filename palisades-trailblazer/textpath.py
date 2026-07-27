"""Set text as SVG outline paths, straight or on a circular arc.

Print vendors need type converted to outlines, so nothing here emits <text>.
Every glyph becomes a <path> with a baked affine transform.
"""
from fontTools.misc.transform import Transform
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection, TTFont

_CACHE = {}


def load(path, ps_name=None):
    """Load a face by PostScript name, from a .ttc collection or plain .ttf."""
    key = (path, ps_name)
    if key in _CACHE:
        return _CACHE[key]
    if path.endswith(".ttc"):
        for f in TTCollection(path).fonts:
            if ps_name is None or f["name"].getDebugName(6) == ps_name:
                font = f
                break
        else:
            raise KeyError(f"{ps_name} not in {path}")
    else:
        font = TTFont(path)
    _CACHE[key] = font
    return font


class Face:
    def __init__(self, path, ps_name=None):
        self.font = load(path, ps_name)
        self.upem = self.font["head"].unitsPerEm
        self.glyphset = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.hmtx = self.font["hmtx"]

    def gname(self, ch):
        try:
            return self.cmap[ord(ch)]
        except KeyError:
            raise KeyError(f"no glyph for {ch!r}")

    def advance(self, ch, size):
        return self.hmtx[self.gname(ch)][0] / self.upem * size

    def outline(self, ch, transform):
        """SVG path data for one glyph under `transform` (font units in)."""
        pen = SVGPathPen(self.glyphset, ntos=lambda v: f"{v:.3f}")
        self.glyphset[self.gname(ch)].draw(TransformPen(pen, transform))
        return pen.getCommands()


def _glyph_scale(size, upem):
    # font units are y-up; SVG is y-down
    return Transform().scale(size / upem, -size / upem)


def straight(face, text, size, x, y, tracking=0.0, pre=None):
    """Baseline-left text at (x, y). Returns list of path-data strings."""
    out = []
    cur = x
    for ch in text:
        adv = face.advance(ch, size)
        t = Transform().translate(cur, y)
        if pre is not None:
            t = pre.transform(t)
        d = face.outline(ch, t.transform(_glyph_scale(size, face.upem)))
        if d.strip():
            out.append(d)
        cur += adv + tracking
    return out


def measure(face, text, size, tracking=0.0):
    if not text:
        return 0.0
    return sum(face.advance(c, size) for c in text) + tracking * (len(text) - 1)


def arc(face, text, size, cx, cy, radius, tracking=0.0, under=False,
        rotate=0.0, sweep_center=0.0, pre=None):
    """Set `text` on a circle of `radius` centred at (cx, cy).

    under=False -> arch over the top of the circle (convex up).
    under=True  -> follow the bottom of the circle (concave up).
    rotate      -> extra rotation in degrees about (cx, cy).
    sweep_center-> shift the run's midpoint along the arc, in degrees.
    """
    import math

    width = measure(face, text, size, tracking)
    total = width / radius  # radians subtended
    a = math.radians(sweep_center) - total / 2.0
    spin = Transform().translate(cx, cy).rotate(math.radians(rotate)).translate(-cx, -cy)
    if pre is not None:
        spin = pre.transform(spin)

    out = []
    for ch in text:
        adv = face.advance(ch, size)
        step = (adv + tracking) / radius
        mid = a + (adv / radius) / 2.0
        if under:
            px = cx + radius * math.sin(mid)
            py = cy + radius * math.cos(mid)
            glyph_rot = -mid
        else:
            px = cx + radius * math.sin(mid)
            py = cy - radius * math.cos(mid)
            glyph_rot = mid
        t = (spin.translate(px, py)
                 .rotate(glyph_rot)
                 .translate(-adv / 2.0, 0)
                 .transform(_glyph_scale(size, face.upem)))
        d = face.outline(ch, t)
        if d.strip():
            out.append(d)
        a += step
    return out

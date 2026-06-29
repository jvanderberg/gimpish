"""The single render path (pyvips). Used by preview / render / export / serve.

Every layer is rendered to an RGBA image plus a top-left offset, embedded onto a
canvas-sized transparent frame, then composited bottom-to-top with its blend mode.
Doing the embed step keeps the frame a fixed size and makes negative offsets and
overflow behave (they're simply cropped).
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple

import pyvips

from .geometry import ANCHORS, RGBA, parse_color
from .scene import Layer, Mask, Scene

# Map our blend names to libvips composite modes. "normal" == Porter-Duff "over".
BLEND_MODES = {
    "normal": "over",
    "multiply": "multiply",
    "screen": "screen",
    "overlay": "overlay",
    "darken": "darken",
    "lighten": "lighten",
    "color-dodge": "colour-dodge",
    "color-burn": "colour-burn",
    "hard-light": "hard-light",
    "soft-light": "soft-light",
    "difference": "difference",
    "exclusion": "exclusion",
    "add": "add",
}

SHAPE_SUPERSAMPLE = 4  # render ellipses at NxN then shrink for cheap anti-aliasing


# ---- low-level pyvips helpers ----------------------------------------------------


def _srgb(img: pyvips.Image) -> pyvips.Image:
    """Tag a 4-band uchar image as sRGB so composite2 has a known colourspace."""
    return img.copy(interpretation="srgb")


def _solid(w: int, h: int, rgba: RGBA) -> pyvips.Image:
    """A w x h image filled with one RGBA color (uchar, 4 bands)."""
    return _srgb((pyvips.Image.black(w, h, bands=4) + list(rgba)).cast("uchar"))


def _transparent(w: int, h: int) -> pyvips.Image:
    return _srgb(pyvips.Image.black(w, h, bands=4))  # zeros incl alpha => transparent


def _ensure_rgba(img: pyvips.Image) -> pyvips.Image:
    img = img.colourspace("srgb")
    if not img.hasalpha():
        img = img.addalpha()
    return img.extract_band(0, n=4)


def _apply_opacity(img: pyvips.Image, opacity: float) -> pyvips.Image:
    if opacity >= 1.0:
        return img
    alpha = (img.extract_band(3) * opacity).cast("uchar")
    return _srgb(img.extract_band(0, n=3).bandjoin(alpha))


def _mask_solid(w: int, h: int, rgba: RGBA, mask: pyvips.Image) -> pyvips.Image:
    """Solid color whose alpha is gated by a 0..255 single-band mask."""
    solid = _solid(w, h, rgba)
    alpha = (solid.extract_band(3) * (mask / 255.0)).cast("uchar")
    return _srgb(solid.extract_band(0, n=3).bandjoin(alpha))


# ---- masks -----------------------------------------------------------------------


def _load_mask_band(scene: Scene, mask: Mask, w: int, h: int) -> pyvips.Image:
    """Return a single-band uchar (0..255) mask sized to (w, h)."""
    root = scene.path.parent if scene.path else Path.cwd()
    if mask.kind == "cutout":
        if not mask.cache:
            raise ValueError("cutout mask missing cache path")
        m = pyvips.Image.new_from_file(str(root / mask.cache))
        band = m.extract_band(3) if m.hasalpha() else m.colourspace("b-w").extract_band(0)
    elif mask.kind == "image":
        if not mask.source:
            raise ValueError("image mask missing source path")
        m = pyvips.Image.new_from_file(str(root / mask.source))
        band = m.extract_band(3) if m.hasalpha() else m.colourspace("b-w").extract_band(0)
    elif mask.kind == "shape":
        band = _shape_mask(mask, w, h)
    else:
        raise ValueError(f"unknown mask kind {mask.kind!r}")

    if band.width != w or band.height != h:
        band = band.resize(w / band.width, vscale=h / band.height)
    if mask.invert:
        band = 255 - band
    if mask.feather and mask.feather > 0:
        band = band.gaussblur(float(mask.feather))
    return band.cast("uchar")


def _shape_mask(mask: Mask, w: int, h: int) -> pyvips.Image:
    rect = mask.rect or {"x": 0, "y": 0, "w": w, "h": h}
    out = pyvips.Image.black(w, h)  # 0
    rx, ry = float(rect["x"]), float(rect["y"])
    rw, rh = float(rect["w"]), float(rect["h"])
    if mask.shape == "ellipse":
        xy = pyvips.Image.xyz(w, h)
        cx, cy = rx + rw / 2, ry + rh / 2
        nx = (xy.extract_band(0) - cx) / (rw / 2)
        ny = (xy.extract_band(1) - cy) / (rh / 2)
        inside = (nx * nx + ny * ny) <= 1.0
        out = inside.ifthenelse(255, 0)
    else:  # rect (default)
        block = (pyvips.Image.black(int(rw), int(rh)) + 255).cast("uchar")
        out = out.insert(block, int(rx), int(ry))
    return out.cast("uchar")


# ---- per-layer rendering ---------------------------------------------------------


def _render_image(scene: Scene, layer: Layer) -> Tuple[pyvips.Image, float, float]:
    if not layer.source:
        raise ValueError(f"image layer {layer.id!r} has no source")
    root = scene.path.parent if scene.path else Path.cwd()
    img = _ensure_rgba(pyvips.Image.new_from_file(str(root / layer.source)))

    if layer.mask:
        m = _load_mask_band(scene, layer.mask, img.width, img.height)
        alpha = (img.extract_band(3) * (m / 255.0)).cast("uchar")
        img = _srgb(img.extract_band(0, n=3).bandjoin(alpha))

    t = layer.transform
    if t.scale != 1.0:
        img = img.resize(t.scale)

    x, y = t.x, t.y
    if t.rotation:
        cx, cy = x + img.width / 2, y + img.height / 2
        img = img.similarity(angle=t.rotation)
        x, y = cx - img.width / 2, cy - img.height / 2
    return img, x, y


def _render_shape(layer: Layer) -> Tuple[pyvips.Image, float, float]:
    rect = layer.rect or {}
    w, h = int(rect.get("w", 0)), int(rect.get("h", 0))
    if w <= 0 or h <= 0:
        raise ValueError(f"shape layer {layer.id!r} needs positive w/h")
    fill = parse_color(layer.fill) if layer.fill else None
    stroke = parse_color(layer.stroke) if layer.stroke else None
    sw = int(layer.stroke_width)

    if layer.shape == "ellipse":
        img = _render_ellipse(w, h, fill, stroke, sw)
    else:
        img = _render_rect(w, h, fill, stroke, sw)
    return img, float(rect.get("x", 0)), float(rect.get("y", 0))


def _render_rect(w, h, fill, stroke, sw) -> pyvips.Image:
    if stroke and sw > 0:
        out = _solid(w, h, stroke)
        iw, ih = max(w - 2 * sw, 0), max(h - 2 * sw, 0)
        if iw and ih:
            inner = _solid(iw, ih, fill) if fill else _transparent(iw, ih)
            out = out.composite2(inner, "source", x=sw, y=sw)
        return out
    return _solid(w, h, fill) if fill else _transparent(w, h)


def _render_ellipse(w, h, fill, stroke, sw) -> pyvips.Image:
    s = SHAPE_SUPERSAMPLE
    W, H, SW = w * s, h * s, sw * s
    xy = pyvips.Image.xyz(W, H)
    cx, cy = W / 2, H / 2

    def disc(margin: float) -> pyvips.Image:
        rx, ry = max(W / 2 - margin, 0.001), max(H / 2 - margin, 0.001)
        nx = (xy.extract_band(0) - cx) / rx
        ny = (xy.extract_band(1) - cy) / ry
        return ((nx * nx + ny * ny) <= 1.0).ifthenelse(255, 0)

    out = _transparent(W, H)
    if stroke and SW > 0:
        ring = (disc(0) - disc(SW)).cast("uchar")  # outer minus inner
        out = out.composite2(_mask_solid(W, H, stroke, ring), "over")
        if fill:
            out = out.composite2(_mask_solid(W, H, fill, disc(SW)), "over")
    elif fill:
        out = out.composite2(_mask_solid(W, H, fill, disc(0)), "over")
    return out.resize(1.0 / s)


def _render_gradient(scene: Scene, layer: Layer) -> Tuple[pyvips.Image, float, float]:
    import math

    g = layer.gradient or {}
    W, H = scene.canvas.width, scene.canvas.height
    stops = sorted(g.get("stops", []), key=lambda s: s["at"])
    if len(stops) < 2:
        raise ValueError("gradient needs >= 2 stops")
    lut = _gradient_lut(stops)
    xy = pyvips.Image.xyz(W, H)

    if g.get("kind") == "radial":
        fx, fy = ANCHORS.get(g.get("anchor", "center"), (0.5, 0.5))
        cx, cy = fx * W, fy * H
        dx, dy = xy.extract_band(0) - cx, xy.extract_band(1) - cy
        dist = (dx * dx + dy * dy) ** 0.5
        corners = [(0, 0), (W, 0), (0, H), (W, H)]
        maxd = max(math.hypot(px - cx, py - cy) for px, py in corners) or 1.0
        t = dist / maxd
    else:  # linear
        angle = g.get("angle")
        if angle is not None:
            rad = math.radians(angle)
            dvx, dvy = math.cos(rad), math.sin(rad)
        else:
            fx, fy = ANCHORS.get(g.get("anchor", "top"), (0.5, 0.0))
            dvx, dvy = 0.5 - fx, 0.5 - fy
            norm = math.hypot(dvx, dvy) or 1.0
            dvx, dvy = dvx / norm, dvy / norm
            if dvx == 0 and dvy == 0:  # centered linear is meaningless -> top->bottom
                dvx, dvy = 0.0, 1.0
        proj = xy.extract_band(0) * dvx + xy.extract_band(1) * dvy
        corners = [px * dvx + py * dvy for px, py in [(0, 0), (W, 0), (0, H), (W, H)]]
        pmin, pmax = min(corners), max(corners)
        t = (proj - pmin) / max(pmax - pmin, 1e-6)

    idx = (t.maxpair(0.0).minpair(1.0) * 255).cast("uchar")
    return _srgb(idx.maplut(lut)), 0.0, 0.0


def _gradient_lut(stops: list[dict]) -> pyvips.Image:
    """Build a 256x1, 4-band uchar LUT from sorted gradient stops."""
    cols = [parse_color(s["color"]) for s in stops]
    pos = [max(0.0, min(1.0, s["at"])) for s in stops]
    buf = bytearray(256 * 4)
    for i in range(256):
        tt = i / 255.0
        if tt <= pos[0]:
            c = cols[0]
        elif tt >= pos[-1]:
            c = cols[-1]
        else:
            j = 0
            while j < len(pos) - 1 and not (pos[j] <= tt <= pos[j + 1]):
                j += 1
            span = max(pos[j + 1] - pos[j], 1e-9)
            f = (tt - pos[j]) / span
            c = tuple(round(cols[j][k] + f * (cols[j + 1][k] - cols[j][k])) for k in range(4))
        buf[i * 4 : i * 4 + 4] = bytes(c)
    return pyvips.Image.new_from_memory(bytes(buf), 256, 1, 4, "uchar")


# ---- scene composition -----------------------------------------------------------


def render_scene(
    scene: Scene, width: Optional[int] = None, height: Optional[int] = None
) -> pyvips.Image:
    """Composite the whole scene; optionally scale the result to width/height."""
    W, H = scene.canvas.width, scene.canvas.height
    bg = scene.canvas.background
    base = _transparent(W, H) if bg in (None, "transparent") else _solid(W, H, parse_color(bg))

    for layer in scene.layers:
        if not layer.visible:
            continue
        if layer.type == "image":
            img, x, y = _render_image(scene, layer)
        elif layer.type == "shape":
            img, x, y = _render_shape(layer)
        elif layer.type == "gradient":
            img, x, y = _render_gradient(scene, layer)
        else:
            raise ValueError(f"unknown layer type {layer.type!r}")

        img = _apply_opacity(img, layer.opacity)
        placed = img.embed(round(x), round(y), W, H, extend="black")
        mode = BLEND_MODES.get(layer.blend, "over")
        base = base.composite2(placed, mode, x=0, y=0)

    if width or height:
        sx = (width / W) if width else (height / H)
        sy = (height / H) if height else sx
        base = base.resize(sx, vscale=sy)
    return base.cast("uchar")


def render_to_file(scene: Scene, out: Path, width=None, height=None, **save_opts) -> Path:
    img = render_scene(scene, width=width, height=height)
    out = Path(out)
    if out.suffix.lower() in (".jpg", ".jpeg"):
        img = img.flatten(background=[255, 255, 255])  # jpeg has no alpha
    img.write_to_file(str(out), **save_opts)
    return out


def render_preview(scene: Scene, max_dim: int = 1024) -> pyvips.Image:
    W, H = scene.canvas.width, scene.canvas.height
    if max(W, H) <= max_dim:
        return render_scene(scene)
    scale = max_dim / max(W, H)
    return render_scene(scene, width=round(W * scale), height=round(H * scale))

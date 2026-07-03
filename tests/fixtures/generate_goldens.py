"""Golden-fixture generator — run against the ORIGINAL Python engine (commit d70b4ac).

Creates deterministic source images + fixture scenes covering every render feature,
then renders each scene with the pyvips engine into golden/<name>.png. The TypeScript
renderer must reproduce these within the pixel-diff tolerances in the parity tests.

Provenance: `python tests/fixtures/generate_goldens.py` with src/gimpish from d70b4ac.
"""

from __future__ import annotations

import json
from pathlib import Path

import pyvips

HERE = Path(__file__).parent
ASSETS = HERE / "assets"
SCENES = HERE / "scenes"
GOLDEN = HERE / "golden"


# ---- deterministic source images ---------------------------------------------------


def make_photo(path: Path) -> None:
    """320x240 test pattern: horizontal hue ramp + circles, opaque."""
    xy = pyvips.Image.xyz(320, 240)
    x, y = xy[0], xy[1]
    r = (x * 255.0 / 320).cast("uchar")
    g = (y * 255.0 / 240).cast("uchar")
    b = ((x + y) * 255.0 / 560).cast("uchar")
    img = r.bandjoin([g, b]).copy(interpretation="srgb")
    # white circle center, black ring
    cx, cy = 160, 120
    d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy)
    img = (d2 <= 40 * 40).ifthenelse([255, 255, 255], img)
    img = ((d2 > 55 * 55) & (d2 <= 65 * 65)).ifthenelse([0, 0, 0], img)
    img.write_to_file(str(path))


def make_sprite(path: Path) -> None:
    """200x200 RGBA sprite: red diamond on transparent, soft alpha edge."""
    xy = pyvips.Image.xyz(200, 200)
    x, y = xy[0], xy[1]
    manhattan = (x - 100).abs() + (y - 100).abs()
    alpha = (255.0 * (90 - manhattan) / 20).maxpair(0.0).minpair(255.0).cast("uchar")
    rgb = (pyvips.Image.black(200, 200, bands=3) + [220, 40, 60]).cast("uchar")
    rgb.bandjoin(alpha).copy(interpretation="srgb").write_to_file(str(path))


def make_gray_mask(path: Path) -> None:
    """320x240 grayscale mask: vertical white->black ramp."""
    xy = pyvips.Image.xyz(320, 240)
    (255.0 - xy[1] * 255.0 / 240).cast("uchar").write_to_file(str(path))


def make_cutout(path: Path) -> None:
    """320x240 RGBA 'cutout' (as rembg would emit): photo with elliptical alpha."""
    photo = pyvips.Image.new_from_file(str(ASSETS / "photo.png"))
    xy = pyvips.Image.xyz(320, 240)
    nx = (xy[0] - 160) / 110.0
    ny = (xy[1] - 120) / 80.0
    alpha = ((nx * nx + ny * ny) <= 1.0).ifthenelse(255, 0).cast("uchar")
    photo.bandjoin(alpha).copy(interpretation="srgb").write_to_file(str(path))


# ---- fixture scenes -----------------------------------------------------------------


def layer_defaults(d: dict) -> dict:
    out = {"name": d.get("id", ""), "opacity": 1.0, "blend": "normal", "visible": True}
    out.update(d)
    return out


BLENDS = [
    "normal", "multiply", "screen", "overlay", "darken", "lighten",
    "color-dodge", "color-burn", "hard-light", "soft-light",
    "difference", "exclusion", "add",
]


def scene_blends() -> dict:
    layers = [
        layer_defaults({
            "id": "backdrop", "type": "gradient",
            "gradient": {"kind": "linear", "angle": 0,
                         "stops": [{"at": 0, "color": "#10306080"},
                                   {"at": 1, "color": "#c04010ff"}]},
        })
    ]
    for i, mode in enumerate(BLENDS):
        col, row = i % 5, i // 5
        layers.append(layer_defaults({
            "id": f"sw-{mode}", "type": "shape", "shape": "rect",
            "rect": {"x": 20 + col * 125, "y": 20 + row * 95, "w": 105.0, "h": 75.0},
            "fill": "#7fb7ffcc", "stroke": None, "stroke_width": 0.0,
            "blend": mode,
        }))
    layers.append(layer_defaults({
        "id": "half", "type": "shape", "shape": "ellipse",
        "rect": {"x": 200.0, "y": 240.0, "w": 260.0, "h": 120.0},
        "fill": "#ffffffff", "stroke": None, "stroke_width": 0.0, "opacity": 0.35,
    }))
    return {"version": 1,
            "canvas": {"width": 660, "height": 400, "background": "#202228ff"},
            "layers": layers}


def scene_transforms() -> dict:
    layers = [
        layer_defaults({
            "id": "base", "type": "shape", "shape": "rect",
            "rect": {"x": 0.0, "y": 0.0, "w": 720.0, "h": 480.0},
            "fill": "#243044ff", "stroke": None, "stroke_width": 0.0,
        }),
        # plain placement + downscale
        layer_defaults({
            "id": "plain", "type": "image", "source": "../assets/photo.png",
            "transform": {"x": 20.0, "y": 20.0, "scale": 0.5, "rotation": 0.0},
            "mask": None,
        }),
        # rotated + overflowing the right edge
        layer_defaults({
            "id": "rot", "type": "image", "source": "../assets/photo.png",
            "transform": {"x": 540.0, "y": 40.0, "scale": 0.6, "rotation": 30.0},
            "mask": None,
        }),
        # negative offset (cropped at top-left), upscaled sprite with alpha
        layer_defaults({
            "id": "neg", "type": "image", "source": "../assets/sprite.png",
            "transform": {"x": -60.0, "y": -40.0, "scale": 1.2, "rotation": 0.0},
            "mask": None,
        }),
        # cutout mask (pre-made RGBA cache, as rembg would produce)
        layer_defaults({
            "id": "cut", "type": "image", "source": "../assets/photo.png",
            "transform": {"x": 30.0, "y": 220.0, "scale": 0.7, "rotation": 0.0},
            "mask": {"kind": "cutout", "cache": "../assets/cutout.png",
                     "feather": 0.0, "invert": False},
        }),
        # external grayscale image mask, feathered
        layer_defaults({
            "id": "imask", "type": "image", "source": "../assets/photo.png",
            "transform": {"x": 300.0, "y": 220.0, "scale": 0.7, "rotation": 0.0},
            "mask": {"kind": "image", "source": "../assets/gray-mask.png",
                     "feather": 4.0, "invert": False},
        }),
        # shape ellipse mask, inverted
        layer_defaults({
            "id": "smask", "type": "image", "source": "../assets/photo.png",
            "transform": {"x": 520.0, "y": 250.0, "scale": 0.55, "rotation": 0.0},
            "mask": {"kind": "shape", "shape": "ellipse",
                     "rect": {"x": 90.0, "y": 60.0, "w": 140.0, "h": 120.0},
                     "feather": 0.0, "invert": True},
        }),
        # rotated shape (rect.rotation)
        layer_defaults({
            "id": "rotrect", "type": "shape", "shape": "rect",
            "rect": {"x": 300.0, "y": 60.0, "w": 120.0, "h": 80.0, "rotation": -20.0},
            "fill": "#2bb673aa", "stroke": "#ffffffff", "stroke_width": 6.0,
        }),
    ]
    return {"version": 1,
            "canvas": {"width": 720, "height": 480, "background": "transparent"},
            "layers": layers}


def scene_gradients() -> dict:
    layers = [
        layer_defaults({
            "id": "lin-angle", "type": "gradient",
            "gradient": {"kind": "linear", "angle": 27.0,
                         "stops": [{"at": 0.0, "color": "#000000ff"},
                                   {"at": 0.4, "color": "#d95fa9aa"},
                                   {"at": 1.0, "color": "#00000000"}]},
        }),
        layer_defaults({
            "id": "lin-anchor", "type": "gradient", "opacity": 0.7, "blend": "screen",
            "gradient": {"kind": "linear", "anchor": "bottom-left",
                         "stops": [{"at": 0.0, "color": "#2bb673ff"},
                                   {"at": 1.0, "color": "#2bb67300"}]},
        }),
        layer_defaults({
            "id": "rad-anchor", "type": "gradient",
            "gradient": {"kind": "radial", "anchor": "top-right",
                         "stops": [{"at": 0.0, "color": "#7fb7ffee"},
                                   {"at": 0.5, "color": "#7fb7ff55"},
                                   {"at": 1.0, "color": "#7fb7ff00"}]},
        }),
        layer_defaults({
            "id": "rad-center", "type": "gradient",
            "gradient": {"kind": "radial", "center": [0.3, 0.65],
                         "stops": [{"at": 0.0, "color": "#ffd24dcc"},
                                   {"at": 1.0, "color": "#ffd24d00"}]},
        }),
    ]
    return {"version": 1,
            "canvas": {"width": 640, "height": 400, "background": "#101318ff"},
            "layers": layers}


def scene_vector() -> dict:
    layers = [
        layer_defaults({
            "id": "bg", "type": "shape", "shape": "rect",
            "rect": {"x": 0.0, "y": 0.0, "w": 640.0, "h": 420.0},
            "fill": "#1b2432ff", "stroke": None, "stroke_width": 0.0,
        }),
        layer_defaults({
            "id": "ellipse-stroked", "type": "shape", "shape": "ellipse",
            "rect": {"x": 40.0, "y": 40.0, "w": 200.0, "h": 140.0},
            "fill": "#ff3366ff", "stroke": "#ffffffff", "stroke_width": 8.0,
        }),
        layer_defaults({
            "id": "ellipse-hollow", "type": "shape", "shape": "ellipse",
            "rect": {"x": 280.0, "y": 40.0, "w": 140.0, "h": 140.0},
            "fill": None, "stroke": "#7fb7ffff", "stroke_width": 10.0,
        }),
        layer_defaults({
            "id": "rect-stroked", "type": "shape", "shape": "rect",
            "rect": {"x": 460.0, "y": 40.0, "w": 140.0, "h": 100.0},
            "fill": "#2bb67388", "stroke": "#ffd24dff", "stroke_width": 5.0,
        }),
        layer_defaults({
            "id": "arrow-outlined", "type": "arrow",
            "arrow": {"from_x": 60.0, "from_y": 380.0, "to_x": 300.0, "to_y": 240.0,
                      "color": "#e61e2dff", "width": 30.0,
                      "head_length": 60.0, "head_width": 72.0,
                      "outline": "#ffffffff", "outline_width": 8.0},
        }),
        layer_defaults({
            "id": "arrow-plain", "type": "arrow",
            "arrow": {"from_x": 380.0, "from_y": 380.0, "to_x": 590.0, "to_y": 300.0,
                      "color": "#7fb7ffff", "width": 14.0,
                      "head_length": 34.0, "head_width": 34.0,
                      "outline": None, "outline_width": 0.0},
        }),
    ]
    return {"version": 1,
            "canvas": {"width": 640, "height": 420, "background": "transparent"},
            "layers": layers}


def scene_text() -> dict:
    layers = [
        layer_defaults({
            "id": "bg", "type": "shape", "shape": "rect",
            "rect": {"x": 0.0, "y": 0.0, "w": 800.0, "h": 500.0},
            "fill": "#182030ff", "stroke": None, "stroke_width": 0.0,
        }),
        layer_defaults({
            "id": "headline", "type": "text",
            "text": {"content": "Golden Text", "x": 400.0, "y": 40.0,
                     "font": "Helvetica Neue", "size": 84.0, "weight": "800",
                     "style": "normal", "align": "center",
                     "fill": "#ffffffff",
                     "gradient": {"kind": "linear", "angle": 0,
                                  "stops": [{"at": 0, "color": "#f97316ff"},
                                            {"at": 1, "color": "#38bdf8ff"}]},
                     "stroke": "#ffffffff", "stroke_width": 3.0,
                     "shadow": {"color": "#000000aa", "dx": 10.0, "dy": 10.0, "blur": 8.0},
                     "line_height": 1.15, "letter_spacing": 1.0, "rotation": -3.0},
        }),
        layer_defaults({
            "id": "multiline", "type": "text",
            "text": {"content": "left aligned\nsecond line", "x": 60.0, "y": 220.0,
                     "font": "Helvetica Neue", "size": 44.0, "weight": "400",
                     "style": "italic", "align": "left",
                     "fill": "#7fb7ffff", "stroke": None, "stroke_width": 0.0,
                     "line_height": 1.3, "letter_spacing": 0.0, "rotation": 0.0},
        }),
        layer_defaults({
            "id": "stroked", "type": "text",
            "text": {"content": "STROKE", "x": 740.0, "y": 330.0,
                     "font": "Helvetica Neue", "size": 90.0, "weight": "900",
                     "style": "normal", "align": "right",
                     "fill": "#e61e2dff", "stroke": "#ffffffff", "stroke_width": 8.0,
                     "line_height": 1.15, "letter_spacing": 0.0, "rotation": 0.0},
        }),
    ]
    return {"version": 1,
            "canvas": {"width": 800, "height": 500, "background": "transparent"},
            "layers": layers}


FIXTURES = {
    "blends": scene_blends,
    "transforms": scene_transforms,
    "gradients": scene_gradients,
    "vector": scene_vector,
    "text": scene_text,
}


def main() -> None:
    import sys

    sys.path.insert(0, str(HERE.parent.parent / "src"))
    from gimpish.render import render_scene
    from gimpish.scene import Scene

    for d in (ASSETS, SCENES, GOLDEN):
        d.mkdir(parents=True, exist_ok=True)

    make_photo(ASSETS / "photo.png")
    make_sprite(ASSETS / "sprite.png")
    make_gray_mask(ASSETS / "gray-mask.png")
    make_cutout(ASSETS / "cutout.png")

    for name, builder in FIXTURES.items():
        scene_path = SCENES / f"{name}.scene.json"
        scene_path.write_text(json.dumps(builder(), indent=2) + "\n")
        scene = Scene.load(scene_path)
        render_scene(scene).write_to_file(str(GOLDEN / f"{name}.png"))
        print(f"golden: {name}")

    # The shipped examples are fixtures too (self-contained, no image sources).
    for ex in sorted((HERE.parent.parent / "examples").glob("*.scene.json")):
        scene = Scene.load(ex)
        name = ex.name.replace(".scene.json", "")
        render_scene(scene).write_to_file(str(GOLDEN / f"example-{name}.png"))
        print(f"golden: example-{name}")


if __name__ == "__main__":
    main()

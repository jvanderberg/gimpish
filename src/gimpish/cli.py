"""gimpish CLI — the agent-facing verb surface (see DESIGN.md §6).

Most commands load ./scene.json, mutate it, and save back automatically, so an agent
can chain commands without an explicit save between each step.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import typer

from .geometry import parse_color, parse_stops, resolve_fit
from .render import BLEND_MODES, render_preview, render_to_file
from .scene import Canvas, Layer, Mask, Scene, Transform

app = typer.Typer(add_completion=False, help="Agent-native image composition.")
layer_app = typer.Typer(help="Per-layer operations.")
draw_app = typer.Typer(help="Draw primitives as layers.")
app.add_typer(layer_app, name="layer")
app.add_typer(draw_app, name="draw")

DEFAULT_SCENE = "scene.json"


def _scene_opt() -> str:
    return typer.Option(DEFAULT_SCENE, "--scene", help="Scene JSON file.")


def _load(scene_path: str) -> Scene:
    p = Path(scene_path)
    if not p.exists():
        raise typer.BadParameter(f"{p} not found — run `gimpish init` first.")
    return Scene.load(p)


def _rel(scene: Scene, path: Path) -> str:
    """Store paths relative to the scene file when possible."""
    root = scene.path.parent if scene.path else Path.cwd()
    try:
        return os.path.relpath(Path(path).resolve(), root.resolve())
    except ValueError:
        return str(Path(path).resolve())


def _natural_size(scene: Scene, layer: Layer) -> tuple[int, int]:
    import pyvips

    root = scene.path.parent if scene.path else Path.cwd()
    img = pyvips.Image.new_from_file(str(root / layer.source))
    return img.width, img.height


# ---- scene lifecycle -------------------------------------------------------------


@app.command()
def init(
    width: int = typer.Option(..., "--width", "-w", help="Canvas width in pixels."),
    height: int = typer.Option(..., "--height", "-h", help="Canvas height in pixels."),
    bg: str = typer.Option("transparent", "--bg", help="'transparent' or '#rrggbbaa'."),
    scene: str = _scene_opt(),
    force: bool = typer.Option(False, "--force", help="Overwrite an existing scene."),
):
    """Create a new empty scene."""
    p = Path(scene)
    if p.exists() and not force:
        raise typer.BadParameter(f"{p} already exists (use --force to overwrite).")
    if bg != "transparent":
        parse_color(bg)  # validate
    s = Scene(canvas=Canvas(width=width, height=height, background=bg), path=p)
    s.save()
    typer.echo(f"created {p} ({width}x{height}, bg={bg})")


@app.command()
def add(
    path: Path = typer.Argument(..., help="Image file to import."),
    name: Optional[str] = typer.Option(None, "--name", help="Layer name/id hint."),
    scene: str = _scene_opt(),
):
    """Import an image as a new layer on top of the stack."""
    s = _load(scene)
    if not path.exists():
        raise typer.BadParameter(f"{path} not found.")
    base = name or path.stem
    layer = Layer(
        id=s.unique_id(base),
        type="image",
        name=name or path.stem,
        source=_rel(s, path),
        transform=Transform(),
    )
    s.layers.append(layer)
    s.save()
    typer.echo(f"added image layer {layer.id!r} ({path})")


@app.command()
def layers(scene: str = _scene_opt()):
    """Print the layer stack (top layer first)."""
    s = _load(scene)
    if not s.layers:
        typer.echo("(no layers)")
        return
    typer.echo(f"canvas {s.canvas.width}x{s.canvas.height}  bg={s.canvas.background}")
    width_id = max((len(l.id) for l in s.layers), default=2)
    for i in range(len(s.layers) - 1, -1, -1):
        l = s.layers[i]
        vis = " " if l.visible else "·"
        extra = ""
        if l.type == "image":
            extra = f"src={l.source} scale={l.transform.scale:.3g}"
            if l.mask:
                extra += f" mask={l.mask.kind}"
        elif l.type == "shape":
            extra = f"{l.shape} fill={l.fill} stroke={l.stroke}"
        elif l.type == "gradient":
            extra = f"{(l.gradient or {}).get('kind','linear')}"
        typer.echo(
            f"{vis}[{i}] {l.id:<{width_id}} {l.type:<8} "
            f"op={l.opacity:.2g} blend={l.blend:<8} {extra}"
        )


@app.command()
def save(
    out: Optional[Path] = typer.Argument(None, help="Path to write (default: same file)."),
    scene: str = _scene_opt(),
):
    """Persist the scene (or copy it to a new path)."""
    s = _load(scene)
    target = s.save(out) if out else s.save()
    typer.echo(f"saved {target}")


# ---- render / preview / export ---------------------------------------------------


@app.command()
def preview(
    out: Path = typer.Option("preview.png", "--out", help="Preview PNG path."),
    max: int = typer.Option(1024, "--max", help="Max dimension of the preview."),
    scene: str = _scene_opt(),
):
    """Render a quick downscaled preview PNG (for verifying scene state)."""
    s = _load(scene)
    img = render_preview(s, max_dim=max)
    img.write_to_file(str(out))
    typer.echo(f"preview -> {out} ({img.width}x{img.height})")


@app.command()
def render(
    out: Path = typer.Option(..., "--out", help="Output image path."),
    width: Optional[int] = typer.Option(None, "--width", help="Output width."),
    height: Optional[int] = typer.Option(None, "--height", help="Output height."),
    scene: str = _scene_opt(),
):
    """Render the scene at full (or specified) resolution."""
    s = _load(scene)
    render_to_file(s, out, width=width, height=height)
    typer.echo(f"rendered -> {out}")


@app.command()
def export(
    out: Path = typer.Option(..., "--out", help="Output .png/.jpg/.webp."),
    quality: int = typer.Option(90, "--quality", help="JPEG/WebP quality."),
    width: Optional[int] = typer.Option(None, "--width", help="Output width."),
    height: Optional[int] = typer.Option(None, "--height", help="Output height."),
    scene: str = _scene_opt(),
):
    """Render and encode to a final file (png/jpg/webp)."""
    s = _load(scene)
    opts = {}
    if out.suffix.lower() in (".jpg", ".jpeg", ".webp"):
        opts["Q"] = quality
    render_to_file(s, out, width=width, height=height, **opts)
    typer.echo(f"exported -> {out}")


# ---- layer ops -------------------------------------------------------------------


@layer_app.command("transform")
def layer_transform(
    layer_id: str = typer.Argument(...),
    x: Optional[float] = typer.Option(None, "--x"),
    y: Optional[float] = typer.Option(None, "--y"),
    scale: Optional[float] = typer.Option(None, "--scale"),
    rotation: Optional[float] = typer.Option(None, "--rotation"),
    scene: str = _scene_opt(),
):
    """Set offset / scale / rotation on a layer."""
    s = _load(scene)
    l = s.find(layer_id)
    if l.type != "image":
        raise typer.BadParameter("transform applies to image layers")
    if x is not None:
        l.transform.x = x
    if y is not None:
        l.transform.y = y
    if scale is not None:
        l.transform.scale = scale
    if rotation is not None:
        l.transform.rotation = rotation
    s.save()
    typer.echo(f"{layer_id}: {l.transform}")


@layer_app.command("fit")
def layer_fit(
    layer_id: str = typer.Argument(...),
    mode: str = typer.Option("fit", "--mode", help="fit|fill|cover"),
    percent: float = typer.Option(100.0, "--percent", help="% of canvas (fit/fill)."),
    anchor: str = typer.Option("center", "--anchor", help="Placement anchor."),
    scene: str = _scene_opt(),
):
    """Scale + position a layer relative to the canvas (resolves to pixels)."""
    s = _load(scene)
    l = s.find(layer_id)
    if l.type != "image":
        raise typer.BadParameter("fit applies to image layers")
    sw, sh = _natural_size(s, l)
    scale, x, y = resolve_fit(sw, sh, s.canvas.width, s.canvas.height, mode, percent, anchor)
    l.transform.scale, l.transform.x, l.transform.y = scale, x, y
    s.save()
    typer.echo(f"{layer_id}: {mode} {percent:g}% -> scale={scale:.4g} x={x:.0f} y={y:.0f}")


@layer_app.command("move")
def layer_move(
    layer_id: str = typer.Argument(...),
    up: bool = typer.Option(False, "--up"),
    down: bool = typer.Option(False, "--down"),
    top: bool = typer.Option(False, "--top"),
    bottom: bool = typer.Option(False, "--bottom"),
    to: Optional[int] = typer.Option(None, "--to", help="Absolute index (0=bottom)."),
    scene: str = _scene_opt(),
):
    """Reorder a layer (up=toward front)."""
    s = _load(scene)
    i = s.index_of(layer_id)
    l = s.layers.pop(i)
    n = len(s.layers)
    if to is not None:
        j = max(0, min(n, to))
    elif top:
        j = n
    elif bottom:
        j = 0
    elif up:
        j = min(n, i + 1)
    elif down:
        j = max(0, i - 1)
    else:
        raise typer.BadParameter("specify --up/--down/--top/--bottom/--to")
    s.layers.insert(j, l)
    s.save()
    typer.echo(f"{layer_id}: moved to index {j}")


@layer_app.command("opacity")
def layer_opacity(
    layer_id: str = typer.Argument(...),
    value: float = typer.Argument(..., help="0.0–1.0"),
    scene: str = _scene_opt(),
):
    """Set layer opacity."""
    s = _load(scene)
    s.find(layer_id).opacity = max(0.0, min(1.0, value))
    s.save()
    typer.echo(f"{layer_id}: opacity={value}")


@layer_app.command("blend")
def layer_blend(
    layer_id: str = typer.Argument(...),
    mode: str = typer.Argument(..., help=f"one of: {', '.join(BLEND_MODES)}"),
    scene: str = _scene_opt(),
):
    """Set layer blend mode."""
    if mode not in BLEND_MODES:
        raise typer.BadParameter(f"unknown blend {mode!r}; choose from {', '.join(BLEND_MODES)}")
    s = _load(scene)
    s.find(layer_id).blend = mode
    s.save()
    typer.echo(f"{layer_id}: blend={mode}")


@layer_app.command("visible")
def layer_visible(
    layer_id: str = typer.Argument(...),
    value: bool = typer.Argument(...),
    scene: str = _scene_opt(),
):
    """Show/hide a layer."""
    s = _load(scene)
    s.find(layer_id).visible = value
    s.save()
    typer.echo(f"{layer_id}: visible={value}")


@layer_app.command("delete")
def layer_delete(layer_id: str = typer.Argument(...), scene: str = _scene_opt()):
    """Remove a layer."""
    s = _load(scene)
    s.layers.pop(s.index_of(layer_id))
    s.save()
    typer.echo(f"deleted {layer_id}")


@layer_app.command("remove-bg")
def layer_remove_bg(layer_id: str = typer.Argument(...), scene: str = _scene_opt()):
    """Remove a layer's background (rembg) -> cutout mask."""
    from .bg import remove_background

    s = _load(scene)
    l = s.find(layer_id)
    if l.type != "image":
        raise typer.BadParameter("remove-bg applies to image layers")
    root = s.path.parent if s.path else Path.cwd()
    out = s.cache_dir() / f"{l.id}_cutout.png"
    typer.echo("running background removal (first run loads the model)…")
    remove_background(root / l.source, out)
    l.mask = Mask(kind="cutout", cache=_rel(s, out))
    s.save()
    typer.echo(f"{layer_id}: background removed -> {l.mask.cache}")


@layer_app.command("mask")
def layer_mask(
    layer_id: str = typer.Argument(...),
    from_: Optional[Path] = typer.Option(None, "--from", help="External mask image."),
    shape: Optional[str] = typer.Option(None, "--shape", help="rect|ellipse"),
    x: float = typer.Option(0, "--x"),
    y: float = typer.Option(0, "--y"),
    w: float = typer.Option(0, "--w"),
    h: float = typer.Option(0, "--h"),
    feather: float = typer.Option(0, "--feather"),
    invert: bool = typer.Option(False, "--invert"),
    scene: str = _scene_opt(),
):
    """Mask a layer from an image or a shape."""
    s = _load(scene)
    l = s.find(layer_id)
    if from_:
        if not from_.exists():
            raise typer.BadParameter(f"{from_} not found")
        l.mask = Mask(kind="image", source=_rel(s, from_), feather=feather, invert=invert)
    elif shape:
        if shape not in ("rect", "ellipse"):
            raise typer.BadParameter("shape must be rect|ellipse")
        if w <= 0 or h <= 0:
            raise typer.BadParameter("shape mask needs --w and --h")
        l.mask = Mask(
            kind="shape", shape=shape, rect={"x": x, "y": y, "w": w, "h": h},
            feather=feather, invert=invert,
        )
    else:
        raise typer.BadParameter("provide --from or --shape")
    s.save()
    typer.echo(f"{layer_id}: mask={l.mask.kind}")


# ---- draw ------------------------------------------------------------------------


def _add_shape(scene_path, shape, x, y, w, h, fill, stroke, stroke_width, name):
    s = _load(scene_path)
    if fill:
        parse_color(fill)
    if stroke:
        parse_color(stroke)
    layer = Layer(
        id=s.unique_id(name or shape),
        type="shape",
        name=name or shape,
        shape=shape,
        rect={"x": x, "y": y, "w": w, "h": h},
        fill=fill,
        stroke=stroke,
        stroke_width=stroke_width,
    )
    s.layers.append(layer)
    s.save()
    typer.echo(f"added {shape} layer {layer.id!r}")


@draw_app.command("rect")
def draw_rect(
    x: float = typer.Option(..., "--x"),
    y: float = typer.Option(..., "--y"),
    w: float = typer.Option(..., "--w"),
    h: float = typer.Option(..., "--h"),
    fill: Optional[str] = typer.Option(None, "--fill"),
    stroke: Optional[str] = typer.Option(None, "--stroke"),
    stroke_width: float = typer.Option(0, "--stroke-width"),
    name: Optional[str] = typer.Option(None, "--name"),
    scene: str = _scene_opt(),
):
    """Draw a filled/stroked rectangle."""
    _add_shape(scene, "rect", x, y, w, h, fill, stroke, stroke_width, name)


@draw_app.command("ellipse")
def draw_ellipse(
    x: float = typer.Option(..., "--x"),
    y: float = typer.Option(..., "--y"),
    w: float = typer.Option(..., "--w"),
    h: float = typer.Option(..., "--h"),
    fill: Optional[str] = typer.Option(None, "--fill"),
    stroke: Optional[str] = typer.Option(None, "--stroke"),
    stroke_width: float = typer.Option(0, "--stroke-width"),
    name: Optional[str] = typer.Option(None, "--name"),
    scene: str = _scene_opt(),
):
    """Draw a filled/stroked ellipse."""
    _add_shape(scene, "ellipse", x, y, w, h, fill, stroke, stroke_width, name)


@draw_app.command("gradient")
def draw_gradient(
    kind: str = typer.Option("linear", "--kind", help="linear|radial"),
    anchor: Optional[str] = typer.Option(None, "--anchor", help="Direction/center anchor."),
    angle: Optional[float] = typer.Option(None, "--angle", help="Linear angle (deg)."),
    stops: str = typer.Option(..., "--stops", help="'0:#000000ff, 1:#00000000'"),
    over: Optional[str] = typer.Option(None, "--over", help="Insert above this layer id."),
    name: Optional[str] = typer.Option(None, "--name"),
    scene: str = _scene_opt(),
):
    """Add a linear/radial gradient as a layer."""
    s = _load(scene)
    parsed = parse_stops(stops)
    g: dict = {"kind": kind, "stops": parsed}
    if angle is not None:
        g["angle"] = angle
    if anchor:
        g["anchor"] = anchor
    if not anchor and angle is None:
        g["anchor"] = "center" if kind == "radial" else "top"
    layer = Layer(id=s.unique_id(name or "gradient"), type="gradient", name=name or "gradient", gradient=g)
    if over:
        s.layers.insert(s.index_of(over) + 1, layer)
    else:
        s.layers.append(layer)
    s.save()
    typer.echo(f"added gradient layer {layer.id!r}")


# ---- serve (phase 2) -------------------------------------------------------------


@app.command()
def serve(
    port: int = typer.Option(8765, "--port"),
    scene: str = _scene_opt(),
):
    """Start the live web preview server."""
    from .server import run_server

    run_server(Path(scene), port=port)


if __name__ == "__main__":
    app()

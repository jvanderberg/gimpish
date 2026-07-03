"""Live web preview server (gimpish serve).

Watches the scene file + its cache dir; on any change, re-renders via the same pyvips
path as `render`/`export` and pushes a reload over WebSocket. The React client (served
from web/index.html) shows the composite plus the layer stack.
"""

import asyncio
import json
from pathlib import Path

# NB: do NOT add `from __future__ import annotations` here — it stringizes the
# `socket: WebSocket` annotation and FastAPI then fails to inject the WebSocket,
# rejecting the handshake with a 403.

import math

import pyvips

from .geometry import ANCHORS
from .render import render_preview, render_layer_sprite, _render_text
from .scene import Scene

WEB_DIR = Path(__file__).parent / "web"

# Cache image natural (unscaled) dimensions by resolved path so /api/geometry
# doesn't re-read headers every request. Header reads are cheap but the map keeps
# repeated drags snappy.
_dim_cache: dict[str, tuple[int, int]] = {}


def _natural_size(path: Path) -> tuple[int, int]:
    key = str(path)
    if key not in _dim_cache:
        img = pyvips.Image.new_from_file(key)  # header-only; no pixel decode
        _dim_cache[key] = (img.width, img.height)
    return _dim_cache[key]


def _box(layer, cx, cy, w, h, *, rotation=0.0, pivotx=None, pivoty=None,
         move=True, rotate=True, scale=True) -> dict:
    return {"id": layer.id, "type": layer.type,
            "cx": cx, "cy": cy, "w": w, "h": h, "rotation": rotation,
            "pivotx": cx if pivotx is None else pivotx,
            "pivoty": cy if pivoty is None else pivoty,
            "move": move, "rotate": rotate, "scale": scale}


def _radial_center(scene: Scene, g: dict) -> tuple[float, float]:
    W, H = scene.canvas.width, scene.canvas.height
    center = g.get("center")
    if center:
        fx, fy = float(center[0]), float(center[1])
    else:
        fx, fy = ANCHORS.get(g.get("anchor", "center"), (0.5, 0.5))
    return fx * W, fy * H


def _layer_box(scene: Scene, layer) -> dict | None:
    """Selection box for a manipulable layer, in canvas pixels.

    Carries the box center/size/rotation, the rotation pivot, and move/rotate
    capability flags. Images/shapes rotate about their center; text about its
    anchor; arrows about their midpoint; gradients map drag onto their own
    parameters (radial center, linear angle)."""
    W, H = scene.canvas.width, scene.canvas.height
    if layer.type == "image":
        if not layer.source:
            return None
        root = scene.path.parent if scene.path else Path.cwd()
        try:
            w0, h0 = _natural_size(root / layer.source)
        except Exception:
            return None
        t = layer.transform
        w, h = w0 * t.scale, h0 * t.scale
        return _box(layer, t.x + w / 2, t.y + h / 2, w, h, rotation=t.rotation)

    if layer.type == "shape" and layer.rect:
        r = layer.rect
        w, h = float(r.get("w", 0)), float(r.get("h", 0))
        return _box(layer, float(r.get("x", 0)) + w / 2, float(r.get("y", 0)) + h / 2,
                    w, h, rotation=float(r.get("rotation", 0)))

    if layer.type == "text" and layer.text:
        try:
            img, _, _ = _render_text(scene, layer)
            left, top, w, h = img.extract_band(3).find_trim(threshold=1, background=0)
        except Exception:
            return None
        if w <= 0 or h <= 0:
            return None
        # Rotation is baked into the render (box is axis-aligned); pivot is the
        # text anchor, which is what render rotates about.
        return _box(layer, left + w / 2, top + h / 2, w, h,
                    pivotx=float(layer.text.get("x", 0)),
                    pivoty=float(layer.text.get("y", 0)))

    if layer.type == "arrow" and layer.arrow:
        a = layer.arrow
        try:
            xs = [float(a["from_x"]), float(a["to_x"])]
            ys = [float(a["from_y"]), float(a["to_y"])]
        except (KeyError, TypeError, ValueError):
            return None
        pad = max(float(a.get("width", 0)), float(a.get("head_width", 0))) / 2 \
            + float(a.get("outline_width", 0))
        x0, x1 = min(xs) - pad, max(xs) + pad
        y0, y1 = min(ys) - pad, max(ys) + pad
        return _box(layer, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0,
                    pivotx=sum(xs) / 2, pivoty=sum(ys) / 2)

    if layer.type == "gradient" and layer.gradient:
        g = layer.gradient
        s = min(W, H)
        if g.get("kind") == "radial":
            # A grab indicator at the glow center; dragging moves that center.
            cx, cy = _radial_center(scene, g)
            return _box(layer, cx, cy, s * 0.28, s * 0.28, rotate=False, scale=False)
        # Linear: a centered indicator whose rotation shows the gradient angle;
        # the handle changes the angle, body-drag is disabled.
        return _box(layer, W / 2, H / 2, s * 0.34, s * 0.34,
                    rotation=float(g.get("angle", 0)), move=False, scale=False)

    return None


def _apply_move(scene: Scene, layer, dx: float, dy: float) -> None:
    """Translate a layer by (dx, dy) canvas pixels, in its own storage form."""
    if layer.type == "image":
        layer.transform.x += dx
        layer.transform.y += dy
    elif layer.type == "shape" and layer.rect:
        layer.rect["x"] = float(layer.rect.get("x", 0)) + dx
        layer.rect["y"] = float(layer.rect.get("y", 0)) + dy
    elif layer.type == "text" and layer.text:
        layer.text["x"] = float(layer.text.get("x", 0)) + dx
        layer.text["y"] = float(layer.text.get("y", 0)) + dy
    elif layer.type == "arrow" and layer.arrow:
        for fx, fy in (("from_x", "from_y"), ("to_x", "to_y")):
            layer.arrow[fx] = float(layer.arrow[fx]) + dx
            layer.arrow[fy] = float(layer.arrow[fy]) + dy
    elif layer.type == "gradient" and layer.gradient \
            and layer.gradient.get("kind") == "radial":
        cx, cy = _radial_center(scene, layer.gradient)
        W, H = scene.canvas.width, scene.canvas.height
        layer.gradient["center"] = [(cx + dx) / W, (cy + dy) / H]


def _apply_rotate(scene: Scene, layer, drot: float) -> None:
    """Rotate a layer by `drot` degrees clockwise about its natural pivot."""
    if layer.type == "image":
        layer.transform.rotation += drot            # render keeps center fixed
    elif layer.type == "shape" and layer.rect:
        layer.rect["rotation"] = float(layer.rect.get("rotation", 0)) + drot
    elif layer.type == "text" and layer.text:
        layer.text["rotation"] = float(layer.text.get("rotation", 0)) + drot
    elif layer.type == "arrow" and layer.arrow:
        a = layer.arrow
        mx = (float(a["from_x"]) + float(a["to_x"])) / 2
        my = (float(a["from_y"]) + float(a["to_y"])) / 2
        c, s = math.cos(math.radians(drot)), math.sin(math.radians(drot))
        for fx, fy in (("from_x", "from_y"), ("to_x", "to_y")):
            px, py = float(a[fx]) - mx, float(a[fy]) - my
            a[fx] = mx + px * c - py * s
            a[fy] = my + px * s + py * c
    elif layer.type == "gradient" and layer.gradient \
            and layer.gradient.get("kind") == "linear":
        layer.gradient["angle"] = float(layer.gradient.get("angle", 0)) + drot


def _apply_scale(scene: Scene, layer, f: float) -> None:
    """Scale a layer by factor `f`, keeping its pivot fixed (center for image/
    shape, anchor for text, midpoint for arrow)."""
    f = max(0.02, min(50.0, f))
    if layer.type == "image":
        if not layer.source:
            return
        root = scene.path.parent if scene.path else Path.cwd()
        try:
            w0, h0 = _natural_size(root / layer.source)
        except Exception:
            return
        t = layer.transform
        cx, cy = t.x + w0 * t.scale / 2, t.y + h0 * t.scale / 2  # center held fixed
        t.scale *= f
        t.x, t.y = cx - w0 * t.scale / 2, cy - h0 * t.scale / 2
    elif layer.type == "shape" and layer.rect:
        r = layer.rect
        w, h = float(r.get("w", 0)), float(r.get("h", 0))
        cx, cy = float(r.get("x", 0)) + w / 2, float(r.get("y", 0)) + h / 2
        r["w"], r["h"] = w * f, h * f
        r["x"], r["y"] = cx - r["w"] / 2, cy - r["h"] / 2
    elif layer.type == "text" and layer.text:
        layer.text["size"] = float(layer.text.get("size", 64)) * f  # anchor held
    elif layer.type == "arrow" and layer.arrow:
        a = layer.arrow
        mx = (float(a["from_x"]) + float(a["to_x"])) / 2
        my = (float(a["from_y"]) + float(a["to_y"])) / 2
        for fx, fy in (("from_x", "from_y"), ("to_x", "to_y")):
            a[fx] = mx + (float(a[fx]) - mx) * f
            a[fy] = my + (float(a[fy]) - my) * f
        for key in ("width", "head_length", "head_width", "outline_width"):
            if key in a and a[key] is not None:
                a[key] = float(a[key]) * f


def create_app(scene_path: Path):
    from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
    from fastapi.responses import FileResponse, JSONResponse, Response
    from watchfiles import awatch

    scene_path = Path(scene_path).resolve()
    app = FastAPI()
    clients: set = set()

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/favicon.ico")
    def favicon():
        return Response(status_code=204)  # silence the browser's auto-request

    @app.get("/api/scene")
    def api_scene():
        try:
            return JSONResponse(Scene.load(scene_path).to_dict())
        except Exception as exc:  # surface scene-read errors to the UI
            return JSONResponse({"error": str(exc)}, status_code=500)

    @app.get("/api/preview.png")
    def api_preview(max: int = 1400, hide: str = ""):
        hidden = {h for h in hide.split(",") if h} or None
        img = render_preview(Scene.load(scene_path), max_dim=max, hide=hidden)
        png = img.write_to_buffer(".png")
        return Response(content=png, media_type="image/png",
                        headers={"Cache-Control": "no-store"})

    @app.get("/api/layer/{layer_id}/sprite.png")
    def api_sprite(layer_id: str, max: int = 1400):
        try:
            scene = Scene.load(scene_path)
            layer = scene.find(layer_id)
        except KeyError:
            return Response(status_code=404)
        img = render_layer_sprite(scene, layer, max_dim=max)
        png = img.write_to_buffer(".png")
        return Response(content=png, media_type="image/png",
                        headers={"Cache-Control": "no-store"})

    @app.get("/api/geometry")
    def api_geometry():
        try:
            scene = Scene.load(scene_path)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)
        boxes = [b for l in scene.layers if l.visible
                 for b in (_layer_box(scene, l),) if b]
        return JSONResponse({
            "canvas": {"width": scene.canvas.width, "height": scene.canvas.height},
            "boxes": boxes,
        })

    @app.post("/api/layer/{layer_id}/transform")
    async def api_set_transform(layer_id: str, request: Request):
        """Translate/rotate/scale a layer and persist. Body: {dx?, dy?, drot?, scale?}
        where scale is a multiplicative factor.

        Deltas map onto each layer type's own storage — image transform, shape
        rect, text anchor, arrow endpoints, gradient center/angle. The file write
        trips the watcher, which pushes a reload so every client re-fetches the
        freshly composited preview."""
        body = await request.json()
        try:
            scene = Scene.load(scene_path)
            layer = scene.find(layer_id)
        except KeyError:
            return JSONResponse({"error": f"no layer {layer_id!r}"}, status_code=404)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)
        dx, dy = float(body.get("dx", 0) or 0), float(body.get("dy", 0) or 0)
        drot = float(body.get("drot", 0) or 0)
        fscale = float(body.get("scale", 1) or 1)
        if dx or dy:
            _apply_move(scene, layer, dx, dy)
        if drot:
            _apply_rotate(scene, layer, drot)
        if fscale != 1:
            _apply_scale(scene, layer, fscale)
        scene.save()
        return JSONResponse({"ok": True})

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        clients.add(socket)
        try:
            while True:
                await socket.receive_text()  # keepalive; client never really sends
        except WebSocketDisconnect:
            pass
        finally:
            clients.discard(socket)

    async def watch():
        # Watch the scene file's directory (covers scene.json + .scene_cache writes).
        async for _ in awatch(scene_path.parent):
            dead = set()
            for c in list(clients):
                try:
                    await c.send_text(json.dumps({"type": "reload"}))
                except Exception:
                    dead.add(c)
            clients.difference_update(dead)

    @app.on_event("startup")
    async def _start():
        asyncio.create_task(watch())

    return app


def run_server(scene_path: Path, port: int = 8765) -> None:
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("serve needs extras: pip install 'gimpish[serve]'") from exc

    scene_path = Path(scene_path).resolve()
    if not scene_path.exists():
        raise SystemExit(f"{scene_path} not found — run `gimpish init` first.")

    app = create_app(scene_path)
    url = f"http://127.0.0.1:{port}"
    print(f"gimpish preview → {url}  (watching {scene_path})")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

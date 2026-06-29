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

from .render import render_preview
from .scene import Scene

WEB_DIR = Path(__file__).parent / "web"


def create_app(scene_path: Path):
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.responses import FileResponse, JSONResponse, Response
    from watchfiles import awatch

    scene_path = Path(scene_path).resolve()
    app = FastAPI()
    clients: set = set()

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/api/scene")
    def api_scene():
        try:
            return JSONResponse(Scene.load(scene_path).to_dict())
        except Exception as exc:  # surface scene-read errors to the UI
            return JSONResponse({"error": str(exc)}, status_code=500)

    @app.get("/api/preview.png")
    def api_preview(max: int = 1400):
        img = render_preview(Scene.load(scene_path), max_dim=max)
        png = img.write_to_buffer(".png")
        return Response(content=png, media_type="image/png",
                        headers={"Cache-Control": "no-store"})

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

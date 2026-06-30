"""Scene document model and JSON persistence.

The scene is the single source of truth: an ordered list of layers over a fixed
design canvas. Positions and sizes are in canvas-space pixels (see DESIGN.md §5).
Layer order is paint order; index 0 is the bottom (back) layer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Literal, Optional

SCENE_VERSION = 1
CACHE_DIR = ".scene_cache"

BlendMode = str  # "normal", "multiply", "screen", "overlay", ...


@dataclass
class Canvas:
    width: int
    height: int
    background: str = "transparent"  # "transparent" or "#rrggbbaa"


@dataclass
class Transform:
    x: float = 0.0
    y: float = 0.0
    scale: float = 1.0
    rotation: float = 0.0  # degrees, clockwise


@dataclass
class Mask:
    # kind="cutout": single-band alpha from rembg / applied alpha, in `cache`
    # kind="image": external grayscale/alpha mask at `source`
    # kind="shape": procedural rect/ellipse mask
    kind: Literal["cutout", "image", "shape"]
    cache: Optional[str] = None
    source: Optional[str] = None
    shape: Optional[Literal["rect", "ellipse"]] = None
    rect: Optional[dict[str, float]] = None
    feather: float = 0.0
    invert: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Mask":
        return Mask(
            kind=d["kind"],
            cache=d.get("cache"),
            source=d.get("source"),
            shape=d.get("shape"),
            rect=d.get("rect"),
            feather=d.get("feather", 0.0),
            invert=d.get("invert", False),
        )


@dataclass
class Layer:
    """A single layer. `type` discriminates the payload fields used."""

    id: str
    type: Literal["image", "shape", "gradient", "arrow", "text"]
    name: str = ""
    opacity: float = 1.0
    blend: BlendMode = "normal"
    visible: bool = True

    # image
    source: Optional[str] = None
    transform: Transform = field(default_factory=Transform)
    mask: Optional[Mask] = None

    # shape
    shape: Optional[Literal["rect", "ellipse"]] = None
    rect: Optional[dict[str, float]] = None
    fill: Optional[str] = None
    stroke: Optional[str] = None
    stroke_width: float = 0.0

    # gradient
    gradient: Optional[dict[str, Any]] = None

    # arrow
    arrow: Optional[dict[str, Any]] = None

    # text
    text: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "type": self.type,
            "name": self.name,
            "opacity": self.opacity,
            "blend": self.blend,
            "visible": self.visible,
        }
        if self.type == "image":
            d["source"] = self.source
            d["transform"] = asdict(self.transform)
            d["mask"] = self.mask.to_dict() if self.mask else None
        elif self.type == "shape":
            d["shape"] = self.shape
            d["rect"] = self.rect
            d["fill"] = self.fill
            d["stroke"] = self.stroke
            d["stroke_width"] = self.stroke_width
        elif self.type == "gradient":
            d["gradient"] = self.gradient
        elif self.type == "arrow":
            d["arrow"] = self.arrow
        elif self.type == "text":
            d["text"] = self.text
        return d

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Layer":
        t = d.get("transform") or {}
        m = d.get("mask")
        return Layer(
            id=d["id"],
            type=d["type"],
            name=d.get("name", ""),
            opacity=d.get("opacity", 1.0),
            blend=d.get("blend", "normal"),
            visible=d.get("visible", True),
            source=d.get("source"),
            transform=Transform(**t) if t else Transform(),
            mask=Mask.from_dict(m) if m else None,
            shape=d.get("shape"),
            rect=d.get("rect"),
            fill=d.get("fill"),
            stroke=d.get("stroke"),
            stroke_width=d.get("stroke_width", 0.0),
            gradient=d.get("gradient"),
            arrow=d.get("arrow"),
            text=d.get("text"),
        )


@dataclass
class Scene:
    canvas: Canvas
    layers: list[Layer] = field(default_factory=list)
    version: int = SCENE_VERSION
    path: Optional[Path] = None  # where this scene was loaded from / saves to

    # ---- layer lookup / ordering -------------------------------------------------

    def find(self, layer_id: str) -> Layer:
        for layer in self.layers:
            if layer.id == layer_id:
                return layer
        raise KeyError(f"no layer with id {layer_id!r}")

    def index_of(self, layer_id: str) -> int:
        for i, layer in enumerate(self.layers):
            if layer.id == layer_id:
                return i
        raise KeyError(f"no layer with id {layer_id!r}")

    def unique_id(self, base: str) -> str:
        base = _slug(base) or "layer"
        existing = {layer.id for layer in self.layers}
        if base not in existing:
            return base
        n = 2
        while f"{base}{n}" in existing:
            n += 1
        return f"{base}{n}"

    # ---- persistence -------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "canvas": asdict(self.canvas),
            "layers": [layer.to_dict() for layer in self.layers],
        }

    def save(self, path: Optional[Path] = None) -> Path:
        target = Path(path) if path else self.path
        if target is None:
            raise ValueError("no path to save scene to")
        target.write_text(json.dumps(self.to_dict(), indent=2) + "\n")
        self.path = target
        return target

    @staticmethod
    def load(path: Path) -> "Scene":
        path = Path(path)
        d = json.loads(path.read_text())
        scene = Scene(
            canvas=Canvas(**d["canvas"]),
            layers=[Layer.from_dict(ld) for ld in d.get("layers", [])],
            version=d.get("version", SCENE_VERSION),
            path=path,
        )
        return scene

    def cache_dir(self) -> Path:
        root = self.path.parent if self.path else Path.cwd()
        cache = root / CACHE_DIR
        cache.mkdir(exist_ok=True)
        return cache


def _slug(text: str) -> str:
    keep = []
    for ch in text.strip().lower():
        if ch.isalnum():
            keep.append(ch)
        elif ch in " -_":
            keep.append("-")
    out = "".join(keep).strip("-")
    while "--" in out:
        out = out.replace("--", "-")
    return out

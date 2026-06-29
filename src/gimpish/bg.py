"""Background removal via rembg (U^2-Net). Optional dependency: pip install gimpish[bg].

Produces a cutout PNG (RGBA, background removed) in the scene cache; the layer then
references it as a `cutout` mask. Non-destructive: the source image is never touched.
"""

from __future__ import annotations

from pathlib import Path

_SESSION = None


def _session():
    global _SESSION
    if _SESSION is None:
        from rembg import new_session  # lazy: heavy import, only when used

        _SESSION = new_session("u2net")
    return _SESSION


def remove_background(src: Path, out: Path) -> Path:
    """Write an RGBA cutout of `src` to `out`. Returns `out`."""
    try:
        from rembg import remove
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "background removal needs rembg: pip install 'gimpish[bg]'"
        ) from exc

    data = Path(src).read_bytes()
    cutout = remove(data, session=_session())
    out = Path(out)
    out.write_bytes(cutout)
    return out

import { clampCrop, coverCrop, EXPORT_PRESETS } from "@gimpish/core/model";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BUNDLE_URL,
  type Canvas,
  type ExportCrop,
  type ExportFormat,
  type ExportSettings,
  exportCropUrl,
  previewUrl,
  type Scene,
  saveExportSettings,
} from "../api";
import { useElementSize } from "../hooks/useElementSize";
import { containBox } from "../lib/geometry";

const FORMATS: ExportFormat[] = ["png", "jpg", "webp"];
const PRESET_KEYS = Object.keys(EXPORT_PRESETS) as (keyof typeof EXPORT_PRESETS)[];
const MIN_CROP = 16; // canvas px, so a crop never collapses

type Corner = "nw" | "ne" | "se" | "sw";

function sameAspect(sourceWidth: number, sourceHeight: number, width: number, height: number) {
  return Math.abs(sourceWidth / sourceHeight - width / height) < 0.000_001;
}

function isFullCanvasCrop(crop: ExportCrop, width: number, height: number) {
  return crop.x === 0 && crop.y === 0 && crop.w === width && crop.h === height;
}

export interface ExportModalRuntime {
  previewSrc: string;
  resolutionIndependent: boolean;
  saveSettings(settings: ExportSettings): Promise<void>;
  download(settings: ExportSettings): Promise<void>;
  saveBundle(): Promise<void>;
}

/** Re-fit a crop to a new aspect, keeping its center where possible. */
function reAspectCrop(
  prev: ExportCrop,
  cw: number,
  ch: number,
  tw: number,
  th: number,
): ExportCrop {
  const aspect = tw / th;
  let w = prev.w;
  let h = w / aspect;
  if (h > ch) {
    h = ch;
    w = h * aspect;
  }
  if (w > cw) {
    w = cw;
    h = w / aspect;
  }
  const cx = prev.x + prev.w / 2;
  const cy = prev.y + prev.h / 2;
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, cw, ch);
}

export function ExportModal({
  canvas,
  scene,
  ts,
  onClose,
  runtime,
}: {
  canvas: Canvas;
  scene: Scene | null;
  ts: number;
  onClose: () => void;
  runtime?: ExportModalRuntime;
}) {
  const cw = canvas.width;
  const ch = canvas.height;
  const initial = scene?.export ?? null;
  const initialWidth = initial?.width ?? EXPORT_PRESETS.youtube.width;
  const initialHeight = initial?.height ?? EXPORT_PRESETS.youtube.height;
  const initialCrop = initial?.crop
    ? clampCrop(initial.crop, cw, ch)
    : coverCrop(cw, ch, initialWidth, initialHeight);
  const initialCropIsFullCanvas = isFullCanvasCrop(initialCrop, cw, ch);

  const [format, setFormat] = useState<ExportFormat>(initial?.format ?? "png");
  const [preset, setPreset] = useState<string>(initial?.preset ?? "youtube");
  const [width, setWidth] = useState<number>(initialWidth);
  const [height, setHeight] = useState<number>(initialHeight);
  const [crop, setCrop] = useState<ExportCrop>(initialCrop);
  const [cropEnabled, setCropEnabled] = useState(
    !sameAspect(cw, ch, initialWidth, initialHeight) ||
      Boolean(initial?.crop && !initialCropIsFullCanvas),
  );
  const [saved, setSaved] = useState(false);
  const [working, setWorking] = useState<"download" | "bundle" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { ref: stageRef, size: avail } = useElementSize<HTMLDivElement>();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ mode: "move" | Corner; sx: number; sy: number; orig: ExportCrop } | null>(
    null,
  );

  const fit = containBox(avail.w, avail.h, cw / ch);
  const scale = fit.w > 0 ? fit.w / cw : 1;

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function applyTarget(w: number, h: number, presetKey: string, resetCrop = false) {
    const cropRequired = !sameAspect(cw, ch, w, h);
    setWidth(w);
    setHeight(h);
    setPreset(presetKey);
    setCropEnabled(cropRequired);
    setCrop((prev) =>
      resetCrop || !cropRequired ? coverCrop(cw, ch, w, h) : reAspectCrop(prev, cw, ch, w, h),
    );
    setSaved(false);
  }

  function onPresetChange(key: string) {
    if (key === "custom") {
      setPreset("custom");
      return;
    }
    const p = EXPORT_PRESETS[key as keyof typeof EXPORT_PRESETS];
    applyTarget(p.width, p.height, key, true);
  }

  function onDim(which: "w" | "h", value: number) {
    if (!Number.isFinite(value) || value <= 0) return;
    const w = which === "w" ? value : width;
    const h = which === "h" ? value : height;
    applyTarget(Math.round(w), Math.round(h), "custom");
  }

  // ---- crop drag (aspect-locked to width:height) --------------------------------

  const aspect = width / height;

  function toCanvas(e: ReactPointerEvent): { x: number; y: number } {
    const r = frameRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }

  function startDrag(mode: "move" | Corner) {
    return (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      drag.current = { mode, sx: e.clientX, sy: e.clientY, orig: { ...crop } };
    };
  }

  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "move") {
      const dx = (e.clientX - d.sx) / scale;
      const dy = (e.clientY - d.sy) / scale;
      const next = clampCrop(
        { x: d.orig.x + dx, y: d.orig.y + dy, w: d.orig.w, h: d.orig.h },
        cw,
        ch,
      );
      setCrop(next);
      setCropEnabled(!isFullCanvasCrop(next, cw, ch));
      return;
    }
    // Corner resize: the opposite corner is the fixed anchor; keep aspect.
    const dirX = d.mode === "ne" || d.mode === "se" ? 1 : -1;
    const dirY = d.mode === "se" || d.mode === "sw" ? 1 : -1;
    const anchorX = dirX > 0 ? d.orig.x : d.orig.x + d.orig.w;
    const anchorY = dirY > 0 ? d.orig.y : d.orig.y + d.orig.h;
    const p = toCanvas(e);
    let w = Math.abs(Math.min(Math.max(p.x, 0), cw) - anchorX);
    const hFromPointer = Math.abs(Math.min(Math.max(p.y, 0), ch) - anchorY);
    w = Math.max(w, hFromPointer * aspect); // drive by the larger axis
    const maxW = dirX > 0 ? cw - anchorX : anchorX;
    const maxH = dirY > 0 ? ch - anchorY : anchorY;
    w = Math.max(MIN_CROP, Math.min(w, maxW, maxH * aspect));
    const h = w / aspect;
    const next = {
      x: dirX > 0 ? anchorX : anchorX - w,
      y: dirY > 0 ? anchorY : anchorY - h,
      w,
      h,
    };
    setCrop(next);
    setCropEnabled(!isFullCanvasCrop(next, cw, ch));
  }

  function endDrag(e: ReactPointerEvent) {
    if (drag.current) {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      drag.current = null;
    }
  }

  // ---- readouts -----------------------------------------------------------------

  const sourceWidth = cropEnabled ? crop.w : cw;
  const outScale = sourceWidth > 0 ? width / sourceWidth : 1;
  const resolutionIndependent = runtime?.resolutionIndependent ?? false;
  const upscaling = !resolutionIndependent && outScale > 1.02;
  const roundedCrop = useMemo(() => clampCrop(crop, cw, ch), [crop, cw, ch]);

  function settings(): ExportSettings {
    return {
      width: Math.round(width),
      height: Math.round(height),
      format,
      quality: initial?.quality ?? 90,
      crop: cropEnabled ? roundedCrop : null,
      preset: preset === "custom" ? null : preset,
    };
  }

  async function onSave() {
    try {
      setActionError(null);
      await (runtime?.saveSettings ?? saveExportSettings)(settings());
      setSaved(true);
    } catch (cause) {
      setSaved(false);
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function onDownload() {
    if (!runtime) return;
    setWorking("download");
    setActionError(null);
    try {
      await runtime.download(settings());
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  }

  async function onBundle() {
    if (!runtime) return;
    setWorking("bundle");
    setActionError(null);
    try {
      await runtime.saveBundle();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  }

  const cropStyle = {
    left: `${crop.x * scale}px`,
    top: `${crop.y * scale}px`,
    width: `${crop.w * scale}px`,
    height: `${crop.h * scale}px`,
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-out; only fires on the backdrop itself, Esc also closes
    <div
      className="export-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="export-modal" role="dialog" aria-modal="true" aria-label="Export">
        <header className="export-head">
          <h2>Export</h2>
          <button type="button" className="export-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="export-body">
          <div className="export-stage" ref={stageRef}>
            <div
              className="export-frame"
              ref={frameRef}
              style={{ width: `${fit.w}px`, height: `${fit.h}px` }}
            >
              <img
                src={runtime?.previewSrc ?? previewUrl(ts)}
                alt="composition"
                draggable={false}
              />
              <div
                className="export-crop"
                style={cropStyle}
                onPointerDown={startDrag("move")}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {(["nw", "ne", "se", "sw"] as Corner[]).map((c) => (
                  <button
                    type="button"
                    key={c}
                    aria-label={`Resize crop ${c}`}
                    className={`export-handle ${c}`}
                    onPointerDown={startDrag(c)}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  />
                ))}
              </div>
            </div>
          </div>

          <aside className="export-controls">
            <label className="export-field">
              <span>Target</span>
              <select value={preset} onChange={(e) => onPresetChange(e.target.value)}>
                {PRESET_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {EXPORT_PRESETS[k].label}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </label>

            <div className="export-field">
              <span>Size</span>
              <div className="export-dims">
                <input
                  type="number"
                  min={1}
                  aria-label="Output width"
                  value={width}
                  onChange={(e) => onDim("w", Number(e.target.value))}
                />
                <span className="export-x">×</span>
                <input
                  type="number"
                  min={1}
                  aria-label="Output height"
                  value={height}
                  onChange={(e) => onDim("h", Number(e.target.value))}
                />
                <span className="export-unit">px</span>
              </div>
            </div>

            <div className="export-field">
              <span>Format</span>
              <div className="export-seg">
                {FORMATS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`export-seg-btn ${f === format ? "on" : ""}`}
                    onClick={() => setFormat(f)}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <dl className="export-readout">
              <div>
                <dt>Output</dt>
                <dd>
                  {Math.round(width)}×{Math.round(height)} px
                </dd>
              </div>
              <div>
                <dt>Framing</dt>
                <dd>{cropEnabled ? "Custom crop" : "Full composition"}</dd>
              </div>
              <div>
                <dt>Quality</dt>
                <dd>
                  {resolutionIndependent
                    ? "Vector artwork stays sharp"
                    : `Raster artwork scaled to ${Math.round(outScale * 100)}%`}
                </dd>
              </div>
            </dl>

            {upscaling ? (
              <div className="export-warn">
                ⚠ Upscaling {outScale.toFixed(1)}× — the crop is smaller than the output and will
                soften. Crop a larger area or lower the size.
              </div>
            ) : null}
            {actionError ? <div className="export-warn">{actionError}</div> : null}

            <div className="export-actions">
              <button type="button" className="btn" onClick={onSave}>
                {saved ? "Saved ✓" : "Save settings"}
              </button>
              {runtime ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={working !== null}
                  onClick={() => void onDownload()}
                >
                  {working === "download" ? "Exporting…" : `Download ${format.toUpperCase()}`}
                </button>
              ) : (
                <a
                  className="btn primary"
                  href={exportCropUrl({ format, width, height, crop: roundedCrop })}
                  download
                >
                  Download {format.toUpperCase()}
                </a>
              )}
            </div>
            {runtime ? (
              <button
                type="button"
                className="export-bundle"
                disabled={working !== null}
                onClick={() => void onBundle()}
              >
                {working === "bundle" ? "Saving bundle…" : "Bundle (.gimpish)"}
              </button>
            ) : (
              <a className="export-bundle" href={BUNDLE_URL} download>
                Bundle (.gimpish)
              </a>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

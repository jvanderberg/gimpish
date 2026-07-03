import { useEffect, useRef, useState } from "react";
import { BUNDLE_URL, type Canvas, type ExportFormat, exportUrl } from "../api";
import { ICON_DOWNLOAD, ICON_LOCKED, ICON_UNLOCKED } from "./icons";

const FORMATS: ExportFormat[] = ["png", "jpg", "webp"];
const MAX_DIM = 10000;

function clampDim(n: number): number {
  return Math.max(1, Math.min(MAX_DIM, Math.round(n)));
}

/** Percent with one decimal, no trailing .0 ("50", "62.5"). */
function pctText(px: number, canvasPx: number): string {
  return String(Math.round((px / canvasPx) * 1000) / 10);
}

/**
 * Download popover: format + output scale. Percent and pixel fields stay in
 * sync; the lock keeps width/height on the canvas aspect ratio (unlock allows
 * free stretch, which disables the percent field — it only means anything for
 * uniform scale). Each field holds raw text while being typed; the others
 * update from it once the value parses.
 */
export function DownloadMenu({ canvas }: { canvas: Canvas | undefined }) {
  const cw = canvas?.width ?? 0;
  const ch = canvas?.height ?? 0;
  const [format, setFormat] = useState<ExportFormat>("png");
  const [locked, setLocked] = useState(true);
  const [pct, setPct] = useState("100");
  const [w, setW] = useState("");
  const [h, setH] = useState("");
  const ref = useRef<HTMLDetailsElement | null>(null);
  const closeMenu = () => ref.current?.removeAttribute("open");

  // (Re)initialize to native size when the canvas dimensions arrive/change.
  useEffect(() => {
    setPct("100");
    setW(cw ? String(cw) : "");
    setH(ch ? String(ch) : "");
  }, [cw, ch]);

  const changePct = (s: string) => {
    setPct(s);
    const p = Number(s);
    if (Number.isFinite(p) && p > 0 && cw && ch) {
      setW(String(clampDim((cw * p) / 100)));
      setH(String(clampDim((ch * p) / 100)));
    }
  };

  const changeW = (s: string) => {
    setW(s);
    const v = Number(s);
    if (Number.isFinite(v) && v > 0 && cw) {
      if (locked && ch) setH(String(clampDim((v * ch) / cw)));
      setPct(pctText(v, cw));
    }
  };

  const changeH = (s: string) => {
    setH(s);
    const v = Number(s);
    if (Number.isFinite(v) && v > 0 && ch) {
      if (locked && cw) {
        setW(String(clampDim((v * cw) / ch)));
        setPct(pctText((v * cw) / ch, cw));
      }
    }
  };

  const toggleLock = () => {
    if (!locked) {
      // Re-locking snaps height back onto the aspect ratio, width wins.
      const v = Number(w);
      if (Number.isFinite(v) && v > 0 && cw && ch) {
        setH(String(clampDim((v * ch) / cw)));
        setPct(pctText(v, cw));
      }
    }
    setLocked(!locked);
  };

  // Invalid/partial input falls back to native size; omit params at native.
  const outW = Number(w) > 0 ? clampDim(Number(w)) : cw;
  const outH = Number(h) > 0 ? clampDim(Number(h)) : ch;
  const href =
    outW === cw && outH === ch
      ? exportUrl(format)
      : exportUrl(format, { width: outW, height: outH });

  return (
    <details className="dl" ref={ref}>
      <summary className="btn icon" title="Download" aria-label="Download">
        {ICON_DOWNLOAD}
      </summary>
      <div className="dl-menu">
        <div className="dl-row seg">
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              className={f === format ? "on" : ""}
              onClick={() => setFormat(f)}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="dl-row">
          <label htmlFor="dl-pct">Scale</label>
          <input
            id="dl-pct"
            type="text"
            inputMode="decimal"
            value={pct}
            disabled={!locked}
            title={locked ? "Percent of canvas size" : "Percent applies to uniform scale only"}
            onChange={(e) => changePct(e.target.value)}
          />
          <span className="unit">%</span>
        </div>
        <div className="dl-row">
          <input
            aria-label="Output width in pixels"
            type="text"
            inputMode="numeric"
            value={w}
            onChange={(e) => changeW(e.target.value)}
          />
          <span className="unit">×</span>
          <input
            aria-label="Output height in pixels"
            type="text"
            inputMode="numeric"
            value={h}
            onChange={(e) => changeH(e.target.value)}
          />
          <span className="unit">px</span>
          <button
            type="button"
            className={`lock ${locked ? "on" : ""}`}
            title={
              locked ? "Aspect ratio locked — click to allow stretch" : "Aspect ratio unlocked"
            }
            aria-label={locked ? "Unlock aspect ratio" : "Lock aspect ratio"}
            onClick={toggleLock}
          >
            {locked ? ICON_LOCKED : ICON_UNLOCKED}
          </button>
        </div>
        <a className="dl-go" href={href} download onClick={closeMenu}>
          Download {format.toUpperCase()} · {outW}×{outH}
        </a>
        <div className="dl-sep" />
        <a href={BUNDLE_URL} download onClick={closeMenu}>
          Bundle (.gimpish)
        </a>
      </div>
    </details>
  );
}

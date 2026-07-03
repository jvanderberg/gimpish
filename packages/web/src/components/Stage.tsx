import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useRef } from "react";
import { BUNDLE_URL, type Canvas, exportUrl, type LayerBox } from "../api";
import type { Size } from "../lib/geometry";
import { Overlay } from "./Overlay";

export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "err";
}

interface StageProps {
  canvas: Canvas | undefined;
  frame: Size;
  wrapRef: RefObject<HTMLDivElement | null>;
  svgRef: RefObject<SVGSVGElement | null>;
  previewSrc: string;
  ghostSrc: string | null;
  ghostStyle: CSSProperties;
  selBox: LayerBox | null;
  k: number;
  live: boolean;
  dropActive: boolean;
  toasts: Toast[];
  onRefresh: () => void;
  onImportClick: () => void;
  onDragEnter: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
  onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void;
}

/** Left side: topbar + the checkerboard stage holding the preview + overlay. */
export function Stage({
  canvas,
  frame,
  wrapRef,
  svgRef,
  previewSrc,
  ghostSrc,
  ghostStyle,
  selBox,
  k,
  live,
  dropActive,
  toasts,
  onRefresh,
  onImportClick,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: StageProps) {
  const dlRef = useRef<HTMLDetailsElement | null>(null);
  const closeMenu = () => dlRef.current?.removeAttribute("open");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop file target; keyboard users have the Import button for the same action
    <div
      className="stage"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="topbar">
        <h1>gimpish</h1>
        <span className="meta">
          <span className={`dot ${live ? "ok" : "off"}`} />
          {live ? "live" : "reconnecting…"}
          {canvas ? `  ·  ${canvas.width}×${canvas.height}  ·  bg ${canvas.background}` : ""}
        </span>
        <div className="actions">
          <button className="btn" type="button" onClick={onImportClick}>
            Import
          </button>
          <details className="dl" ref={dlRef}>
            <summary className="btn">Download</summary>
            <div className="dl-menu">
              <a href={exportUrl("png")} download onClick={closeMenu}>
                PNG (full res)
              </a>
              <a href={exportUrl("jpg")} download onClick={closeMenu}>
                JPG
              </a>
              <a href={exportUrl("webp")} download onClick={closeMenu}>
                WebP
              </a>
              <a href={BUNDLE_URL} download onClick={closeMenu}>
                Bundle (.gimpish)
              </a>
            </div>
          </details>
          <button className="btn" type="button" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </div>
      <div className="canvas-wrap" ref={wrapRef}>
        <div className="frame" style={{ width: `${frame.w}px`, height: `${frame.h}px` }}>
          <img src={previewSrc} alt="scene preview" draggable={false} />
          {ghostSrc ? (
            <img className="ghost" src={ghostSrc} alt="" draggable={false} style={ghostStyle} />
          ) : null}
          <Overlay
            svgRef={svgRef}
            canvasWidth={canvas?.width ?? 1}
            canvasHeight={canvas?.height ?? 1}
            selBox={selBox}
            k={k}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </div>
      </div>
      {dropActive ? (
        <div className="drop-overlay">
          Drop to import — images become layers, .gimpish opens the scene
        </div>
      ) : null}
      {toasts.length > 0 ? (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

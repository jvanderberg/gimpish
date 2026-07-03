import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import type { Canvas, HistoryDepths, LayerBox } from "../api";
import type { Size } from "../lib/geometry";
import { DownloadMenu } from "./DownloadMenu";
import { ICON_IMPORT, ICON_REDO, ICON_REFRESH, ICON_UNDO } from "./icons";
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
  history: HistoryDepths;
  onHistory: (op: "undo" | "redo") => void;
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
  history,
  onHistory,
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
          <button
            className="btn icon"
            type="button"
            title="Undo (⌘Z) — any scene.json change: editor, CLI, or agent"
            aria-label="Undo"
            disabled={history.undo === 0}
            onClick={() => onHistory("undo")}
          >
            {ICON_UNDO}
          </button>
          <button
            className="btn icon"
            type="button"
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
            disabled={history.redo === 0}
            onClick={() => onHistory("redo")}
          >
            {ICON_REDO}
          </button>
          <button
            className="btn icon"
            type="button"
            title="Import images or a .gimpish bundle"
            aria-label="Import"
            onClick={onImportClick}
          >
            {ICON_IMPORT}
          </button>
          <DownloadMenu canvas={canvas} />
          <button
            className="btn icon"
            type="button"
            title="Refresh"
            aria-label="Refresh"
            onClick={onRefresh}
          >
            {ICON_REFRESH}
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

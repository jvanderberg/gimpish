import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { Canvas, LayerBox } from "../api";
import type { Size } from "../lib/geometry";
import { Overlay } from "./Overlay";

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
  onRefresh: () => void;
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
  onRefresh,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: StageProps) {
  return (
    <div className="stage">
      <div className="topbar">
        <h1>gimpish</h1>
        <span className="meta">
          <span className={`dot ${live ? "ok" : "off"}`} />
          {live ? "live" : "reconnecting…"}
          {canvas ? `  ·  ${canvas.width}×${canvas.height}  ·  bg ${canvas.background}` : ""}
        </span>
        <button className="btn" type="button" onClick={onRefresh}>
          Refresh
        </button>
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
    </div>
  );
}

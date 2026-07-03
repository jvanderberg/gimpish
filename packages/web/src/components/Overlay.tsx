import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { LayerBox } from "../api";
import { corners, handlePos } from "../lib/geometry";

const CORNER_LABELS = ["tl", "tr", "br", "bl"] as const;

interface OverlayProps {
  svgRef: RefObject<SVGSVGElement | null>;
  canvasWidth: number;
  canvasHeight: number;
  selBox: LayerBox | null;
  k: number;
  onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void;
}

/** Selection rect + scale/rotate handles, drawn 1:1 over the preview image. */
export function Overlay({
  svgRef,
  canvasWidth,
  canvasHeight,
  selBox,
  k,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: OverlayProps) {
  const cursor = selBox?.move ? "move" : "default";
  const handle = selBox ? handlePos(selBox, 26 * k) : null;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="presentation"
    >
      <title>Selection overlay</title>
      {selBox ? (
        <g transform={`rotate(${selBox.rotation} ${selBox.pivotx} ${selBox.pivoty})`}>
          <rect
            className="hit"
            x={selBox.cx - selBox.w / 2}
            y={selBox.cy - selBox.h / 2}
            width={selBox.w}
            height={selBox.h}
          />
          <rect
            className="box"
            x={selBox.cx - selBox.w / 2}
            y={selBox.cy - selBox.h / 2}
            width={selBox.w}
            height={selBox.h}
            strokeWidth={1.5 * k}
          />
        </g>
      ) : null}
      {selBox?.scale
        ? corners(selBox).map((p, i) => (
            <rect
              key={CORNER_LABELS[i]}
              className="corner"
              x={p.x - 5 * k}
              y={p.y - 5 * k}
              width={10 * k}
              height={10 * k}
              strokeWidth={1.5 * k}
            />
          ))
        : null}
      {selBox?.rotate && handle ? (
        <>
          <line
            className="handle-line"
            x1={selBox.cx}
            y1={selBox.cy}
            x2={handle.x}
            y2={handle.y}
            strokeWidth={1.5 * k}
          />
          <circle className="handle" cx={handle.x} cy={handle.y} r={6 * k} strokeWidth={1.5 * k} />
        </>
      ) : null}
    </svg>
  );
}

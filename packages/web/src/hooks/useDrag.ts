import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";
import type { LayerBox, TransformDelta } from "../api";
import type { Point } from "../lib/geometry";
import { clientToCanvas, corners, DEG, handlePos, hitTest, nextStamp } from "../lib/geometry";

export type DragState =
  | {
      mode: "move";
      id: string;
      stamp: number;
      start: Point;
      orig: { cx: number; cy: number };
      cur: { cx: number; cy: number };
    }
  | {
      mode: "rotate";
      id: string;
      stamp: number;
      pivotx: number;
      pivoty: number;
      startAngle: number;
      orig: { rotation: number };
      cur: { rotation: number };
    }
  | {
      mode: "scale";
      id: string;
      stamp: number;
      pivotx: number;
      pivoty: number;
      d0: number;
      orig: { scale: number };
      cur: { scale: number };
    };

interface UseDragArgs {
  svgRef: RefObject<SVGSVGElement | null>;
  boxes: LayerBox[];
  selBox: LayerBox | null;
  setSel: (id: string | null) => void;
  k: number;
  onCommit: (id: string, delta: TransformDelta) => void;
}

export interface DragHandlers {
  drag: DragState | null;
  onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void;
}

/**
 * Pointer state machine for the canvas overlay: grabbing the rotation
 * handle, a corner (scale), or the box body (move) starts a gesture;
 * pointermove updates only local state; pointerup commits ONE transform
 * POST. The server + WS round-trip then refreshes canonical state.
 */
export function useDrag({ svgRef, boxes, selBox, setSel, k, onCommit }: UseDragArgs): DragHandlers {
  const [drag, setDrag] = useState<DragState | null>(null);
  // True when the current gesture started with a selection already active,
  // so a stationary click can deselect instead of committing a no-op move.
  const downOnSelected = useRef(false);

  const startDrag = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>, box: LayerBox, pt: Point) => {
      const svg = svgRef.current;
      if (!svg) return;
      svg.setPointerCapture(e.pointerId);
      const stamp = nextStamp();

      if (box.rotate) {
        const hp = handlePos(box, 26 * k);
        if (Math.hypot(pt.x - hp.x, pt.y - hp.y) <= 12 * k) {
          const startAngle = Math.atan2(pt.y - box.pivoty, pt.x - box.pivotx) * DEG;
          setDrag({
            mode: "rotate",
            id: box.id,
            stamp,
            pivotx: box.pivotx,
            pivoty: box.pivoty,
            startAngle,
            orig: { rotation: box.rotation },
            cur: { rotation: box.rotation },
          });
          return;
        }
      }

      if (box.scale) {
        const corner = corners(box).find((p) => Math.hypot(pt.x - p.x, pt.y - p.y) <= 11 * k);
        if (corner) {
          const d0 = Math.max(Math.hypot(corner.x - box.pivotx, corner.y - box.pivoty), 1e-3);
          setDrag({
            mode: "scale",
            id: box.id,
            stamp,
            pivotx: box.pivotx,
            pivoty: box.pivoty,
            d0,
            orig: { scale: 1 },
            cur: { scale: 1 },
          });
          return;
        }
      }

      if (box.move) {
        setDrag({
          mode: "move",
          id: box.id,
          stamp,
          start: pt,
          orig: { cx: box.cx, cy: box.cy },
          cur: { cx: box.cx, cy: box.cy },
        });
      }
    },
    [svgRef, k],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const pt = clientToCanvas(svg, e.clientX, e.clientY);
      // A selection owns the drag: grab anywhere to move it, or grab a
      // handle to rotate/scale. Canvas clicks never re-hit-test while
      // something is selected; a stationary click deselects on release.
      if (selBox) {
        downOnSelected.current = true;
        startDrag(e, selBox, pt);
        return;
      }
      downOnSelected.current = false;
      // Nothing selected yet: click a layer to select and start manipulating it.
      const id = hitTest(boxes, pt);
      if (!id) return;
      const box = boxes.find((b) => b.id === id);
      if (!box) return;
      setSel(id);
      startDrag(e, box, pt);
    },
    [svgRef, selBox, boxes, setSel, startDrag],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const pt = clientToCanvas(svg, e.clientX, e.clientY);
      setDrag((d) => {
        if (!d) return d;
        if (d.mode === "move") {
          return {
            ...d,
            cur: { cx: d.orig.cx + (pt.x - d.start.x), cy: d.orig.cy + (pt.y - d.start.y) },
          };
        }
        if (d.mode === "scale") {
          const dist = Math.hypot(pt.x - d.pivotx, pt.y - d.pivoty);
          return { ...d, cur: { scale: Math.max(0.05, dist / d.d0) } };
        }
        const ang = Math.atan2(pt.y - d.pivoty, pt.x - d.pivotx) * DEG;
        const rot = Math.round((d.orig.rotation + (ang - d.startAngle)) * 10) / 10;
        return { ...d, cur: { rotation: rot } };
      });
    },
    [svgRef],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (svg?.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      if (drag) {
        if (drag.mode === "rotate") {
          onCommit(drag.id, { drot: drag.cur.rotation - drag.orig.rotation });
        } else if (drag.mode === "scale") {
          onCommit(drag.id, { scale: drag.cur.scale });
        } else {
          const dx = drag.cur.cx - drag.orig.cx;
          const dy = drag.cur.cy - drag.orig.cy;
          // 3 screen px of slop distinguishes a click from a drag.
          if (downOnSelected.current && Math.hypot(dx, dy) <= 3 * k) setSel(null);
          else onCommit(drag.id, { dx, dy });
        }
      }
      setDrag(null);
    },
    [svgRef, drag, onCommit, setSel, k],
  );

  return { drag, onPointerDown, onPointerMove, onPointerUp };
}

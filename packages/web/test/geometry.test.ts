/** Unit tests for the canvas overlay math (pure functions, no DOM needed). */

import type { LayerBox } from "@gimpish/core/model";
import { describe, expect, it } from "vitest";
import type { DragState } from "../src/hooks/useDrag";
import {
  applyDragToBox,
  containBox,
  corners,
  ghostStyleFor,
  handlePos,
  hitTest,
  insideBox,
  rotAboutPivot,
} from "../src/lib/geometry";

function box(overrides: Partial<LayerBox> = {}): LayerBox {
  return {
    id: "b",
    type: "shape",
    cx: 100,
    cy: 100,
    w: 40,
    h: 20,
    rotation: 0,
    pivotx: 100,
    pivoty: 100,
    move: true,
    rotate: true,
    scale: true,
    ...overrides,
  };
}

describe("containBox", () => {
  it("fits by height when the area is wider than the aspect", () => {
    expect(containBox(1000, 100, 16 / 9)).toEqual({ w: (100 * 16) / 9, h: 100 });
  });
  it("fits by width when the area is taller than the aspect", () => {
    const { w, h } = containBox(160, 1000, 16 / 9);
    expect(w).toBe(160);
    expect(h).toBeCloseTo(90);
  });
  it("degenerates to zero for empty areas", () => {
    expect(containBox(0, 100, 1)).toEqual({ w: 0, h: 0 });
  });
});

describe("insideBox / hitTest", () => {
  it("hits inside an axis-aligned box and misses outside", () => {
    const b = box();
    expect(insideBox(b, { x: 100, y: 100 })).toBe(true);
    expect(insideBox(b, { x: 119, y: 109 })).toBe(true);
    expect(insideBox(b, { x: 121, y: 100 })).toBe(false);
  });

  it("respects rotation when hit-testing", () => {
    // 40x20 box rotated 90°: x extent becomes ±10, y extent ±20.
    const b = box({ rotation: 90 });
    expect(insideBox(b, { x: 100, y: 118 })).toBe(true);
    expect(insideBox(b, { x: 118, y: 100 })).toBe(false);
  });

  it("hitTest returns the topmost (last) box", () => {
    const bottom = box({ id: "bottom" });
    const top = box({ id: "top" });
    expect(hitTest([bottom, top], { x: 100, y: 100 })).toBe("top");
    expect(hitTest([bottom, top], { x: 500, y: 500 })).toBeNull();
  });
});

describe("rotAboutPivot / handlePos / corners", () => {
  it("rotates a point 90° clockwise about the pivot", () => {
    const p = rotAboutPivot({ rotation: 90, pivotx: 0, pivoty: 0 }, 10, 0);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(10);
  });

  it("puts the rotation handle above the top edge when unrotated", () => {
    const p = handlePos(box(), 26);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(100 - 10 - 26);
  });

  it("returns four corners that rotate with the box", () => {
    const cs = corners(box({ rotation: 180 }));
    expect(cs).toHaveLength(4);
    // 180° flips the first corner (-20,-10 offset) to (+20,+10).
    const first = cs[0];
    expect(first?.x).toBeCloseTo(120);
    expect(first?.y).toBeCloseTo(110);
  });
});

describe("applyDragToBox", () => {
  it("returns the box unchanged for a foreign drag", () => {
    const b = box();
    const drag: DragState = {
      mode: "move",
      id: "other",
      stamp: 1,
      start: { x: 0, y: 0 },
      orig: { cx: 0, cy: 0 },
      cur: { cx: 5, cy: 5 },
    };
    expect(applyDragToBox(b, drag)).toBe(b);
  });

  it("translates box and pivot together on move", () => {
    const out = applyDragToBox(box(), {
      mode: "move",
      id: "b",
      stamp: 1,
      start: { x: 0, y: 0 },
      orig: { cx: 100, cy: 100 },
      cur: { cx: 130, cy: 90 },
    });
    expect(out).toMatchObject({ cx: 130, cy: 90, pivotx: 130, pivoty: 90 });
  });

  it("scales size and center about the drag pivot", () => {
    const out = applyDragToBox(box({ cx: 110, cy: 100 }), {
      mode: "scale",
      id: "b",
      stamp: 1,
      pivotx: 100,
      pivoty: 100,
      d0: 10,
      orig: { scale: 1 },
      cur: { scale: 2 },
    });
    expect(out).toMatchObject({ w: 80, h: 40, cx: 120, cy: 100 });
  });

  it("applies live rotation on rotate", () => {
    const out = applyDragToBox(box(), {
      mode: "rotate",
      id: "b",
      stamp: 1,
      pivotx: 100,
      pivoty: 100,
      startAngle: 0,
      orig: { rotation: 0 },
      cur: { rotation: 33 },
    });
    expect(out.rotation).toBe(33);
  });
});

describe("ghostStyleFor", () => {
  const k = 2; // canvas px per CSS px

  it("hides the ghost when there is no drag or no box", () => {
    expect(ghostStyleFor(null, true, k)).toEqual({ display: "none" });
  });

  it("translates in CSS pixels on move", () => {
    const style = ghostStyleFor(
      {
        mode: "move",
        id: "b",
        stamp: 1,
        start: { x: 0, y: 0 },
        orig: { cx: 100, cy: 100 },
        cur: { cx: 140, cy: 80 },
      },
      true,
      k,
    );
    expect(style.transform).toBe("translate(20px, -10px)");
  });

  it("scales about the pivot in CSS pixels", () => {
    const style = ghostStyleFor(
      {
        mode: "scale",
        id: "b",
        stamp: 1,
        pivotx: 200,
        pivoty: 100,
        d0: 10,
        orig: { scale: 1 },
        cur: { scale: 1.5 },
      },
      true,
      k,
    );
    expect(style.transform).toBe("scale(1.5)");
    expect(style.transformOrigin).toBe("100px 50px");
  });

  it("rotates by the gesture delta", () => {
    const style = ghostStyleFor(
      {
        mode: "rotate",
        id: "b",
        stamp: 1,
        pivotx: 100,
        pivoty: 100,
        startAngle: 0,
        orig: { rotation: 10 },
        cur: { rotation: 25 },
      },
      true,
      k,
    );
    expect(style.transform).toBe("rotate(15deg)");
  });
});

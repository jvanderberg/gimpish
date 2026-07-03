import { type RefObject, useLayoutEffect, useRef, useState } from "react";

export interface ElementSize {
  w: number;
  h: number;
}

/** Tracks an element's content-box size via ResizeObserver. */
export function useElementSize<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  size: ElementSize;
} {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const rect = entry.contentRect;
      setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}

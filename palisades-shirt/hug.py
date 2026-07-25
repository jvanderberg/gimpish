"""Isolate the 'hug a tree' lettering from the canopy and trace it."""
from collections import deque

import numpy as np
from PIL import Image

ink = np.array(Image.open("tree_bw.png").convert("L")) > 127
h, w = ink.shape

# window around the lettering, in tree_bw.png pixel space
WX0, WX1, WY0, WY1 = 860, 1360, 930, 1200

labels = np.zeros((h, w), np.int32)
comps = []
nxt = 0
for sy in range(WY0, WY1):
    for sx in np.flatnonzero(ink[sy] & (labels[sy] == 0)):
        if not (WX0 <= sx <= WX1):
            continue
        nxt += 1
        stack = deque([(int(sx), int(sy))])
        size = 0; x0 = x1 = int(sx); y0 = y1 = sy
        while stack:
            x, y = stack.pop()
            if labels[y, x]:
                continue
            lo = x
            while lo > 0 and ink[y, lo-1] and not labels[y, lo-1]:
                lo -= 1
            hi = x
            while hi < w-1 and ink[y, hi+1] and not labels[y, hi+1]:
                hi += 1
            labels[y, lo:hi+1] = nxt
            size += hi-lo+1
            x0, x1 = min(x0, lo), max(x1, hi)
            y0, y1 = min(y0, y), max(y1, y)
            for ny in (y-1, y+1):
                if 0 <= ny < h:
                    seg = ink[ny, lo:hi+1] & (labels[ny, lo:hi+1] == 0)
                    for off in np.flatnonzero(seg):
                        stack.append((lo+int(off), ny))
        comps.append((nxt, size, x0, y0, x1, y1))

keep = np.zeros_like(ink)
comps.sort(key=lambda c: c[2])
for lab, size, x0, y0, x1, y1 in comps:
    # the tree itself leaks into the window; drop anything oversized or
    # touching the window edge, plus fabric speckle
    if size < 60 or size > 6000:
        continue
    if x0 <= WX0 or x1 >= WX1 or y0 <= WY0 or y1 >= WY1:
        continue
    keep |= labels == lab
    print(f"  keep size {size:6d} bbox {x0},{y0} -> {x1},{y1} ({x1-x0+1}x{y1-y0+1})")

ys, xs = np.nonzero(keep)
print(f"lettering bbox in tree_bw px: {xs.min()},{ys.min()} -> {xs.max()},{ys.max()}")
Image.fromarray(np.where(keep, 0, 255).astype(np.uint8)).save("hug_only.pbm")
print("wrote hug_only.pbm")

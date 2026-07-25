"""Split the thresholded shirt print into connected components.

The tree (trunk + branches + ground) is a single large blob; every letter of the
surrounding type is its own small blob. Labelling lets us keep the tree alone.
"""
import sys
from collections import deque

import numpy as np
from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else "tree_bw.png"
img = Image.open(src).convert("L")
ink = np.array(img) > 127  # cream print is the bright value
h, w = ink.shape

labels = np.zeros((h, w), dtype=np.int32)
comps = []  # (label, size, x0, y0, x1, y1)
nxt = 0

for sy in range(h):
    row_ink = ink[sy]
    for sx in np.flatnonzero(row_ink & (labels[sy] == 0)):
        nxt += 1
        # scanline flood fill: push spans, not individual pixels
        stack = deque([(int(sx), int(sy))])
        size = 0
        x0 = x1 = int(sx)
        y0 = y1 = sy
        while stack:
            x, y = stack.pop()
            if labels[y, x]:
                continue
            # walk left/right to span ends
            lo = x
            while lo > 0 and ink[y, lo - 1] and not labels[y, lo - 1]:
                lo -= 1
            hi = x
            while hi < w - 1 and ink[y, hi + 1] and not labels[y, hi + 1]:
                hi += 1
            labels[y, lo:hi + 1] = nxt
            size += hi - lo + 1
            x0, x1 = min(x0, lo), max(x1, hi)
            y0, y1 = min(y0, y), max(y1, y)
            for ny in (y - 1, y + 1):
                if 0 <= ny < h:
                    seg = ink[ny, lo:hi + 1] & (labels[ny, lo:hi + 1] == 0)
                    for off in np.flatnonzero(seg):
                        stack.append((lo + int(off), ny))
        comps.append((nxt, size, x0, y0, x1, y1))

comps.sort(key=lambda c: -c[1])
print(f"image {w}x{h}, {len(comps)} components")
for lab, size, x0, y0, x1, y1 in comps[:20]:
    print(f"  label {lab:4d}  size {size:8d}  bbox {x0},{y0} -> {x1},{y1}"
          f"  ({x1-x0+1}x{y1-y0+1})")


def save(mask, path):
    Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).save(path)


tree_label = comps[0][0]
save(labels == tree_label, "tree_only.pbm")
print("wrote tree_only.pbm")

# Everything that is not the tree and not touching the crop border: the
# "hug a tree" lettering lives inside the canopy, well away from the edges.
inner = np.zeros_like(ink)
for lab, size, x0, y0, x1, y1 in comps:
    if lab == tree_label or size < 200:
        continue
    if x0 == 0 or y0 == 0 or x1 == w - 1 or y1 == h - 1:
        continue
    inner |= labels == lab
    print(f"  inner glyph label {lab} size {size} bbox {x0},{y0} {x1},{y1}")
save(inner, "inner_text.pbm")
print("wrote inner_text.pbm")

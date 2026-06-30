# Example scenes

These scenes are safe to publish. They use only generated shape, gradient, arrow,
and text layers, with no local source images or cached cutouts.

Render one with:

```bash
gimpish preview --scene examples/radial-badge.scene.json \
  --out /tmp/gimpish-example.png --max 768
```

Local working scenes should stay in `scene.json`, `scratch/`, or another ignored
path unless they are deliberately sanitized for publication.

#!/usr/bin/env python3
"""Regenerate the portrait thumbnails the client actually loads.

The full portraits in public/photons/ and public/atoms/ are 800px
WebPs of ~120 KB each (1600px PNGs of ~3.5 MB until the Nov 23, 2026
lightweight pass), but no surface in the app displays one larger than
220 CSS px. Since the Nov 22, 2026 speed pass the client loads 480px
WebP thumbnails from public/<kind>/thumbs/ (~50 KB each) and only
falls back to the full WebP when a thumbnail is missing.

Run this after adding or replacing a portrait:

    python3 scripts/gen-thumbs.py

Requires Pillow (pip install pillow). The full portraits are never
modified; thumbnails are derived files and can be deleted and
regenerated at any time.
"""
import os
import sys

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")


def main() -> int:
    for kind in ("photons", "atoms"):
        src_dir = os.path.join(ROOT, kind)
        out_dir = os.path.join(src_dir, "thumbs")
        os.makedirs(out_dir, exist_ok=True)
        made = 0
        for f in sorted(os.listdir(src_dir)):
            if not f.endswith(".webp"):
                continue
            im = Image.open(os.path.join(src_dir, f)).convert("RGB")
            im.thumbnail((480, 480), Image.LANCZOS)
            im.save(os.path.join(out_dir, f), "WEBP", quality=82, method=6)
            made += 1
        print(f"{kind}: {made} thumbnails in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

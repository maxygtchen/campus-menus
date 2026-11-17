#!/usr/bin/env python3
"""Regenerate docs/icons/icon-192.png and icon-512.png from branding colors."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / "docs" / "icons"


def draw(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), "#14325c")
    d = ImageDraw.Draw(img)
    pad = size // 16
    d.rounded_rectangle((pad, pad, size - pad, size - pad), radius=size // 5, fill="#f5f3ee")
    r = int(size * 0.09)
    d.ellipse((size - pad - r * 3, pad + r, size - pad - r, pad + r * 3), fill="#f0b429")
    cx, cy = size // 2, int(size * 0.52)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", size // 2)
    except OSError:
        font = ImageFont.load_default()
    d.text((cx, cy), "?", fill="#14325c", font=font, anchor="mm")
    return img


def main() -> None:
    for size in (192, 512):
        draw(size).save(ROOT / f"icon-{size}.png")
    print("Wrote", ROOT / "icon-192.png", "and", ROOT / "icon-512.png")


if __name__ == "__main__":
    main()
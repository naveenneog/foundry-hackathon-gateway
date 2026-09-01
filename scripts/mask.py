#!/usr/bin/env python3
"""mask.py - hide secrets and mark up a screenshot you already have.

For anything Playwright cannot drive: a desktop app, a terminal, an installer,
a phone screenshot, a picture someone sent you.

Coordinates are "x,y,w,h". Use fractions of the image (0-1) when you are eyeballing
it, or exact pixels when you know them. Fractions are easier: 0.5,0,0.5,0.1 means
"the top-right tenth". Annotations are applied first, then --crop, then --max-width.

Examples
--------
  python scripts/mask.py raw.png docs/img/step-04-paste-the-key.png \\
      --box 0.12,0.40,0.55,0.05 --label "your key - hidden" --badge 4

  python scripts/mask.py raw.png out.png \\
      --blur 0.0,0.0,1.0,0.06 --ring 0.62,0.31,0.14,0.05 --arrow 0.45,0.20,0.62,0.31

  python scripts/mask.py raw.png out.png --crop 0,0,0.7,0.6 --max-width 1200

Needs Pillow:  pip install pillow
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("Pillow is not installed.\n  Fix: pip install pillow")

INK = (17, 24, 39)       # mask boxes and captions
ACCENT = (225, 29, 72)   # rings, badges, arrows
WHITE = (255, 255, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size: int):
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def parse_rect(text: str, width: int, height: int) -> tuple[int, int, int, int]:
    """'x,y,w,h' -> pixel box. All values <= 1 are read as fractions."""
    try:
        parts = [float(p) for p in text.split(",")]
    except ValueError:
        raise SystemExit(f"Cannot read '{text}'. Use x,y,w,h - for example 0.1,0.2,0.5,0.05")
    if len(parts) != 4:
        raise SystemExit(f"'{text}' needs exactly four numbers: x,y,w,h")
    fractional = all(0.0 <= p <= 1.0 for p in parts)
    if fractional:
        x, y, w, h = parts[0] * width, parts[1] * height, parts[2] * width, parts[3] * height
    else:
        x, y, w, h = parts
    return int(x), int(y), int(max(1, w)), int(max(1, h))


def parse_point_pair(text: str, width: int, height: int) -> tuple[int, int, int, int]:
    try:
        parts = [float(p) for p in text.split(",")]
    except ValueError:
        raise SystemExit(f"Cannot read '{text}'. Use x1,y1,x2,y2")
    if len(parts) != 4:
        raise SystemExit(f"'{text}' needs exactly four numbers: x1,y1,x2,y2")
    fractional = all(0.0 <= p <= 1.0 for p in parts)
    if fractional:
        return (int(parts[0] * width), int(parts[1] * height),
                int(parts[2] * width), int(parts[3] * height))
    return tuple(int(p) for p in parts)  # type: ignore[return-value]


def text_size(draw: ImageDraw.ImageDraw, text: str, font) -> tuple[int, int]:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    return right - left, bottom - top


def draw_caption(img: Image.Image, box: tuple[int, int, int, int], label: str, scale: float) -> None:
    """Puts the label right of the mask box, or below it when there is no room."""
    draw = ImageDraw.Draw(img)
    font = load_font(max(11, int(13 * scale)))
    x, y, w, h = box
    pad = int(5 * scale)
    tw, th = text_size(draw, label, font)
    cw, ch = tw + pad * 2, th + pad * 2

    if x + w + int(8 * scale) + cw < img.width:
        cx, cy = x + w + int(8 * scale), y + max(0, (h - ch) // 2)
    elif y + h + ch + 4 < img.height:
        cx, cy = x, y + h + int(4 * scale)
    else:
        cx, cy = x, max(0, y - ch - int(4 * scale))

    draw.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=int(3 * scale), fill=INK)
    draw.text((cx + pad, cy + pad), label, font=font, fill=WHITE)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Hide secrets and mark up a screenshot.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("source", help="the screenshot you took")
    ap.add_argument("output", help="where to write the safe version")
    ap.add_argument("--box", action="append", default=[], metavar="x,y,w,h",
                    help="paint a solid box over this area (repeat for more)")
    ap.add_argument("--label", action="append", default=[], metavar="TEXT",
                    help="caption for the matching --box, in order")
    ap.add_argument("--blur", action="append", default=[], metavar="x,y,w,h",
                    help="blur this area instead of covering it")
    ap.add_argument("--ring", action="append", default=[], metavar="x,y,w,h",
                    help="draw a red ring around the thing to click")
    ap.add_argument("--arrow", action="append", default=[], metavar="x1,y1,x2,y2",
                    help="draw an arrow from the first point to the second")
    ap.add_argument("--badge", type=int, metavar="N", help="draw the step number in a circle")
    ap.add_argument("--badge-at", metavar="x,y", default=None,
                    help="where to put the badge (default: on the first ring, else top-left)")
    ap.add_argument("--crop", metavar="x,y,w,h", help="trim to this area, applied after the marks")
    ap.add_argument("--max-width", type=int, default=1400,
                    help="shrink to this width for the doc (default 1400, 0 keeps size)")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.exists():
        return fail(f"Cannot find {src}")
    if args.label and len(args.label) > len(args.box):
        return fail("You gave more --label values than --box values.")
    if not any([args.box, args.blur, args.ring, args.arrow, args.badge, args.crop]):
        return fail("Nothing to do. Add at least one of --box, --blur, --ring, --arrow, --badge, --crop.")

    img = Image.open(src).convert("RGB")
    width, height = img.size
    scale = max(1.0, width / 1400)
    draw = ImageDraw.Draw(img)

    for spec in args.blur:
        x, y, w, h = parse_rect(spec, width, height)
        region = img.crop((x, y, x + w, y + h))
        radius = max(8, int(min(w, h) / 3))
        img.paste(region.filter(ImageFilter.GaussianBlur(radius)), (x, y))

    boxes = []
    for i, spec in enumerate(args.box):
        rect = parse_rect(spec, width, height)
        boxes.append(rect)
        x, y, w, h = rect
        draw.rounded_rectangle([x, y, x + w, y + h], radius=int(4 * scale), fill=INK)
    for i, rect in enumerate(boxes):
        label = args.label[i] if i < len(args.label) else "hidden"
        draw_caption(img, rect, label, scale)

    rings = []
    for spec in args.ring:
        x, y, w, h = parse_rect(spec, width, height)
        rings.append((x, y, w, h))
        draw.rounded_rectangle([x, y, x + w, y + h], radius=int(8 * scale),
                               outline=ACCENT, width=max(3, int(3 * scale)))

    for spec in args.arrow:
        x1, y1, x2, y2 = parse_point_pair(spec, width, height)
        line_w = max(3, int(3 * scale))
        draw.line([x1, y1, x2, y2], fill=ACCENT, width=line_w)
        head = max(10, int(12 * scale))
        import math
        angle = math.atan2(y2 - y1, x2 - x1)
        for side in (-1, 1):
            a = angle + side * math.radians(28)
            draw.line([x2, y2, x2 - head * math.cos(a), y2 - head * math.sin(a)],
                      fill=ACCENT, width=line_w)

    if args.badge is not None:
        size = max(26, int(30 * scale))
        if args.badge_at:
            bx, by, _, _ = parse_rect(f"{args.badge_at},0.01,0.01", width, height)
        elif rings:
            bx, by = rings[0][0] - size // 2, rings[0][1] - size // 2
        else:
            bx, by = int(16 * scale), int(16 * scale)
        bx, by = max(0, bx), max(0, by)
        draw.ellipse([bx, by, bx + size, by + size], fill=ACCENT)
        font = load_font(int(size * 0.55))
        label = str(args.badge)
        tw, th = text_size(draw, label, font)
        draw.text((bx + (size - tw) / 2, by + (size - th) / 2 - int(2 * scale)),
                  label, font=font, fill=WHITE)

    if args.crop:
        x, y, w, h = parse_rect(args.crop, width, height)
        img = img.crop((max(0, x), max(0, y), min(width, x + w), min(height, y + h)))

    if args.max_width and img.width > args.max_width:
        ratio = args.max_width / img.width
        img = img.resize((args.max_width, int(img.height * ratio)), Image.LANCZOS)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)
    print(f"  saved {out}  ({img.width}x{img.height})")
    print("  Open it and check nothing private is still readable.")
    return 0


def fail(message: str) -> int:
    print(f"\n  {message}\n", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

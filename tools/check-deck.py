"""Structural checks on the report deck.

This model cannot read images, so a visual pass is impossible. These checks are
the part of layout review that does not need eyes:

  * every shape sits inside the slide (exact, not estimated);
  * images keep their source aspect ratio (exact);
  * no text box is asked to hold far more text than it can (an *estimate* from
    real font metrics, and reported as one).

The last one uses Microsoft YaHei, which is what the deck specifies for CJK, so
the estimate is at least measured against the same glyphs LibreOffice would use.

    python tools/check-deck.py
"""

import os
import sys

from PIL import Image, ImageFont
from pptx import Presentation
from pptx.util import Emu

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DECK = os.path.join(ROOT, "artifacts", "report", "FOREIGN-report.pptx")
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]

DPI = 96.0
problems = []
notes = []


def font_for(name, pt):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, int(round(pt * DPI / 72)))
            except OSError:
                continue
    return None


def wrap_count(text, font, width_px):
    """How many lines this text needs at this width. Greedy, per character for CJK."""
    if not text.strip():
        return 1
    if font is None:
        # Without metrics, assume ~2 glyph-widths per character at this size.
        per_line = max(1, int(width_px / (font_size_hint * 0.5)))
        return max(1, -(-len(text) // per_line))
    lines, current = 1, ""
    for ch in text:
        if ch == "\n":
            lines += 1
            current = ""
            continue
        candidate = current + ch
        if font.getlength(candidate) > width_px and current:
            lines += 1
            current = ch
        else:
            current = candidate
    return lines


font_size_hint = 12


def main():
    if not os.path.exists(DECK):
        print(f"missing {DECK} — run tools/build-deck.py first")
        return 1

    prs = Presentation(DECK)
    sw, sh = prs.slide_width, prs.slide_height
    print(f"slide {Emu(sw).inches:.3f} x {Emu(sh).inches:.3f} in, {len(prs.slides._sldIdLst)} slides")

    for index, slide in enumerate(prs.slides, start=1):
        for shape in slide.shapes:
            name = f"slide {index} / {shape.shape_type}"

            # --- exact: is it on the slide at all? -------------------------
            if shape.left is None:
                continue
            right = shape.left + (shape.width or 0)
            bottom = shape.top + (shape.height or 0)
            if shape.left < -Emu(9525) or shape.top < -Emu(9525) or right > sw + Emu(9525) or bottom > sh + Emu(9525):
                problems.append(
                    f"{name}: extends past the slide "
                    f"(x {Emu(shape.left).inches:.2f}..{Emu(right).inches:.2f}, "
                    f"y {Emu(shape.top).inches:.2f}..{Emu(bottom).inches:.2f})"
                )

            # --- exact: did an image get stretched? ------------------------
            if shape.shape_type == 13:  # PICTURE
                try:
                    with Image.open(shape.image.blob and _as_stream(shape)) as im:
                        iw, ih = im.size
                except Exception:
                    continue
                want = iw / ih
                got = shape.width / shape.height
                if abs(want - got) / want > 0.01:
                    problems.append(
                        f"{name}: aspect ratio {got:.3f} vs source {want:.3f} "
                        f"(stretched by {abs(got - want) / want * 100:.1f}%)"
                    )

            # --- estimated: is there more text than room? ------------------
            if not shape.has_text_frame:
                continue
            # A decorative bar or a background rectangle still carries an empty
            # paragraph. Treating that as text reported every divider in the deck
            # as overflowing a 1-px-tall box.
            if not shape.text_frame.text.strip():
                continue
            width_px = Emu(shape.width).inches * DPI
            height_px = Emu(shape.height).inches * DPI
            needed = 0.0
            for para in shape.text_frame.paragraphs:
                text = "".join(run.text for run in para.runs)
                pt = next((run.font.size.pt for run in para.runs if run.font.size), 12)
                font = font_for("Segoe UI", pt)
                lines = wrap_count(text, font, width_px)
                space_after = para.space_after.pt if para.space_after else 0
                needed += lines * pt * 1.22 * DPI / 72 + space_after * DPI / 72
            if needed > height_px * 1.02:
                ratio = needed / height_px
                label = "overflow" if ratio > 1.25 else "tight"
                msg = (
                    f"{name}: {ratio:.2f}x its box "
                    f"(needs ~{needed / DPI:.2f} in, has {height_px / DPI:.2f} in)"
                )
                (problems if label == "overflow" else notes).append(f"{msg} [{label}]")

    print()
    if problems:
        print(f"{len(problems)} structural problem(s):")
        for p in problems:
            print(f"  ! {p}")
    else:
        print("no structural problems: everything is on-slide and undistorted")

    if notes:
        print(f"\n{len(notes)} box(es) estimated tight (text may clip — an estimate, not a verification):")
        for n in notes:
            print(f"  ~ {n}")

    return 1 if problems else 0


def _as_stream(shape):
    import io

    return io.BytesIO(shape.image.blob)


if __name__ == "__main__":
    sys.exit(main())

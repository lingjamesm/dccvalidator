"""Find and black out card numbers in screenshots, photos and PDFs.

Every file is rendered to images, read with OCR, masked, and read again to
confirm nothing is left. A PDF is rebuilt from its masked page images, which
also drops any hidden text layer that might hold a card number.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass

import pypdfium2 as pdfium
import pytesseract
from PIL import Image, ImageDraw, ImageOps

from .pan import KEEP_LAST, Box, Word, find_in_line, is_pan

PDF_DPI = 200
MAX_PDF_PAGES = 30
OCR_MODES = ("--psm 6", "--psm 11")  # block of text, and sparse text (screens, receipts)


class UnmaskableError(Exception):
    """A card number seems present but could not be reliably removed."""


@dataclass
class Result:
    data: bytes
    mime_type: str
    pans_masked: int


def _lines(words: list[Word]) -> list[list[Word]]:
    """Group words into lines by vertical overlap (OCR line numbers vary by mode)."""
    lines: list[list[Word]] = []
    for w in sorted(words, key=lambda w: (w.top + w.height / 2, w.left)):
        centre = w.top + w.height / 2
        for line in lines:
            ref = line[0]
            if abs(centre - (ref.top + ref.height / 2)) <= max(ref.height, w.height) * 0.5:
                line.append(w)
                break
        else:
            lines.append([w])
    return lines


def _ocr_words(image: Image.Image, mode: str) -> list[Word]:
    gray = ImageOps.grayscale(image)
    scale = 2 if gray.width < 1600 else 1
    if scale != 1:
        gray = gray.resize((gray.width * scale, gray.height * scale), Image.LANCZOS)
    data = pytesseract.image_to_data(gray, config=mode, output_type=pytesseract.Output.DICT)
    words = []
    for text, left, top, width, height in zip(data["text"], data["left"], data["top"], data["width"], data["height"]):
        if text and text.strip():
            words.append(Word(text.strip(), left / scale, top / scale, width / scale, height / scale))
    return words


def _detect(image: Image.Image) -> tuple[set[str], list[Box]]:
    numbers: set[str] = set()
    boxes: list[Box] = []
    for mode in OCR_MODES:
        for line in _lines(_ocr_words(image, mode)):
            for match in find_in_line(line):
                numbers.add(match.digits)
                boxes.extend(match.boxes)
    return numbers, boxes


def _paint(image: Image.Image, boxes: list[Box]) -> None:
    draw = ImageDraw.Draw(image)
    for b in boxes:
        # Generous above and below, tight at the sides so the last four digits stay readable.
        vpad, hpad = 2 + 0.15 * (b.bottom - b.top), 1
        draw.rectangle(
            [max(b.left - hpad, 0), max(b.top - vpad, 0), min(b.right + hpad, image.width), min(b.bottom + vpad, image.height)],
            fill="black",
        )


def mask_image(image: Image.Image, extra_boxes: list[Box] | None = None) -> tuple[Image.Image, set[str]]:
    """Mask card numbers in one image; returns the masked copy and the numbers found."""
    image = ImageOps.exif_transpose(image).convert("RGB")
    numbers, boxes = _detect(image)
    _paint(image, boxes + (extra_boxes or []))
    # Read the masked image again; a second pass catches anything the first missed.
    for _ in range(2):
        leftover, more = _detect(image)
        if not leftover:
            return image, numbers
        numbers |= leftover
        _paint(image, more)
    raise UnmaskableError("A card number is still readable after masking.")


_PAN_IN_TEXT = re.compile(r"(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)")


def _text_layer_boxes(page: pdfium.PdfPage, scale: float) -> tuple[set[str], list[Box]]:
    """Card numbers in a PDF page's text layer, with their positions in pixels."""
    textpage = page.get_textpage()
    text = textpage.get_text_range()
    height = page.get_height()
    numbers: set[str] = set()
    boxes: list[Box] = []
    for m in _PAN_IN_TEXT.finditer(text):
        idx = [m.start() + i for i, c in enumerate(m.group()) if c.isdigit()]
        digits = "".join(text[i] for i in idx)
        for length in (16, 15, 19, 18, 17, 14, 13):
            start = next((s for s in range(len(digits) - length + 1) if is_pan(digits[s : s + length])), None)
            if start is None:
                continue
            numbers.add(digits[start : start + length])
            for ci in idx[start : start + length - KEEP_LAST]:
                left, bottom, right, top = textpage.get_charbox(ci)
                boxes.append(Box(left * scale, (height - top) * scale, right * scale, (height - bottom) * scale))
            break
    return numbers, boxes


def mask_pdf(data: bytes) -> tuple[bytes, int]:
    pdf = pdfium.PdfDocument(data)
    if len(pdf) > MAX_PDF_PAGES:
        raise UnmaskableError(f"PDFs are limited to {MAX_PDF_PAGES} pages.")
    scale = PDF_DPI / 72
    pages: list[Image.Image] = []
    numbers: set[str] = set()
    for i in range(len(pdf)):
        page = pdf[i]
        text_numbers, text_boxes = _text_layer_boxes(page, scale)
        image = page.render(scale=scale).to_pil()
        masked, found = mask_image(image, text_boxes)
        numbers |= found | text_numbers
        pages.append(masked)
    out = io.BytesIO()
    pages[0].save(out, format="PDF", save_all=True, append_images=pages[1:], resolution=PDF_DPI)
    return out.getvalue(), len(numbers)


def mask_file(data: bytes, mime_type: str) -> Result:
    if mime_type == "application/pdf":
        masked, count = mask_pdf(data)
        return Result(masked, mime_type, count)
    if mime_type not in ("image/png", "image/jpeg"):
        raise UnmaskableError("Only PNG, JPG and PDF files are accepted.")
    image, numbers = mask_image(Image.open(io.BytesIO(data)))
    out = io.BytesIO()
    if mime_type == "image/png":
        image.save(out, format="PNG", optimize=True)
    else:
        image.save(out, format="JPEG", quality=90)
    return Result(out.getvalue(), mime_type, len(numbers))

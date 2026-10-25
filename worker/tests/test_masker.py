import io

import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from dcc_worker.masker import _detect, mask_file
import pypdfium2 as pdfium

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def screen(lines: list[str], size=(900, 520)) -> Image.Image:
    img = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, 30)
    for i, line in enumerate(lines):
        draw.text((40, 40 + i * 70), line, fill="black", font=font)
    return img


def encode(img: Image.Image, fmt: str) -> bytes:
    out = io.BytesIO()
    img.save(out, format=fmt)
    return out.getvalue()


DCC_SCREEN = [
    "Pay in your card currency?",
    "Card 4111 1111 1111 1111",
    "EUR 100.00 or GBP 87.45",
    "Rate 0.8745  Markup 3.5%",
    "Terminal 12345678",
]


@pytest.mark.parametrize("fmt,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg")])
def test_screen_card_number_is_masked(fmt, mime):
    result = mask_file(encode(screen(DCC_SCREEN), fmt), mime)
    assert result.pans_masked == 1
    masked = Image.open(io.BytesIO(result.data))
    leftover, _ = _detect(masked)
    assert leftover == set()


def test_rest_of_screen_stays_readable():
    import pytesseract

    result = mask_file(encode(screen(DCC_SCREEN), "PNG"), "image/png")
    text = pytesseract.image_to_string(Image.open(io.BytesIO(result.data)))
    assert "4111 1111" not in text
    assert "87.45" in text and "Markup" in text
    assert "1111" in text  # the last four digits remain, as on a truncated receipt


def test_clean_screen_is_unchanged_in_content():
    clean = [line for line in DCC_SCREEN if not line.startswith("Card")]
    result = mask_file(encode(screen(clean), "PNG"), "image/png")
    assert result.pans_masked == 0


def test_mastercard_with_dashes_on_receipt():
    receipt = ["MERCHANT COPY", "MASTERCARD", "5555-5555-5555-4444", "TOTAL GBP 43.10"]
    result = mask_file(encode(screen(receipt, (700, 360)), "JPEG"), "image/jpeg")
    assert result.pans_masked == 1


def pdf_with_text(lines: list[str]) -> bytes:
    out = io.BytesIO()
    c = canvas.Canvas(out, pagesize=A4)
    y = 780
    for line in lines:
        c.setFont("Helvetica", 14)
        c.drawString(60, y, line)
        y -= 30
    c.showPage()
    c.drawString(60, 780, "Page two has no card number")
    c.save()
    return out.getvalue()


def test_pdf_is_masked_and_rebuilt_without_text_layer():
    result = mask_file(pdf_with_text(DCC_SCREEN), "application/pdf")
    assert result.pans_masked == 1
    pdf = pdfium.PdfDocument(result.data)
    assert len(pdf) == 2
    # The rebuilt PDF is images only: no text layer can hide a card number.
    assert pdf[0].get_textpage().get_text_range().strip() == ""
    leftover, _ = _detect(pdf[0].render(scale=200 / 72).to_pil())
    assert leftover == set()

from dcc_worker.pan import Word, find_in_line, find_in_text, is_pan, luhn_ok

VISA = "4111111111111111"
MASTERCARD = "5555555555554444"
MC_2_SERIES = "2223003122003222"
AMEX = "378282246310005"


def words(*parts: str, char_w: float = 10, gap: float = 10) -> list[Word]:
    out, x = [], 0.0
    for p in parts:
        out.append(Word(p, x, 0, char_w * len(p), 20))
        x += char_w * len(p) + gap
    return out


def test_luhn():
    assert luhn_ok(VISA) and luhn_ok(MASTERCARD) and luhn_ok(AMEX)
    assert not luhn_ok("4111111111111112")


def test_is_pan_rejects_non_cards():
    assert is_pan(VISA) and is_pan(MC_2_SERIES) and is_pan(AMEX)
    assert not is_pan("0000000000000000")  # one repeated digit
    assert not is_pan("1234567812345670")  # prefix 1 is not a card network
    assert not is_pan("411111111111")  # too short


def test_whole_number_in_one_word():
    [m] = find_in_line(words("Card", VISA))
    assert m.digits == VISA
    assert len(m.boxes) == 1
    card_word = words("Card", VISA)[1]
    # Everything but the last four digits is covered.
    assert m.boxes[0].left == card_word.left
    assert m.boxes[0].right == card_word.left + card_word.width * 12 / 16


def test_number_split_into_groups():
    [m] = find_in_line(words("PAN:", "5555", "5555", "5555", "4444", "EUR"))
    assert m.digits == MASTERCARD
    assert len(m.boxes) == 3  # the last group of four stays visible


def test_dashes_and_ocr_confusions():
    [m] = find_in_line(words("4111-1111-1111-1111"))
    assert m.digits == VISA
    [m] = find_in_line(words("4l11", "1111", "1111", "1111"))
    assert m.digits == VISA


def test_truncated_and_ordinary_numbers_are_left_alone():
    assert find_in_line(words("4111", "****", "****", "1111")) == []
    assert find_in_line(words("Amount", "1,234.56", "Rate", "1.0835")) == []
    assert find_in_line(words("Terminal", "12345678")) == []


def test_groups_far_apart_are_not_joined():
    far = [Word("4111", 0, 0, 40, 20), Word("1111", 50, 0, 40, 20), Word("1111111", 900, 0, 70, 20)]
    assert find_in_line(far) == []


def test_find_in_text():
    assert find_in_text(f"Card {VISA[:4]} {VISA[4:8]} {VISA[8:12]} {VISA[12:]} approved") == [VISA]
    assert find_in_text("Auth code 123456 ref 9876543210") == []

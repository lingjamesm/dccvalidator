"""Card number (PAN) detection.

Works on words with positions, as produced by OCR or by a PDF text layer, so
that every detected digit can be traced back to where it sits on the page.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MIN_LEN, MAX_LEN = 13, 19
KEEP_LAST = 4  # standard truncation: everything but the last four digits is masked

# Common OCR confusions, applied only inside tokens that are mostly digits.
_OCR_DIGITS = str.maketrans({"O": "0", "o": "0", "D": "0", "I": "1", "l": "1", "|": "1", "S": "5", "s": "5", "B": "8", "Z": "2"})
_TOKEN = re.compile(r"^[^\w]*(?P<core>[\w|]+(?:[-.][\w|]+)*)[^\w]*$")


@dataclass(frozen=True)
class Word:
    text: str
    left: float
    top: float
    width: float
    height: float


@dataclass(frozen=True)
class Box:
    left: float
    top: float
    right: float
    bottom: float


@dataclass(frozen=True)
class Match:
    digits: str
    boxes: tuple[Box, ...]  # areas to cover (all but the last four digits)


def luhn_ok(number: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(number)):
        d = ord(ch) - 48
        if i % 2:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def plausible_prefix(number: str) -> bool:
    """Major-network IIN ranges (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro)."""
    return number[0] in "23456"


def is_pan(number: str) -> bool:
    return (
        MIN_LEN <= len(number) <= MAX_LEN
        and number.isdigit()
        and len(set(number)) > 1
        and plausible_prefix(number)
        and luhn_ok(number)
    )


def _digit_token(text: str) -> tuple[str, list[int]] | None:
    """Digits in a word and their character positions, or None if it isn't a digit group."""
    m = _TOKEN.match(text)
    if not m:
        return None
    core_start = m.start("core")
    core = m.group("core")
    alnum = [c for c in core if c not in "-."]
    digits_only = sum(c.isdigit() for c in alnum)
    if not alnum or digits_only / len(alnum) < 0.6:
        return None
    fixed = core.translate(_OCR_DIGITS)
    digits, positions = [], []
    for i, c in enumerate(fixed):
        if c.isdigit():
            digits.append(c)
            positions.append(core_start + i)
        elif c not in "-.":
            return None
    return "".join(digits), positions


def find_in_line(words: list[Word]) -> list[Match]:
    """Find card numbers in one line of words, including numbers split into groups."""
    matches: list[Match] = []
    runs: list[list[tuple[Word, str, list[int]]]] = []
    current: list[tuple[Word, str, list[int]]] = []
    for w in sorted(words, key=lambda w: w.left):
        tok = _digit_token(w.text)
        if tok is None:
            if current:
                runs.append(current)
            current = []
            continue
        if current:
            prev = current[-1][0]
            char_w = prev.width / max(len(prev.text), 1)
            if w.left - (prev.left + prev.width) > max(3 * char_w, prev.height * 1.5):
                runs.append(current)
                current = []
        current.append((w, *tok))
    if current:
        runs.append(current)

    for run in runs:
        digits = "".join(t[1] for t in run)
        owner: list[tuple[int, int]] = []  # digit index -> (token index, char position in word)
        for ti, (_, d, pos) in enumerate(run):
            owner.extend((ti, p) for p in pos)
        i = 0
        while i <= len(digits) - MIN_LEN:
            found = None
            for length in (16, 15, 19, 18, 17, 14, 13):
                cand = digits[i : i + length]
                if len(cand) == length and is_pan(cand):
                    found = length
                    break
            if found is None:
                i += 1
                continue
            cover = owner[i : i + found - KEEP_LAST]
            boxes: list[Box] = []
            for ti in sorted({t for t, _ in cover}):
                w = run[ti][0]
                chars = [p for t, p in cover if t == ti]
                n = max(len(w.text), 1)
                left = w.left + w.width * min(chars) / n
                right = w.left + w.width * (max(chars) + 1) / n
                boxes.append(Box(left, w.top, right, w.top + w.height))
            matches.append(Match(digits[i : i + found], tuple(boxes)))
            i += found
    return matches


def find_in_text(text: str) -> list[str]:
    """Card numbers in plain text (used to cross-check PDF text layers)."""
    found = []
    for m in re.finditer(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)", text):
        digits = re.sub(r"\D", "", m.group())
        for length in (16, 15, 19, 18, 17, 14, 13):
            for start in range(0, len(digits) - length + 1):
                if is_pan(digits[start : start + length]):
                    found.append(digits[start : start + length])
                    break
            else:
                continue
            break
    return found

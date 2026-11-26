"""What the question reader needs: the word splitter (`tokenize`), the labels, and `word_labels`
(the model's labels for our words). Self-test: python3 common.py"""
from __future__ import annotations

import unicodedata
from collections.abc import Sequence

# PLACE: where the photo was taken, not any place name ("[WORD india gate]").
LABELS = ("PER", "DATE", "NEW", "OLD", "VIDEO", "FAV", "WORD", "PLACE")

# A PER span whose text is one of these (lowercased) means the asker: "me".
FIRST_PERSON = frozenset({
    "me", "myself", "i", "i'm", "im", "i'am", "i've", "ive", "i'd", "self",
    "main", "mai", "mein", "mujhe", "muje", "mujhko", "maine", "mene", "khud", "meri", "mera", "mere", "apun",
})

# ---------------------------------------------------------------- splitting into words

_ZWJ = 0x200D


def _is_modifier(cp: int) -> bool:
    """Characters that only decorate an emoji: variation selectors, skin tones, keycap, tags."""
    return (cp in (0xFE0F, 0xFE0E, 0x20E3)
            or 0x1F3FB <= cp <= 0x1F3FF
            or 0xE0020 <= cp <= 0xE007F)


def _is_emoji(cp: int) -> bool:
    return (0x1F000 <= cp <= 0x1FAFF
            or 0x2600 <= cp <= 0x27BF
            or 0x2300 <= cp <= 0x23FF
            or 0x2B00 <= cp <= 0x2BFF
            or cp in (0x3030, 0x303D, 0x3297, 0x3299))


def _is_regional(cp: int) -> bool:
    return 0x1F1E6 <= cp <= 0x1F1FF


def _is_punct(ch: str) -> bool:
    cat = unicodedata.category(ch)
    return cat[0] == "P" or cat in ("Sm", "Sc", "Sk")


def _split_emoji(chunk: str) -> list[tuple[str, bool]]:
    """Cut a whitespace-free chunk into (piece, is_emoji)."""
    out: list[tuple[str, bool]] = []
    buf: list[str] = []
    i, n = 0, len(chunk)
    while i < n:
        cp = ord(chunk[i])
        if _is_modifier(cp) or cp == _ZWJ:
            i += 1
            continue
        if not _is_emoji(cp):
            buf.append(chunk[i])
            i += 1
            continue
        if buf:
            out.append(("".join(buf), False))
            buf = []
        j = i + 1
        if _is_regional(cp) and j < n and _is_regional(ord(chunk[j])):
            j += 1
        while j < n:
            c = ord(chunk[j])
            if _is_modifier(c):
                j += 1
            elif c == _ZWJ and j + 1 < n and _is_emoji(ord(chunk[j + 1])):
                j += 2
            else:
                break
        out.append((chunk[i:j], True))
        i = j
    if buf:
        out.append(("".join(buf), False))
    return out


def _split_edges(piece: str) -> list[str]:
    """Split punctuation off both ends of a word."""
    i, j = 0, len(piece)
    lead: list[str] = []
    while i < j and _is_punct(piece[i]):
        k = i
        while k < j and piece[k] == piece[i]:
            k += 1
        lead.append(piece[i:k])
        i = k
    trail: list[str] = []
    while j > i and _is_punct(piece[j - 1]):
        c = piece[j - 1]
        if c in "'’" and j - 1 > i and piece[j - 2] in "sS":
            break
        k = j
        while k > i and piece[k - 1] == c:
            k -= 1
        trail.append(piece[k:j])
        j = k
    core = [piece[i:j]] if j > i else []
    return lead + core + trail[::-1]


def tokenize(text: str) -> list[str]:
    """Split on whitespace, punctuation off the ends of each word, and every emoji on its own."""
    tokens: list[str] = []
    for chunk in text.split():
        for piece, is_emoji in _split_emoji(chunk):
            if is_emoji:
                tokens.append(piece)
            else:
                tokens.extend(_split_edges(piece))
    return tokens


def word_labels(word_ids: Sequence[int | None], piece_labels: Sequence[str], count: int) -> list[str]:
    """The model's labels for our words: a word gets its first piece's label (then `repair`)."""
    tags = ["O"] * count
    seen: set[int] = set()
    for word, label in zip(word_ids, piece_labels):
        if word is not None and word not in seen:
            seen.add(word)
            tags[word] = label
    return repair(tags)


def repair(tags: list[str]) -> list[str]:
    """An I- with nothing of its kind before it becomes a B-."""
    out: list[str] = []
    for i, tag in enumerate(tags):
        if tag.startswith("I-") and (i == 0 or out[i - 1][2:] != tag[2:]):
            tag = "B-" + tag[2:]
        out.append(tag)
    return out



if __name__ == "__main__":
    assert tokenize("Mom's pics, pls!!! 😍😍") == ["Mom's", "pics", ",", "pls", "!!!", "😍", "😍"]
    assert tokenize("beach😍 \"Goa\" (2019)…") == ["beach", "😍", '"', "Goa", '"', "(", "2019", ")", "…"]
    assert tokenize("Vikas' don't I'm 👍🏽 👨‍👩‍👧 🇮🇳 ❤️") == ["Vikas'", "don't", "I'm", "👍🏽", "👨‍👩‍👧", "🇮🇳", "❤️"]
    assert tokenize("last-minute 25/12/2019 #throwback @rahul") == [
        "last-minute", "25/12/2019", "#", "throwback", "@", "rahul"]
    assert word_labels([None, 0, 0, 1, None], ["O", "B-PER", "I-PER", "O", "O"], 3) == ["B-PER", "O", "O"]
    assert repair(["I-DATE", "I-DATE", "O", "I-PER"]) == ["B-DATE", "I-DATE", "O", "B-PER"]
    print("common.py self-test ok")

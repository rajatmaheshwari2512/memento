"""Shared pieces of the question-reader data: the word splitter, the labels, the answer the
chat model learns to write, and the inline format (`[PER Mom] ki [WORD beach] wali pics`).

`tokenize` is reused at run time, so it stays small and deterministic. Python 3 standard
library only.
"""
from __future__ import annotations

import unicodedata
from collections.abc import Sequence

# PLACE: where the photo was taken ("last time in [PLACE goa]"), not any place name ("[WORD
# india gate]", "delhi wale cousins"). Added last, so the older labels keep their numbers.
LABELS = ("PER", "DATE", "NEW", "OLD", "VIDEO", "FAV", "WORD", "PLACE")
TAGS = ("O",) + tuple(f"{p}-{label}" for label in LABELS for p in ("B", "I"))

# A PER span whose text is one of these (lowercased) means the asker: "me". "I" and "maine" are
# the asker only when the question is about photos with them in it (README, round 4).
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
    return (0x1F000 <= cp <= 0x1FAFF      # pictographs, faces, flags, food, people ...
            or 0x2600 <= cp <= 0x27BF     # misc symbols and dingbats (heart, sparkles, sun)
            or 0x2300 <= cp <= 0x23FF     # watch, hourglass, alarm clock
            or 0x2B00 <= cp <= 0x2BFF     # star, arrows
            or cp in (0x3030, 0x303D, 0x3297, 0x3299))


def _is_regional(cp: int) -> bool:
    return 0x1F1E6 <= cp <= 0x1F1FF


def _is_punct(ch: str) -> bool:
    cat = unicodedata.category(ch)
    return cat[0] == "P" or cat in ("Sm", "Sc", "Sk")


def _split_emoji(chunk: str) -> list[tuple[str, bool]]:
    """Cut a whitespace-free chunk into (piece, is_emoji). One emoji (with its skin tone,
    variation selector and zero-width-joined parts, or a two-letter flag) is one piece.
    Stray decoration characters outside an emoji are dropped."""
    out: list[tuple[str, bool]] = []
    buf: list[str] = []
    i, n = 0, len(chunk)
    while i < n:
        cp = ord(chunk[i])
        if _is_modifier(cp) or cp == _ZWJ:
            i += 1  # stray decoration: drop it
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
    """Split punctuation off both ends of a word. A run of the same mark ("!!!", "...") is one
    token. Apostrophes inside a word stay ("Mom's", "don't"), and so does a trailing one
    after an s ("Vikas'", "parents'")."""
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
    """Split on whitespace, then split punctuation off the ends of each word and make every
    emoji its own token."""
    tokens: list[str] = []
    for chunk in text.split():
        for piece, is_emoji in _split_emoji(chunk):
            if is_emoji:
                tokens.append(piece)
            else:
                tokens.extend(_split_edges(piece))
    return tokens


def is_content(token: str) -> bool:
    """False for a punctuation-only or emoji token. Those are always tagged O."""
    if not token:
        return False
    if _is_emoji(ord(token[0])):
        return False
    return not all(_is_punct(ch) for ch in token)


# ---------------------------------------------------------------- labels

def check_tags(tokens: list[str], tags: list[str]) -> str | None:
    """Return what is wrong with a tag sequence, or None if it is valid."""
    if len(tokens) != len(tags):
        return f"{len(tokens)} tokens but {len(tags)} tags"
    prev = "O"
    for i, (tok, tag) in enumerate(zip(tokens, tags)):
        if tag not in TAGS:
            return f"unknown tag {tag!r} at {i}"
        if tag != "O" and not is_content(tok):
            return f"punctuation or emoji {tok!r} tagged {tag} at {i}"
        if tag.startswith("I-") and prev[2:] != tag[2:]:
            return f"{tag} after {prev} at {i}"
        prev = tag
    return None


def spans(tags: list[str]) -> list[tuple[str, int, int]]:
    """(label, start, end) for each labelled span. A stray I- starts a new span."""
    out: list[tuple[str, int, int]] = []
    for i, tag in enumerate(tags):
        if tag == "O":
            continue
        kind, label = tag[:1], tag[2:]
        last = out[-1] if out else None
        if kind == "I" and last is not None and last[0] == label and last[2] == i:
            out[-1] = (label, last[1], i + 1)
        else:
            out.append((label, i, i + 1))
    return out


def word_labels(word_ids: Sequence[int | None], piece_labels: Sequence[str], count: int) -> list[str]:
    """The model's labels for our words: the model labels word pieces, and only each word's
    first piece was trained, so a word gets its first piece's label (then `repair`). Words the
    length limit cut off stay O. Used in training, evaluation and on the server alike."""
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


def strip_possessive(text: str) -> str:
    """'Mom's' -> 'Mom', 'Rahul’s' -> 'Rahul', 'Vikas'' -> 'Vikas' (only the apostrophe goes
    after an s)."""
    low = text.lower()
    if len(text) > 2 and (low.endswith("'s") or low.endswith("’s")):
        return text[:-2]
    if len(text) > 2 and (low.endswith("s'") or low.endswith("s’")):
        return text[:-1]
    return text


def answer(tokens: list[str], tags: list[str]) -> dict[str, object]:
    """The chat model's target, derived from the labels."""
    people: list[str] = []
    seen: set[str] = set()
    dates: list[str] = []
    order = "none"
    kind = "any"
    favorite = False
    for label, s, e in spans(tags):
        text = " ".join(tokens[s:e])
        if label == "PER":
            name = strip_possessive(text)
            if name.lower().replace("’", "'") in FIRST_PERSON:
                name = "me"
            key = name.lower()
            if key not in seen:  # the same person twice is one person
                seen.add(key)
                people.append(name)
        elif label == "DATE":
            dates.append(text)
        elif label == "NEW" and order == "none":
            order = "newest"
        elif label == "OLD" and order == "none":
            order = "oldest"
        elif label == "VIDEO":
            kind = "video"
        elif label == "FAV":
            favorite = True
    # Places are search words too (the test sets' gold answers list them there).
    words: list[str] = []
    for tok, tag in zip(tokens, tags):
        if tag.endswith(("-WORD", "-PLACE")):
            w = strip_possessive(tok).lower()
            if w not in words:
                words.append(w)
    return {"people": people, "date": " ".join(dates), "order": order, "kind": kind,
            "favorite": favorite, "words": words}


# ---------------------------------------------------------------- segments and inline format

class InlineError(ValueError):
    pass


def tag_segments(segments: list[tuple[str, str]]) -> tuple[str, list[str], list[str]]:
    """Label a text given as consecutive (label, piece) segments; label "O" or one of LABELS.
    Each labelled segment is one span (punctuation and emojis inside it are O and split it).
    Returns (text, tokens, tags). Raises InlineError if a segment edge falls inside a token
    (e.g. "[PER Rahul]'s") or a labelled segment has no words."""
    text = "".join(piece for _, piece in segments)
    tokens: list[str] = []
    tags: list[str] = []
    for label, piece in segments:
        toks = tokenize(piece)
        if label == "O":
            tokens.extend(toks)
            tags.extend("O" for _ in toks)
            continue
        if label not in LABELS:
            raise InlineError(f"unknown label {label!r}")
        if not any(is_content(t) for t in toks):
            raise InlineError(f"{label} span {piece!r} has no words")
        begin = True
        for t in toks:
            tokens.append(t)
            if not is_content(t):
                tags.append("O")
                begin = True
            else:
                tags.append(("B-" if begin else "I-") + label)
                begin = False
    if tokens != tokenize(text):
        raise InlineError(f"a label edge cuts a word: {tokenize(text)} vs {tokens}")
    return text, tokens, tags


def _inline_segments(line: str) -> list[tuple[str, str]]:
    segs: list[tuple[str, str]] = []
    buf: list[str] = []
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if c == "[":
            close = line.find("]", i + 1)
            if close == -1:
                raise InlineError("'[' without ']'")
            inner = line[i + 1:close]
            if "[" in inner:
                raise InlineError("nested '['")
            tag, _, body = inner.partition(" ")
            if tag not in LABELS:
                raise InlineError(f"unknown tag {tag!r}")
            body = body.strip()
            if not body:
                raise InlineError(f"empty [{tag}]")
            if buf:
                segs.append(("O", "".join(buf)))
                buf = []
            segs.append((tag, body))
            i = close + 1
        elif c == "]":
            raise InlineError("']' without '['")
        else:
            buf.append(c)
            i += 1
    if buf:
        segs.append(("O", "".join(buf)))
    return segs


def parse_inline(line: str) -> tuple[list[str], list[str]]:
    """`[NEW latest] [PER Mom] ki [WORD beach] wali pics dikhao 😍` -> (tokens, tags).
    Raises InlineError for unknown tags, nesting, unbalanced brackets, empty spans, or a
    bracket that cuts a word."""
    _, tokens, tags = tag_segments(_inline_segments(line))
    if not tokens:
        raise InlineError("no words")
    return tokens, tags


def inline_text(line: str) -> str:
    """The plain question an inline line stands for (brackets and tag names removed)."""
    return " ".join("".join(piece for _, piece in _inline_segments(line)).split())


def to_inline(tokens: list[str], tags: list[str]) -> str:
    """Tokens and tags back to the inline format (tokens joined by spaces)."""
    out: list[str] = []
    i = 0
    by_start = {s: (label, e) for label, s, e in spans(tags)}
    while i < len(tokens):
        if i in by_start:
            label, e = by_start[i]
            out.append(f"[{label} {' '.join(tokens[i:e])}]")
            i = e
        else:
            out.append(tokens[i])
            i += 1
    return " ".join(out)


if __name__ == "__main__":  # quick self-test
    assert tokenize("Mom's pics, pls!!! 😍😍") == ["Mom's", "pics", ",", "pls", "!!!", "😍", "😍"]
    assert tokenize("beach😍 \"Goa\" (2019)…") == ["beach", "😍", '"', "Goa", '"', "(", "2019", ")", "…"]
    assert tokenize("Vikas' don't I'm 👍🏽 👨‍👩‍👧 🇮🇳 ❤️") == ["Vikas'", "don't", "I'm", "👍🏽", "👨‍👩‍👧", "🇮🇳", "❤️"]
    assert tokenize("last-minute 25/12/2019 #throwback @rahul") == [
        "last-minute", "25/12/2019", "#", "throwback", "@", "rahul"]
    toks, tags = parse_inline("[NEW latest] [PER Mom] ki [WORD beach] wali pics dikhao 😍")
    assert toks == ["latest", "Mom", "ki", "beach", "wali", "pics", "dikhao", "😍"]
    assert tags == ["B-NEW", "B-PER", "O", "B-WORD", "O", "O", "O", "O"]
    toks, tags = parse_inline("[PER Mom's] and [PER me] at the [WORD beach] [DATE last December]?")
    assert answer(toks, tags) == {"people": ["Mom", "me"], "date": "last December", "order": "none",
                                  "kind": "any", "favorite": False, "words": ["beach"]}
    toks, tags = parse_inline("[DATE Dec 25, 2019] [OLD first] [VIDEO vids] [FAV faves]")
    assert tags == ["B-DATE", "I-DATE", "O", "B-DATE", "B-OLD", "B-VIDEO", "B-FAV"], tags
    assert answer(toks, tags)["date"] == "Dec 25 2019"
    for bad in ("[PER Rahul]'s pics", "[FOO x]", "[PER [DATE x]]", "[PER Mom", "Mom]", "[PER ]",
                "[PER Mom][PER Dad]"):
        try:
            parse_inline(bad)
        except InlineError:
            pass
        else:
            raise AssertionError(bad)
    assert check_tags(["a", "b"], ["O", "I-PER"]) is not None
    assert strip_possessive("Vikas'") == "Vikas" and strip_possessive("Mom’s") == "Mom"
    assert word_labels([None, 0, 0, 1, None], ["O", "B-PER", "I-PER", "O", "O"], 3) == ["B-PER", "O", "O"]
    assert repair(["I-DATE", "I-DATE", "O", "I-PER"]) == ["B-DATE", "I-DATE", "O", "B-PER"]
    print("common.py self-test ok")

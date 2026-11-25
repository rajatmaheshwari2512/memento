#!/usr/bin/env python3
# SelfPhotos Adjust's Markup: makes markup-parity.json, the values both apps' tests check
# (web: markup.spec.ts; Android: test/selfphotos/markup_test.dart), from adjust-markup.json and
# the text's font file, on its own so neither app's code is the source of truth. After changing
# adjust-markup.json:
#   python3 -I markup-parity.py adjust-markup.json \
#     ../../../../../mobile/fonts/GoogleSans/GoogleSans-Bold.ttf > markup-parity.json
#   npx prettier --write markup-parity.json   (from web/)
import json, math, struct, sys

cfg = json.load(open(sys.argv[1]))
font = open(sys.argv[2], 'rb').read()
A = cfg['arrow']
def r(v): return round(v, 6)
photos = [[4000, 3000], [3000, 4000], [1080, 1920], [600, 450]]
widths = []
for w, h in photos:
    longer = max(w, h)
    for i, s in enumerate(cfg['sizes']):
        widths.append({
            'photo': [w, h], 'size': i,
            'pen': r(s['width'] * longer),
            'highlighter': r(s['width'] * cfg['highlighter']['widthScale'] * longer),
            'text': r(s['text'] * longer),
            'textOutline': r(s['text'] * longer * cfg['text']['outline']),
        })
def arrow(frm, to, width):
    dx, dy = to[0]-frm[0], to[1]-frm[1]
    length = math.hypot(dx, dy)
    ux, uy = (dx/length, dy/length) if length > 0 else (1, 0)
    head = min(width * A['headLength'], length * A['maxHeadShare'])
    ang = math.radians(A['headAngle'])
    back, side = head*math.cos(ang), head*math.sin(ang)
    base = [to[0]-ux*back, to[1]-uy*back]
    return {'lineEnd': [r(base[0]), r(base[1])],
            'head': [[r(to[0]), r(to[1])], [r(base[0]-uy*side), r(base[1]+ux*side)], [r(base[0]+uy*side), r(base[1]-ux*side)]]}
arrows = []
for frm, to, photo, size in [
    ([0.1, 0.2], [0.6, 0.7], [4000, 3000], 1),
    ([0.9, 0.5], [0.2, 0.5], [3000, 4000], 2),
    ([0.5, 0.9], [0.5, 0.1], [1080, 1920], 0),
    ([0.5, 0.5], [0.505, 0.502], [4000, 3000], 2),  # short: the head is capped
]:
    longer = max(photo)
    width = cfg['sizes'][size]['width'] * longer
    f = [frm[0]*photo[0], frm[1]*photo[1]]; t = [to[0]*photo[0], to[1]*photo[1]]
    arrows.append({'from': frm, 'to': to, 'photo': photo, 'size': size, **arrow(f, t, width)})

# The font's own numbers (a TrueType file's head, hhea, hmtx and cmap tables): units per em, the
# line's ascent, descent and gap, and each letter's advance. No kerning: the texts below have none.
def table(tag):
    for i in range(struct.unpack('>H', font[4:6])[0]):
        name, _, offset, _ = struct.unpack('>4sIII', font[12 + 16 * i:28 + 16 * i])
        if name == tag.encode():
            return offset
    raise KeyError(tag)
units = struct.unpack('>H', font[table('head') + 18:table('head') + 20])[0]
ascent, descent, gap = struct.unpack('>hhh', font[table('hhea') + 4:table('hhea') + 10])
metrics = struct.unpack('>H', font[table('hhea') + 34:table('hhea') + 36])[0]
def glyph(char):  # cmap format 4 (letters in the basic plane)
    base = table('cmap')
    for i in range(struct.unpack('>H', font[base + 2:base + 4])[0]):
        _, _, offset = struct.unpack('>HHI', font[base + 4 + 8 * i:base + 12 + 8 * i])
        o = base + offset
        if struct.unpack('>H', font[o:o + 2])[0] != 4:
            continue
        count = struct.unpack('>H', font[o + 6:o + 8])[0] // 2
        part = lambda at, fmt='H': struct.unpack('>%d%s' % (count, fmt), font[at:at + 2 * count])
        ends, starts = part(o + 14), part(o + 16 + 2 * count)
        deltas, ranges = part(o + 16 + 4 * count, 'h'), part(o + 16 + 6 * count)
        code = ord(char)
        for k in range(count):
            if starts[k] <= code <= ends[k]:
                if ranges[k] == 0:
                    return (code + deltas[k]) & 0xFFFF
                at = o + 16 + 6 * count + 2 * k + ranges[k] + 2 * (code - starts[k])
                return (struct.unpack('>H', font[at:at + 2])[0] + deltas[k]) & 0xFFFF
    raise KeyError(char)
def advance(char):
    at = table('hmtx') + 4 * min(glyph(char), metrics - 1)
    return struct.unpack('>H', font[at:at + 2])[0]
texts = []
for at, photo, size, text in [
    ([0.5, 0.5], [4000, 3000], 1, 'Hi'),
    ([0.25, 0.75], [1080, 1920], 0, 'Beach day!'),
    ([0.7, 0.3], [600, 450], 2, 'MMM'),
    ([0.1, 0.9], [3000, 4000], 1, 'Hello'),
]:
    pixels = cfg['sizes'][size]['text'] * max(photo)
    width = sum(advance(c) for c in text) * pixels / units
    height = (ascent - descent + gap) * pixels / units
    x, y = at[0] * photo[0], at[1] * photo[1]
    texts.append({'at': at, 'photo': photo, 'size': size, 'text': text,
                  'box': {'x': r(x - width / 2), 'y': r(y - height / 2), 'width': r(width), 'height': r(height)}})
out = {
  '_comment': "SelfPhotos Adjust's Markup: what both apps must work out from adjust-markup.json (web: markup.spec.ts; Android: test/selfphotos/markup_test.dart), in pixels on a photo of the given size: each size's line, highlighter and text sizes, arrows' line ends and heads, and the box a text takes, centred on its place, in GoogleSans Bold (as the font file says: its letters' widths, and its line's ascent and descent; Android has that file, the web the same font as one file for all weights). Within 0.001 of a pixel, except the text boxes: each app's text layout rounds a line's height to whole pixels (Chrome its ascent and descent each, Flutter their sum), so heights within 1 pixel and tops within 0.5; widths and lefts within 0.1. Made by markup-parity.py, not by either app.",
  'arrows': arrows,
  'texts': texts,
  'widths': widths,
}
print(json.dumps(out, indent=2))

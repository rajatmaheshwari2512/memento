#!/usr/bin/env python3
# SelfPhotos Adjust's Auto: makes adjust-auto-parity.json, small made-up pictures and the slider
# values both apps must set for them (web: adjust-auto.spec.ts; Android:
# test/selfphotos/adjust_test.dart), from adjust-auto.json. Its own copy of Auto's maths
# (adjust-auto.ts explains it), so neither app's code is the source of truth. After changing
# adjust-auto.json or Auto:
#   python3 -I adjust-auto-parity.py adjust-auto.json > adjust-auto-parity.json
#   npx prettier --write src/lib/ai-edit/adjust/adjust-auto-parity.json   (from web/)
import json, math, sys

cfg = json.load(open(sys.argv[1]))


def js_round(value):  # as Math.round (halves up), not Python's halves to even
    return math.floor(value + 0.5)


def to_linear(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def to_srgb(v):
    return v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


LINEAR = [to_linear(v / 255) for v in range(256)]


def measure(pixels, width, height):
    step = max(1, math.floor(math.sqrt(width * height / cfg['samples'])))
    histogram = [0] * 256
    low_cut, high_cut = (js_round(tone * 255) for tone in cfg['midtones'])
    count = midtones = greyish = 0
    balance = [0.0, 0.0, 0.0]
    saturation = 0.0
    for y in range(0, height, step):
        for x in range(0, width, step):
            r, g, b = pixels[(y * width + x) * 4:(y * width + x) * 4 + 3]
            luma = (2126 * r + 7152 * g + 722 * b + 5000) // 10000
            histogram[luma] += 1
            count += 1
            if luma < low_cut or luma > high_cut:
                continue
            top = max(r, g, b)
            colour = (top - min(r, g, b)) / top
            saturation += colour
            midtones += 1
            if not colour <= cfg['warmth']['greyish']:
                continue
            balance[0] += LINEAR[r]
            balance[1] += LINEAR[g]
            balance[2] += LINEAR[b]
            greyish += 1

    def tone_at(share):
        total = 0
        for tone in range(256):
            total += histogram[tone]
            if total >= share * count:
                return tone / 255
        return 1

    def share_of(start, end):
        return sum(histogram[start:end + 1]) / count

    return {
        'low': tone_at(cfg['ends']), 'median': tone_at(0.5), 'high': tone_at(1 - cfg['ends']),
        'darkClipped': share_of(0, js_round(cfg['shadows']['clipped'] * 255)),
        'brightClipped': share_of(js_round(cfg['highlights']['clipped'] * 255), 255),
        'balance': [v / greyish for v in balance] if greyish > 0 else [0, 0, 0],
        'greyish': greyish / count,
        'saturation': saturation / midtones if midtones > 0 else 0,
    }


def clamp(value, low, high):
    return min(high, max(low, value))


def to_step(value):  # to the slider's steps, halves away from zero, never -0
    stepped = math.copysign(js_round(abs(value) * 100), value) / 100
    return 0 if stepped == 0 else stepped


def auto_values(stats):
    e, c, b, s, h, w = (cfg[k] for k in ['exposure', 'contrast', 'brightness', 'shadows', 'highlights', 'warmth'])
    lowest, highest = b['middle']
    to_white = 0.5 * math.log2(to_linear(e['white']) / to_linear(max(stats['high'], 1 / 255)))
    to_middle = 0.5 * math.log2(to_linear(lowest) / to_linear(max(stats['median'], 1 / 255)))
    exposure = to_step(clamp(min(to_white, to_middle), 0, e['max']))
    gain = 2 ** (2 * exposure)
    exposed = lambda tone: to_srgb(min(1, to_linear(tone) * gain))

    low = exposed(stats['low'])
    contrast = (to_step(clamp((math.log(2 * c['black']) / math.log(2 * low) - 1) / 1.5, 0, c['max']))
                if c['black'] < low < 0.5 else 0)
    k = 1 + 1.5 * contrast
    contrasted = lambda t: 0.5 * (2 * t) ** k if t < 0.5 else 1 - 0.5 * (2 * (1 - t)) ** k
    uncontrasted = lambda t: 0.5 * (2 * t) ** (1 / k) if t < 0.5 else 1 - 0.5 * (2 * (1 - t)) ** (1 / k)
    middle = clamp(exposed(stats['median']), 0.01, 0.99)
    shown = contrasted(middle)
    aim = uncontrasted(lowest) if shown < lowest else uncontrasted(highest) if shown > highest else middle
    brightness = to_step(clamp(-math.log2(math.log(aim) / math.log(middle)) / 0.75 * b['strength'], b['min'], b['max']))

    shadows = to_step(clamp((stats['darkClipped'] - s['allowed']) * s['perClipped'], 0, s['max']))
    highlights = to_step(-clamp((stats['brightClipped'] - h['allowed']) * h['perClipped'], 0, h['max']))

    colourful = stats['saturation'] >= cfg['grey']
    balanced = colourful and stats['greyish'] >= w['minShare'] and stats['balance'][0] > 0 and stats['balance'][2] > 0
    ratio = stats['balance'][2] / stats['balance'][0] if stats['balance'][0] > 0 else 0
    warmth = to_step(clamp(4 * (ratio - 1) / (1 + ratio) * w['strength'], -w['max'], w['max'])) if balanced else 0
    sat = cfg['saturation']
    saturation = to_step(clamp((sat['target'] - stats['saturation']) * sat['strength'], 0, sat['max'])) if colourful else 0
    return {'exposure': exposure, 'brightness': brightness, 'contrast': contrast, 'highlights': highlights,
            'shadows': shadows, 'saturation': saturation, 'warmth': warmth}


# A run of `steps` tones from `start` to `end`, tinted, `count` pixels each: [red, green, blue, how many].
def ramp(start, end, tint, count, steps=24):
    out = []
    for i in range(steps):
        t = start + (end - start) * i / (steps - 1)
        out.append([js_round(t * tint[0]), js_round(t * tint[1]), js_round(t * tint[2]), count])
    return out


CASES = [
    ('well exposed: little to do',
     ramp(2, 253, [1, 1, 1], 20) + ramp(30, 230, [1, 0.6, 0.4], 12) + ramp(30, 230, [0.4, 0.7, 1], 12)),
    ('too dark: exposure and brightness', ramp(0, 120, [1, 1, 1], 20) + ramp(10, 110, [1, 0.7, 0.5], 10)),
    ('flat and dull: contrast and saturation',
     ramp(90, 180, [1, 1, 1], 20) + ramp(90, 180, [1, 0.85, 0.8], 10) + ramp(90, 180, [0.85, 0.9, 1], 10)),
    ('against the light: shadows and highlights',
     [[0, 0, 0, 150], [3, 3, 3, 60], [255, 255, 255, 140], [252, 252, 250, 50]] + ramp(20, 240, [1, 0.9, 0.8], 25)),
    ('a blue cast: warmer', ramp(5, 250, [0.9, 0.95, 1], 30) + ramp(40, 200, [0.6, 0.8, 1], 6)),
    ('a yellow cast: cooler', ramp(5, 250, [1, 0.97, 0.9], 30) + ramp(40, 200, [1, 0.8, 0.5], 6)),
    ('a sunset: its warm glow not cooled (not greyish)',
     ramp(40, 250, [1, 0.8, 0.7], 30) + ramp(30, 220, [1, 0.55, 0.25], 20)),
    ('a pale blue sky over a grey street: not warmed (the sky is not greyish)',
     ramp(150, 235, [0.8, 0.9, 1], 30) + ramp(50, 170, [1, 1, 1], 20)),
    ('black and white: no colour changes', ramp(40, 160, [1, 1, 1], 40)),
    ('colourful with no greys: warmth left alone', ramp(20, 240, [0.3, 0.6, 1], 30) + ramp(20, 240, [1, 0.4, 0.2], 20)),
    ('large: every second pixel looked at', ramp(10, 200, [1, 0.95, 0.9], 6000) + ramp(60, 220, [0.5, 0.7, 1], 5000)),
]

cases = []
for name, runs in CASES:
    pixels = []
    for r, g, b, count in runs:
        pixels += [r, g, b, 255] * count
    width = len(pixels) // 4
    cases.append({'name': name, 'runs': runs, 'expected': auto_values(measure(pixels, width, 1))})
print(json.dumps({
    '_comment': "SelfPhotos Adjust's Auto: small made-up pictures and the slider values both apps must set for them (web: adjust-auto.spec.ts; Android: test/selfphotos/adjust_test.dart). Each picture is one row of pixels: [red, green, blue, how many] in turn. Made by adjust-auto-parity.py from adjust-auto.json, not by either app.",
    'cases': cases,
}, indent=2))

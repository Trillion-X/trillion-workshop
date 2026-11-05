#!/usr/bin/env python3
"""Remove the splice ticks Kokoro leaves inside pauses: every stretch quieter than -50 dBFS (20 ms RMS) for at least
60 ms becomes digital silence, with 5 ms fades, and a sentence that ends at full level gets a 25 ms fade-out. Usage: voice_clean.py <in.wav> <out.wav>"""
import sys
import numpy as np, soundfile as sf

src, dst = sys.argv[1], sys.argv[2]
y, sr = sf.read(src, always_2d=True)
mono = y.mean(1)
win = int(0.02 * sr)
db = 20 * np.log10(np.sqrt(np.convolve(mono ** 2, np.ones(win) / win, mode='same')) + 1e-9)
quiet = db < -50
gain = np.ones(len(mono))
i, n, min_len, fade = 0, len(mono), int(0.06 * sr), int(0.005 * sr)
runs = []
while i < n:
    if quiet[i]:
        j = i
        while j < n and quiet[j]: j += 1
        runs.append([i, j]); i = j
    else:
        i += 1
# bridge quiet runs split only by a short blip (the tick itself, <= 40 ms)
merged = []
for a, b in runs:
    if merged and a - merged[-1][1] <= int(0.04 * sr) and mono[merged[-1][1]:a].std() < 10 ** (-40 / 20):
        merged[-1][1] = b
    else:
        merged.append([a, b])
for a, b in merged:
    if b - a < min_len: continue
    a2, b2 = a + fade, b - fade
    if b2 <= a2: continue
    gain[a2:b2] = 0
    gain[a:a2] = np.linspace(1, 0, a2 - a)
    # a sentence that stops at full level (Kokoro cuts the last vowel off) gets a 25 ms fade-out instead of a hard edge
    tail = int(0.025 * sr)
    if a - tail > 0 and db[a - int(0.01 * sr)] > -35:
        gain[a - tail:a] = np.minimum(gain[a - tail:a], np.linspace(1, 0, tail))
    gain[b2:b] = np.linspace(0, 1, b - b2)
sf.write(dst, y * gain[:, None], sr, subtype='PCM_24')
print(f'{src}: silenced {sum(1 for a, b in merged if b - a >= min_len)} pauses')

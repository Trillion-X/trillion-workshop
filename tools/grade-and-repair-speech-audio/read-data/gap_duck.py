"""Duck the room in pauses: between a word's end and the next word's start, pull the signal down by duck_db.

A room tail is the sound of the room after the voice stopped; a pause longer than min_gap carries nothing but
tail and noise, so lowering it removes the tail without touching a word. Word times come from the transcript.
duck_db and min_gap are the person's settings.
"""
import numpy as np
import soundfile as sf

AFTER_END = 0.06
BEFORE_NEXT = 0.05
SMOOTH = 0.04


def duck(x, sr, words, duck_db, min_gap):
    gain = np.ones(len(x), np.float32)
    low = 10 ** (duck_db / 20)
    for a, b in zip(words, words[1:] + [None]):
        nxt = b["start"] if b else len(x) / sr
        if nxt - a["end"] < min_gap:
            continue
        i0, i1 = int((a["end"] + AFTER_END) * sr), int((nxt - BEFORE_NEXT) * sr)
        if i1 > i0:
            gain[i0:i1] = low
    k = max(1, int(SMOOTH * sr))
    gain = np.convolve(gain, np.ones(k, np.float32) / k, mode="same")
    return x * gain


def duck_file(src, dst, words, duck_db, min_gap):
    x, sr = sf.read(src, dtype="float32")
    sf.write(dst, duck(x, sr, words, duck_db, min_gap), sr, subtype="PCM_24")

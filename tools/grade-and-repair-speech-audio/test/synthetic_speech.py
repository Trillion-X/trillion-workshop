"""Synthetic "speech" for the tests: voiced bursts (a 130 Hz tone with harmonics) at known word times over a noise floor.

No real recording is used. `speech()` returns the samples and the word times; `write()` saves them as a 48 kHz mono wav.
"""
import numpy as np
import soundfile as sf

SR = 48000
WORDS = [("alpha", 0.5, 0.9), ("bravo", 1.0, 1.5), ("charlie", 2.4, 2.9), ("delta", 3.0, 3.4), ("echo", 4.4, 4.9)]


def speech(seconds=5.6, noise_db=-80.0, hum_db=None, hum_hz=60, clip=False, seed=7):
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    x = np.zeros_like(t)
    for _, start, end in WORDS:
        m = (t >= start) & (t < end)
        voice = sum(np.sin(2 * np.pi * 130 * k * t) / k for k in range(1, 9)) * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) ** 0.5
        x[m] = voice[m]
    x *= 0.22 / np.sqrt((x[x != 0] ** 2).mean())
    x += rng.standard_normal(len(t)) * 10 ** (noise_db / 20)
    if hum_db is not None:
        x += 10 ** (hum_db / 20) * np.sin(2 * np.pi * hum_hz * t)
    if clip:
        x = np.clip(x * 6, -1.0, 1.0)
    return x.astype(np.float32), [{"text": w, "start": a, "end": b} for w, a, b in WORDS]


def write(path, **kwargs):
    x, words = speech(**kwargs)
    sf.write(path, x, SR, subtype="PCM_24")
    return words

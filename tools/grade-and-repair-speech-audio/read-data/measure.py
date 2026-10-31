"""Measure one audio span: loudness, noise floor and SNR, clipping, hum, wind rumble, room tail.

Word times (when given) split the span into speech frames and gap frames; the noise floor is read from the gaps, so
a loud talker is not mistaken for a noisy room. With no usable gaps the quietest 10% of frames stand in.
"""
import json
import re
import subprocess

import numpy as np
import soundfile as sf
from scipy.signal import welch

FRAME = 0.02
HOP = 0.01
HUM_HZ = (50, 60, 100, 120, 150, 180, 240)


def read_mono(path):
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    return x.mean(axis=1), sr, x.shape[1]


def loudness(path):
    p = subprocess.run(
        ["ffmpeg", "-nostats", "-i", path, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"\{[^{}]*input_i[^{}]*\}", p.stderr, re.S)
    j = json.loads(m.group(0))
    return {"lufs": float(j["input_i"]), "true_peak_db": float(j["input_tp"]), "lra": float(j["input_lra"])}


def db(p):
    return 10 * np.log10(np.maximum(p, 1e-12))


def frame_power(x, sr):
    n, h = int(FRAME * sr), int(HOP * sr)
    k = max(0, (len(x) - n) // h + 1)
    idx = np.arange(n)[None, :] + h * np.arange(k)[:, None]
    f = x[idx]
    return (f ** 2).mean(axis=1), np.arange(k) * HOP + FRAME / 2


def band_db(x, sr, lo, hi):
    f, p = welch(x, sr, nperseg=min(len(x), 8192))
    m = (f >= lo) & (f < hi)
    return db(p[m].sum() * (f[1] - f[0]))


def hum_prominence(x, sr):
    f, p = welch(x, sr, nperseg=min(len(x), 1 << 16))
    best = (0.0, 0)
    for h in HUM_HZ:
        peak = p[(f >= h - 1.2) & (f <= h + 1.2)]
        side = p[((f >= h - 20) & (f < h - 5)) | ((f > h + 5) & (f <= h + 20))]
        if len(peak) and len(side):
            prom = float(db(peak.max()) - db(np.median(side)))
            if prom > best[0]:
                best = (prom, h)
    return best


def measure(path, words=()):
    x, sr, ch = read_mono(path)
    dur = len(x) / sr
    fp, ft = frame_power(x, sr)
    speech = np.zeros(len(ft), bool)
    for w in words:
        speech |= (ft >= w["start"] - 0.03) & (ft <= w["end"] + 0.03)
    gap = ~speech
    if gap.sum() * HOP >= 0.3:
        # word times smear over pauses, so take the quietest fifth of the gap frames, not their mean
        noise_method = "word-gaps"
        quiet = gap & (fp <= np.percentile(fp[gap], 20))
    else:
        noise_method = "quietest-10%"
        quiet = fp <= np.percentile(fp, 10)
    noise_p = float(fp[quiet].mean())
    sp = speech if speech.sum() * HOP >= 0.5 else fp >= np.percentile(fp, 60)
    speech_p = float(fp[sp].mean())
    noise_db = float(db(noise_p))
    snr = float(db(speech_p) - noise_db)

    clip_frac = float((np.abs(x) >= 0.995).mean())

    qmask = np.zeros(len(x), bool)
    h = int(HOP * sr)
    n = int(FRAME * sr)
    for i in np.where(quiet)[0]:
        qmask[i * h : i * h + n] = True
    xq = x[qmask] if qmask.sum() > sr * 0.2 else x
    hum_db, hum_hz = hum_prominence(xq, sr)
    lf_db = band_db(xq, sr, 20, 120)
    total_db = band_db(xq, sr, 20, sr / 2 - 1)
    lf_share = float(10 ** ((lf_db - total_db) / 10))

    # room tail: level 80-250 ms after a word that ends before a pause, against that word's last 100 ms
    tails = []
    ws = list(words)
    for i, w in enumerate(ws):
        nxt = ws[i + 1]["start"] if i + 1 < len(ws) else dur
        if nxt - w["end"] < 0.3 or w["end"] < 0.1 or w["end"] + 0.25 > dur:
            continue
        a = x[int((w["end"] - 0.1) * sr) : int(w["end"] * sr)]
        b = x[int((w["end"] + 0.08) * sr) : int((w["end"] + 0.25) * sr)]
        if len(a) and len(b):
            sig = max(float((a ** 2).mean()) - noise_p, 1e-12)
            tail = max(float((b ** 2).mean()) - noise_p, sig * 1e-4)
            tails.append(db(tail) - db(sig))
    tail_db = float(np.median(tails)) if len(tails) >= 2 else None

    return {
        "duration": round(dur, 3), "channels": ch, "sample_rate": sr,
        **loudness(path),
        "noise_floor_dbfs": round(noise_db, 1), "noise_method": noise_method, "snr_db": round(snr, 1),
        "clip_fraction": round(clip_frac, 6),
        "hum_prominence_db": round(hum_db, 1), "hum_hz": hum_hz,
        "lf_rumble_dbfs": round(float(lf_db), 1), "lf_noise_share": round(lf_share, 2),
        "room_tail_db": None if tail_db is None else round(tail_db, 1), "tail_samples": len(tails),
    }

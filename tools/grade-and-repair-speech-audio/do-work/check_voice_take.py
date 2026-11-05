#!/usr/bin/env python3
"""Find TTS artifacts word by word: breathy, noise-like vowels (low periodicity), pitch breaks (octave jumps / warble),
clicks (sample-level discontinuities) and stretched words (duration per letter far above the take's median).
Usage: voice_qc.py <voice.wav> <words.json> [offset_s]   (offset = where word 0 s sits in the wav)"""
import json, sys
import numpy as np, librosa

wav, wj = sys.argv[1], sys.argv[2]
off = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
y, sr = librosa.load(wav, sr=24000, mono=True)
w = json.load(open(wj)); w = w.get('words', w) if isinstance(w, dict) else w
hop = 120  # 5 ms
f0, vflag, vprob = librosa.pyin(y, fmin=50, fmax=300, sr=sr, frame_length=1024, hop_length=hop)
t = np.arange(len(f0)) * hop / sr
semi = 12 * np.log2(np.where(np.isnan(f0), np.nan, f0) / 55.0)
# clicks: second difference of the waveform against local RMS
d2 = np.abs(np.diff(y, 2))
win = 240
rms = np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same'))[1:-1] + 1e-4
click = d2 / rms
def periodicity(seg):
    """median normalised autocorrelation peak (55-250 Hz lags) over 40 ms frames: low = breathy, noise-like voicing"""
    n, hop, vals = int(0.04 * sr), int(0.01 * sr), []
    for i in range(0, len(seg) - n, hop):
        f = seg[i:i + n] * np.hanning(n)
        if np.sqrt((f ** 2).mean()) < 10 ** (-45 / 20): continue
        ac = np.correlate(f, f, 'full')[n - 1:]; ac /= ac[0] + 1e-12
        vals.append(ac[int(sr / 250):int(sr / 55)].max())
    return float(np.median(vals)) if vals else np.nan


letters = [max(1, sum(ch.isalpha() for ch in x['text'])) for x in w]
dur = [x['end'] - x['start'] for x in w]
rate = np.array(dur) / np.array(letters)
med = np.median(rate)
rows = []
for x, L, r in zip(w, letters, rate):
    a, b = x['start'] + off, x['end'] + off
    m = (t >= a) & (t < b)
    s = semi[m]; s = s[~np.isnan(s)]
    jumps = np.abs(np.diff(s)) if len(s) > 2 else np.array([0.0])
    big = int((jumps > 3.0).sum())  # >3 semitones in 5 ms is not human speech
    ia, ib = int(a * sr), int(b * sr)
    cmax = float(click[ia:ib].max()) if ib > ia else 0.0
    per = periodicity(y[int(a * sr):int(b * sr)])
    flags = []
    if big: flags.append(f'pitch-break x{big} (max {jumps.max():.1f} st/5ms)')
    if cmax > 6: flags.append(f'click {cmax:.1f}')
    if r > 2.6 * med and L > 1: flags.append(f'stretched {r / med:.1f}x')
    rows.append({'word': x['text'], 'start': round(a, 3), 'end': round(b, 3), 'f0_iqr': round(float(np.subtract(*np.percentile(s, [75, 25]))) if len(s) > 4 else 0, 2),
                 'max_jump_st': round(float(jumps.max()), 2), 'periodicity': None if np.isnan(per) else round(float(per), 3), 'click': round(cmax, 2), 'sec_per_letter_x_median': round(float(r / med), 2), 'flags': flags})
json.dump(rows, open(wav.rsplit('.', 1)[0] + '.qc.json', 'w'), indent=1)
for r in rows:
    if r['flags']:
        print(f"{r['start']:7.2f}-{r['end']:6.2f}  {r['word']:<16} {'; '.join(r['flags'])}")
pers = [(r['periodicity'], r['word'], r['start']) for r in rows if r['periodicity'] is not None and len(r['word']) > 3]
print('least periodic (breathy) words:', sorted(pers)[:5])
print('worst jumps:', sorted(((r['max_jump_st'], r['word'], r['start']) for r in rows), reverse=True)[:5])
print('worst clicks:', sorted(((r['click'], r['word'], r['start']) for r in rows), reverse=True)[:5])

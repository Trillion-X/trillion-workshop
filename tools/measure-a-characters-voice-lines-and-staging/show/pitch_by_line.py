usage: python3 -I show/pitch_by_line.py <media> <json3> <start_s> <end_s>"""
import sys, os, subprocess, numpy as np, librosa
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lines import events
media, cap, a, b = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
sr = 16000
raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(a), '-t', str(b - a), '-i', media, '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'],
                     capture_output=True).stdout
y = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
f0, vflag, _ = librosa.pyin(y, fmin=70, fmax=600, sr=sr, frame_length=1024, hop_length=320)
times = a + np.arange(len(f0)) * 320 / sr
ev = [e for e in events(cap) if a <= e[0] < b]
for i, (t, d, x) in enumerate(ev):
    end = ev[i + 1][0] if i + 1 < len(ev) else t + d
    m = (times >= t) & (times < end) & vflag
    med = np.nanmedian(f0[m]) if m.sum() > 5 else float('nan')
    print(f'{t:7.1f} {med:6.0f}Hz {int(m.sum()):4d}  {x[:70]}')

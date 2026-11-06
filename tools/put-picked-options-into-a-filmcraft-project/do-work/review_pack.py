#!/usr/bin/env python3
"""The input of a fresh-viewer review (the fresh-viewer prompt of the Workshop's tools/check-a-rendered-video review-pack) for one working preview: work-round-8/review-pack/<id>/ with contact sheets
(one frame a second, 12 tiles a sheet), transcript.txt (whisper large-v3-turbo, a line per sentence with mm:ss) and rules.txt (kept from the pack that is there).
Usage: make_review_pack.py <id>   (run with python3)"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OPT = os.path.dirname(HERE)
WR = os.path.join(OPT, 'work-round-8')
oid = sys.argv[1]
video = os.path.join(WR, 'working', oid + '.mp4')
pack = os.path.join(WR, 'review-pack', oid)
os.makedirs(pack, exist_ok=True)
dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], capture_output=True, text=True).stdout)
for f in os.listdir(pack):
    if f.startswith('sheet-'):
        os.remove(os.path.join(pack, f))
times = [str(t) for t in range(int(dur) + 1)]
for k in range(0, len(times), 12):
    subprocess.run([sys.executable, os.path.join(HERE, 'contact_sheet.py'), os.path.join(pack, 'sheet-%02d.jpg' % (k // 12 + 1)), video] + times[k:k + 12] + ['--width', '640'], check=True)
tmp = tempfile.mkdtemp(prefix='rp-', dir=os.path.join(WR, 'working'))
wav = os.path.join(tmp, 'a.wav')
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wav], check=True)
subprocess.run([sys.executable, os.path.join(HERE, 'whisper_words.py'), wav, os.path.join(tmp, 'w.json')], check=True, capture_output=True)
words = json.load(open(os.path.join(tmp, 'w.json')))['words']
lines, cur, t0 = [], [], None
for w in words:
    if t0 is None:
        t0 = w['start']
    cur.append(w['text'])
    if w['text'].endswith(('.', '?', '!')):
        lines.append('%02d:%02d %s' % (int(t0) // 60, int(t0) % 60, ' '.join(cur)))
        cur, t0 = [], None
if cur:
    lines.append('%02d:%02d %s' % (int(t0) // 60, int(t0) % 60, ' '.join(cur)))
open(os.path.join(pack, 'transcript.txt'), 'w').write('\n'.join(lines) + '\n')
print(pack, len(times), 'tiles;', len(lines), 'lines;', tmp)

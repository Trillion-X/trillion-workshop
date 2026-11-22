#!/usr/bin/env python3
"""check_text_in_every_frame.py <clip> --phrases JSON [--every-s 2.0]: whether every sampled frame shows every required phrase.

    python3 -I tools/check-text-in-every-frame/do-work/check_text_in_every_frame.py clip.mp4 --phrases '["Name One", "Name Two"]'

ffmpeg takes one frame every --every-s seconds (the first frame at 0 s); tesseract reads each frame's text. A phrase counts
when it appears in the frame's text after case and whitespace are folded. Pass only when every frame has every phrase; the
result lists the frames that miss a phrase, so a person can see where it drops out. No model judges the picture: the same
frames give the same answer. The last line is {"result": {"pass", "frames", "missing": [{"at_s", "missing"}], "phrases"}}
or {"error": "what to change"}.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile


class Refusal(Exception):
    pass


def fold(text):
    return re.sub(r"\s+", " ", text).strip().lower()


def frame_times(duration, every_s):
    t, out = 0.0, []
    while t < duration:
        out.append(round(t, 2))
        t += every_s
    return out


def duration_of(clip):
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', clip],
                             check=True, capture_output=True, text=True).stdout
    except FileNotFoundError:
        raise Refusal('ffprobe is missing: install ffmpeg')
    except subprocess.CalledProcessError as e:
        raise Refusal(f'ffprobe could not read {clip}: {e.stderr.strip()[:200]}')
    return float(json.loads(out)['format']['duration'])


def read_frame(png):
    try:
        out = subprocess.run(['tesseract', png, '-', '--psm', '11'], check=True, capture_output=True, text=True).stdout
    except FileNotFoundError:
        raise Refusal('tesseract is missing: brew install tesseract')
    except subprocess.CalledProcessError as e:
        raise Refusal(f'tesseract could not read {png}: {e.stderr.strip()[:200]}')
    return fold(out)


def check(clip, phrases, every_s=2.0):
    if not os.path.isfile(clip):
        raise Refusal(f'{clip} is not there: pass the local clip file')
    if not phrases or not all(isinstance(p, str) and p.strip() for p in phrases):
        raise Refusal('--phrases must be a JSON list of non-empty strings: the names and the credit text, year included')
    wanted = [fold(p) for p in phrases]
    times = frame_times(duration_of(clip), every_s)
    missing, folder = [], tempfile.mkdtemp()
    try:
        for t in times:
            png = os.path.join(folder, f'f{int(t * 100):08d}.png')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', clip, '-frames:v', '1', png], check=True)
            text = read_frame(png)
            gone = [p for p, w in zip(phrases, wanted) if w not in text]
            if gone:
                missing.append({'at_s': t, 'missing': gone})
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return {'pass': not missing, 'frames': len(times), 'missing': missing, 'phrases': phrases}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('clip')
    ap.add_argument('--phrases', required=True)
    ap.add_argument('--every-s', type=float, default=2.0)
    a = ap.parse_args(argv)
    try:
        phrases = json.loads(a.phrases)
        print(json.dumps({'result': check(a.clip, phrases, a.every_s)}))
        return 0
    except (Refusal, ValueError, OSError) as e:
        print(json.dumps({'error': str(e)}))
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

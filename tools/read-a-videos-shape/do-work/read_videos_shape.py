#!/usr/bin/env python3
"""read_videos_shape.py <video file>: a video's width, height, frame rate and duration, one JSON line.

    python3 -I tools/read-a-videos-shape/do-work/read_videos_shape.py clip.mp4

Reads the container and the first video stream with ffprobe (no decode). The last line is {"result": {"width", "height",
"fps", "duration_s"}} or {"error": "what to change"}. A file with no video stream, or a frame rate that is not a number, is
an error: the caller then records the check as not measured.
"""
import json
import os
import subprocess
import sys


class Refusal(Exception):
    pass


def probe(path):
    if not os.path.isfile(path):
        raise Refusal(f'{path} is not there: pass the local file a span read wrote')
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', path],
            check=True, capture_output=True, text=True).stdout
    except FileNotFoundError:
        raise Refusal('ffprobe is missing: install ffmpeg (brew install ffmpeg)')
    except subprocess.CalledProcessError as e:
        raise Refusal(f'ffprobe could not read {path}: {e.stderr.strip()[:200]}')
    data = json.loads(out)
    streams = data.get('streams') or []
    if not streams:
        raise Refusal(f'{path} has no video stream')
    s = streams[0]
    num, _, den = (s.get('avg_frame_rate') or '0/0').partition('/')
    if not den or float(den or 0) == 0 or float(num or 0) == 0:
        raise Refusal(f'{path} has no usable frame rate: {s.get("avg_frame_rate")!r}')
    return {'width': int(s['width']), 'height': int(s['height']), 'fps': round(float(num) / float(den), 3),
            'duration_s': round(float(data['format']['duration']), 3)}


def main(argv):
    if len(argv) != 1:
        print(json.dumps({'error': 'usage: read_videos_shape.py <video file>'}))
        return 2
    try:
        print(json.dumps({'result': probe(argv[0])}))
        return 0
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Stand-in ffmpeg and ffprobe for the tests and the parity runs (which one: the name it is called by, or argv[1]).

ffmpeg: a loudnorm measuring pass (print_format=json) prints a fixed loudnorm answer on standard error; any other call
writes its output file (the last argument) as a copy of its first input's JSON with the duration its -t asks, or a small
JSON when the input is not JSON. ffprobe: answers -show_entries stream=... and format=duration from that JSON (the
stand-in filmcraft-cli's export writes one). When FILMCRAFT_STAND_IN_LOG names a file, every call appends
{"prog": "ffmpeg"|"ffprobe", "argv": [...]} to it. Made up; never the real programs."""
import json
import os
import sys

LOUDNORM = {'input_i': '-21.40', 'input_tp': '-4.10', 'input_lra': '6.20', 'input_thresh': '-31.90', 'output_i': '-15.00',
            'output_tp': '-1.50', 'output_lra': '5.80', 'output_thresh': '-25.40', 'normalization_type': 'dynamic', 'target_offset': '0.10'}


def read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def ffmpeg(args):
    if '-af' in args and 'print_format=json' in args[args.index('-af') + 1]:
        sys.stderr.write('[Parsed_loudnorm_0 @ 0x0]\n' + json.dumps(LOUDNORM, indent=1) + '\n')
        return
    inputs = [args[i + 1] for i, a in enumerate(args) if a == '-i']
    out = args[-1]
    if out == '-':
        return
    held = read_json(inputs[0]) if inputs else None
    body = dict(held) if isinstance(held, dict) else {'duration': 10.0, 'width': 1920, 'height': 1080, 'audio': 1}
    if '-t' in args:
        body['duration'] = float(args[args.index('-t') + 1])
    if '-frames:v' in args:
        body = {'still_of': inputs[0] if inputs else None}
    body['made_by'] = 'stand-in ffmpeg'
    with open(out, 'w') as fh:
        json.dump(body, fh)


def ffprobe(args):
    held = read_json(args[-1])
    if held is None:
        sys.stderr.write(f'{args[-1]}: Invalid data found when processing input\n')
        raise SystemExit(1)
    entries = args[args.index('-show_entries') + 1] if '-show_entries' in args else ''
    if entries.startswith('format'):
        print(f'{float(held.get("duration", 0)):.6f}')
        return
    streams = [{'codec_type': 'video', 'width': held.get('width', 1920), 'height': held.get('height', 1080), 'duration': f'{float(held.get("duration", 0)):.6f}'}]
    streams += [{'codec_type': 'audio', 'duration': f'{float(held.get("duration", 0)) + 0.02:.6f}'}] * int(held.get('audio', 1))
    print(json.dumps({'streams': streams}))


def main():
    name = os.path.basename(sys.argv[0])
    args = sys.argv[1:]
    if name not in ('ffmpeg', 'ffprobe'):
        name, args = args[0], args[1:]
    log = os.environ.get('FILMCRAFT_STAND_IN_LOG')
    if log:
        with open(log, 'a') as fh:
            fh.write(json.dumps({'prog': name, 'argv': args}) + '\n')
    (ffmpeg if name == 'ffmpeg' else ffprobe)(args)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Word-time a recording or one window with the audio-transcription provider.

Legacy command: python3 -I wordtime.py <source media> <out.json> [<from> [<to]]
Request form: send one JSON object to stdin with source, out, and optional from, to and model fields.

The output keeps {source, timing: "word", words: [{text, start, end}]}, with bounds in source seconds.

Each window is decoded without the previous window's text as its prompt: given it, Whisper can repeat one phrase until the
recording ends ("I'll say I'll say ...") and pile those words on the last second, which no later reader can tell from speech.
A request may still ask for it with "condition_on_previous_text": true.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import whisper_here

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


def parse_cli(argv: list[str]) -> dict[str, str]:
    parser = argparse.ArgumentParser(description="Word-time a recording with the audio-transcription Whisper provider.")
    parser.add_argument("source", help="source audio or video")
    parser.add_argument("out", help="word-time JSON output path")
    parser.add_argument("from_time", nargs="?", help="window start in source seconds")
    parser.add_argument("to_time", nargs="?", help="window end in source seconds")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="public Whisper model id")
    args = parser.parse_args(argv)
    request = {"source": args.source, "out": args.out, "model": args.model}
    if args.from_time is not None:
        request["from"] = args.from_time
    if args.to_time is not None:
        request["to"] = args.to_time
    return request


def run(request: dict[str, object], print_count: bool = False) -> dict[str, object]:
    for key in ("source", "out"):
        if not isinstance(request.get(key), str) or not request[key]:
            raise ValueError(f'the request needs a non-empty "{key}" field')
    source, out = request['source'], request['out']
    start = float(request.get('from', 0.0))
    end = request.get('to')
    model = request.get('model', DEFAULT_MODEL)
    if not isinstance(model, str) or not model.strip():
        raise ValueError('the "model" field must be a non-empty public model id')
    condition = request.get('condition_on_previous_text', False)
    if not isinstance(condition, bool):
        raise ValueError('the "condition_on_previous_text" field must be true or false')
    window = ['-ss', f'{start:.2f}', '-to', f'{float(end):.2f}'] if end is not None else []
    with tempfile.TemporaryDirectory() as tmp:
        wav = f'{tmp}/a.wav'
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', *window, '-i', source,
                        '-vn', '-ac', '1', '-ar', '16000', wav], check=True)
        result = whisper_here.transcribe(wav, path_or_hf_repo=model, language='en', word_timestamps=True,
                                         condition_on_previous_text=condition)
    words = [{'text': w['word'].strip(), 'start': round(w['start'] + start, 2), 'end': round(w['end'] + start, 2)}
             for s in result['segments'] for w in s.get('words', [])]
    pathlib.Path(out).write_text(json.dumps({'source': source, 'timing': 'word', 'words': words}))
    if print_count:
        print(f'{len(words)} words -> {out}')
    return {'out': out, 'words': len(words)}


def from_stdin() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError("the request must be one JSON object")
        result = run(request)
    except (ValueError, KeyError, OSError, RuntimeError, subprocess.CalledProcessError, TypeError) as error:
        print(json.dumps({"error": str(error)}))
        return 2
    except SystemExit as error:
        print(json.dumps({"error": str(error)}))
        return 2
    print(json.dumps({"result": result}))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args:
        return from_stdin()
    run(parse_cli(args), print_count=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# tools/audio-transcription/do-work/transcribe_mlx.py
#
# The MLX Whisper seam for tool:transcribe-file: one recording in, one JSON file out with every word's own seconds.
#
#   transcribe_mlx.py transcribe --audio FILE --out FILE.json --model-path REPO
#
# REPO is a Hugging Face model repo (for example mlx-community/whisper-small-mlx), read from the local cache. The
# engine is whisper_here.py's (mlx_whisper on Apple silicon); this file only shapes its answer for read-data/transcribe-a-file.mjs.
# Writes { full_text, language, engine, segments: [{ start, end, text, words: [{ word, start, end }] }] } and prints
# { "result": {...} } as its last line. A recording it cannot hear stops with the engine's own message on stderr.
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import whisper_here  # noqa: E402


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float("inf")


def shape(heard):
    segments = []
    for segment in heard.get("segments", []):
        if not (finite(segment.get("start")) and finite(segment.get("end"))):
            continue
        words = [{"word": str(w.get("word", "")).strip(), "start": w["start"], "end": w["end"]}
                 for w in segment.get("words", []) if finite(w.get("start")) and finite(w.get("end"))]
        segments.append({"start": segment["start"], "end": segment["end"], "text": str(segment.get("text", "")).strip(), "words": words})
    return {"full_text": str(heard.get("text", "")).strip(), "language": heard.get("language"), "engine": heard.get("engine"), "segments": segments}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="transcribe_mlx.py")
    commands = parser.add_subparsers(dest="command", required=True)
    t = commands.add_parser("transcribe")
    t.add_argument("--audio", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--model-path", required=True)
    args = parser.parse_args(argv)
    answer = shape(whisper_here.transcribe(args.audio, path_or_hf_repo=args.model_path, word_timestamps=True))
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(answer, handle, ensure_ascii=False)
    print(json.dumps({"result": {"engine": answer["engine"], "segments": len(answer["segments"])}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

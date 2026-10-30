#!/usr/bin/env python3
"""The Workshop seam of audio-transcription: transcribe a recording with the package's own script, find where Whisper looped, and
hear again only those windows.

  audio_transcription.py transcribe  --audio FILE --out FILE.json --model-path FILE [--whisper-cli PATH] [--ffmpeg PATH]
  audio_transcription.py find-loops  --transcript FILE.json [FILE.json ...]
  audio_transcription.py repair      --transcript FILE.json --audio FILE --model-path FILE [--out FILE.json] [--whisper-cli PATH] [--ffmpeg PATH]

transcribe runs do-work/process-scripts/transcribe-audio.py, copied unchanged from the package, and keeps its result (segments, words
with their timing_source, full_text, language) with the length of the recording added. repair hears each loop window again with
whisper.cpp's context off (-mc 0) and splices what it hears into the transcript. Every command prints its account, then one last
line {"result": {...}}. Needs whisper-cli (whisper.cpp), ffmpeg, ffprobe and a ggml model file on this computer.
"""
import argparse
import json
import os
import runpy
import subprocess
import sys
import tempfile
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "read-data"))
import whisper_loops as loops  # noqa: E402

PACKAGE_SCRIPT = os.path.join(HERE, "process-scripts", "transcribe-audio.py")


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, document):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))


def environment(args):
    """The environment the package's script reads: where whisper-cli, ffmpeg and the model are."""
    env = dict(os.environ, BITFIELD_WHISPER_MODEL_PATH=args.model_path)
    if args.whisper_cli:
        env["BITFIELD_WHISPER_CLI_PATH"] = args.whisper_cli
    if args.ffmpeg:
        env["BITFIELD_FFMPEG_PATH"] = args.ffmpeg
    return env


def probe_duration(path):
    answer = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                            capture_output=True, text=True, check=True)
    return float(answer.stdout.strip())


def command_transcribe(args):
    request_id = args.request_id or uuid.uuid4().hex
    # The package's script writes its decoded copy next to the audio it is given and names its output after the path it is given,
    # so it is handed a link and an output inside a folder of its own and nothing is left beside the person's recording.
    with tempfile.TemporaryDirectory() as work:
        linked = os.path.join(work, "recording" + os.path.splitext(args.audio)[1])
        os.symlink(os.path.abspath(args.audio), linked)
        made = os.path.join(work, "result.json")
        subprocess.run([sys.executable, PACKAGE_SCRIPT, linked, request_id, made], env=environment(args), check=True)
        result = read_json(made)
    if "records" in result:  # the package's honest error record
        payload = result["records"][0]["payload"]
        print(payload["code"] + ": " + payload["message"], file=sys.stderr)
        args.exit_code = 2
        return {"failed": {"code": payload["code"], "message": payload["message"]}}
    result["duration"] = probe_duration(args.audio)
    write_json(args.out, result)
    print(len(result["segments"]), "segments,", len(result["words"]), "words,", round(result["duration"]), "s")
    return {"transcript": args.out, "segments": len(result["segments"]), "words": len(result["words"]), "duration": result["duration"], "language": result["language"]}


def command_find_loops(args):
    clips, total = [], 0.0
    for path in args.transcript:
        doc = read_json(path)
        spans = loops.loop_spans(doc)
        if spans:
            seconds = sum(end - start for start, end in spans)
            total += seconds
            clips.append({"transcript": path, "segments": len(spans), "seconds": round(seconds)})
            print(os.path.basename(path), len(spans), "segments", round(seconds), "s")
    print("total looped seconds", round(total))
    return {"transcripts_with_loops": clips, "total_looped_seconds": round(total)}


def hear_again(args, package, w0, w1):
    """Segments and words of one window of the recording, heard with no earlier text carried in, in the recording's own seconds."""
    with tempfile.TemporaryDirectory() as work:
        wav = os.path.join(work, "window.wav")
        ffmpeg = package["find_executable"]("BITFIELD_FFMPEG_PATH", package["FFMPEG_CANDIDATES"])[0]
        whisper = package["find_executable"]("BITFIELD_WHISPER_CLI_PATH", package["WHISPER_CLI_CANDIDATES"])[0]
        if not (ffmpeg and whisper):
            sys.exit("ffmpeg and whisper-cli are both needed and one was not found; give --ffmpeg and --whisper-cli.")
        subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-y", "-v", "error",
                        "-ss", str(w0), "-t", str(w1 - w0), "-i", args.audio, "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
        base = os.path.join(work, "window")
        subprocess.run([whisper, "-m", args.model_path, "-f", wav, "-oj", "-ojf", "-of", base, "-np", "-mc", "0"], check=True, capture_output=True, text=True)
        heard = package["normalize_whisper_json"](read_json(base + ".json"), "window")
    return loops.shifted(heard, w0)


def command_repair(args):
    os.environ.update(environment(args))
    package = runpy.run_path(PACKAGE_SCRIPT)
    doc = read_json(args.transcript)
    if "repaired_windows" in doc:
        print("already repaired")
        return {"transcript": args.transcript, "repaired_windows": doc["repaired_windows"], "skipped": True}
    windows = loops.regions(doc, doc.get("duration") or probe_duration(args.audio))
    if not windows:
        print("clean")
        return {"transcript": args.transcript, "repaired_windows": [], "clean": True}
    redone = [hear_again(args, package, w0, w1) for w0, w1 in windows]
    loops.splice(doc, windows, redone)
    out = args.out or args.transcript
    write_json(out, doc)
    print(f"repaired {len(windows)} windows, removed {len(doc['removed_hallucinated'])}")
    return {"transcript": out, "repaired_windows": doc["repaired_windows"], "removed": len(doc["removed_hallucinated"])}


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def engine(p):
        p.add_argument("--model-path", required=True, help="the ggml Whisper model file")
        p.add_argument("--whisper-cli", help="the whisper-cli command (default: the one on PATH)")
        p.add_argument("--ffmpeg", help="the ffmpeg command (default: the one on PATH)")

    t = sub.add_parser("transcribe", help="a transcript with a time for every word")
    t.add_argument("--audio", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--request-id")
    engine(t)
    t.set_defaults(run=command_transcribe)
    f = sub.add_parser("find-loops", help="which transcripts hold repetition loops, and how many seconds they cover")
    f.add_argument("--transcript", nargs="+", required=True)
    f.set_defaults(run=command_find_loops)
    r = sub.add_parser("repair", help="hear again only the looped windows and splice them in")
    r.add_argument("--transcript", required=True)
    r.add_argument("--audio", required=True)
    r.add_argument("--out")
    engine(r)
    r.set_defaults(run=command_repair)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.exit_code = 0
    result = args.run(args)
    print(json.dumps({"result": result}, ensure_ascii=False))
    return args.exit_code


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""The Workshop seam of audio-transcription: transcribe a recording with the package's own script, find where Whisper looped, and
hear again only those windows.

  audio_transcription.py transcribe      --audio FILE --out FILE.json --model-path FILE [--whisper-cli PATH] [--ffmpeg PATH]
  audio_transcription.py transcribe-many --recordings DIR --out-dir DIR --model-path FILE [--pattern GLOB] [--workers N] [--max-load L]
  audio_transcription.py find-loops      --transcript FILE.json [FILE.json ...]
  audio_transcription.py repair          --transcript FILE.json --audio FILE --model-path FILE [--out FILE.json] [--whisper-cli PATH] [--ffmpeg PATH]
  audio_transcription.py repair-many     --transcript FILE.json [FILE.json ...] --model-path FILE [--workers N] [--max-load L]
  audio_transcription.py judge           --transcript FILE.json [FILE.json ...] [--duration S | --durations LIST.tsv]
  audio_transcription.py index           --transcripts DIR [--out index.tsv]
  audio_transcription.py text            --transcript FILE.json --out FILE.txt [--title T] [--header LINE ...] [--duration S]
                                         [--paragraph-seconds S] [--even-if-rejected]

transcribe runs do-work/process-scripts/transcribe-audio.py, copied unchanged from the package, and keeps its result (segments, words
with their timing_source, full_text, language) with the length of the recording added. repair hears each loop window again with
whisper.cpp's context off (-mc 0) and splices what it hears into the transcript. transcribe-many does a folder of
recordings (one <name>.json each, ones already done are skipped) and records each recording's path and when it was made (a
camera's sidecar XML, else the file's time); repair-many repairs many transcripts, each from the recording it names. judge says
whether a whole answer looks looped or invented, index writes one line per transcript with the totals, and text writes a
transcript as [m:ss] paragraphs, refusing one judge rejects. Every command prints its account, then one last
line {"result": {...}}. Needs whisper-cli (whisper.cpp), ffmpeg, ffprobe and a ggml model file on this computer.
"""
import argparse
import glob
import json
import os
import re
import runpy
import subprocess
import sys
import tempfile
import time
import uuid
from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "read-data"))
import transcript_reports as reports  # noqa: E402
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


def probe_duration(path, ffmpeg=None):
    """The recording's length in seconds: ffprobe's, else read from the ffmpeg the person gave (a computer run is granted
    ffmpeg and whisper-cli only, so ffprobe may not start there)."""
    try:
        answer = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                capture_output=True, text=True, check=True)
        return float(answer.stdout.strip())
    except (OSError, subprocess.CalledProcessError, ValueError):
        if not ffmpeg:
            raise
    said = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", path], capture_output=True, text=True).stderr
    found = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", said)
    if not found:
        raise RuntimeError(f"ffmpeg did not say how long {path} is")
    hours, minutes, seconds = found.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


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
    result["duration"] = probe_duration(args.audio, args.ffmpeg)
    result["source"] = os.path.abspath(args.audio)
    result["recorded_at"], result["recorded_at_from"] = reports.recorded_at(args.audio)
    write_json(args.out, result)
    print(len(result["segments"]), "segments,", len(result["words"]), "words,", round(result["duration"]), "s")
    return {"transcript": args.out, "segments": len(result["segments"]), "words": len(result["words"]), "duration": result["duration"], "language": result["language"]}


def wait_for_load(max_load):
    """Hold back while this computer is busier than max_load (the 1-minute load average); never when max_load is not given."""
    while max_load and os.getloadavg()[0] > max_load:
        time.sleep(30)


def command_transcribe_many(args):
    recordings = sorted(p for p in glob.glob(os.path.join(args.recordings, args.pattern)) if os.path.isfile(p))
    os.makedirs(args.out_dir, exist_ok=True)

    def one(path):
        name = os.path.splitext(os.path.basename(path))[0]
        out = os.path.join(args.out_dir, name + ".json")
        if os.path.exists(out):
            return {"recording": path, "transcript": out, "status": "skip"}
        wait_for_load(args.max_load)
        each = Namespace(**{**vars(args), "audio": path, "out": out, "request_id": None, "exit_code": 0})
        try:
            done = command_transcribe(each)
        except Exception as error:  # one bad recording does not stop the others
            return {"recording": path, "status": f"failed: {error}"}
        if each.exit_code:
            return {"recording": path, "status": "failed: " + done["failed"]["code"]}
        return {"recording": path, "transcript": out, "status": "ok", "words": done["words"]}

    with ThreadPoolExecutor(args.workers) as pool:
        results = list(pool.map(one, recordings))
    for r in results:
        print(os.path.basename(r["recording"]), r["status"], flush=True)
    if any(r["status"].startswith("failed") for r in results):
        args.exit_code = 2
    return {"recordings": results, "ok": sum(r["status"] == "ok" for r in results),
            "skipped": sum(r["status"] == "skip" for r in results), "failed": sum(r["status"].startswith("failed") for r in results)}


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
    windows = loops.regions(doc, doc.get("duration") or probe_duration(args.audio, args.ffmpeg))
    if not windows:
        print("clean")
        return {"transcript": args.transcript, "repaired_windows": [], "clean": True}
    redone = [hear_again(args, package, w0, w1) for w0, w1 in windows]
    loops.splice(doc, windows, redone)
    out = args.out or args.transcript
    write_json(out, doc)
    print(f"repaired {len(windows)} windows, removed {len(doc['removed_hallucinated'])}")
    return {"transcript": out, "repaired_windows": doc["repaired_windows"], "removed": len(doc["removed_hallucinated"])}


def command_repair_many(args):
    def one(path):
        doc = read_json(path)
        if not doc.get("source"):
            return {"transcript": path, "status": "failed: names no source recording (made before transcribe recorded it)"}
        if "repaired_windows" not in doc and loops.loop_spans(doc):
            wait_for_load(args.max_load)
        each = Namespace(**{**vars(args), "transcript": path, "audio": doc["source"], "out": None})
        try:
            done = command_repair(each)
        except Exception as error:
            return {"transcript": path, "status": f"failed: {error}"}
        status = "skip" if done.get("skipped") else "clean" if done.get("clean") else f"repaired {len(done['repaired_windows'])} windows, removed {done['removed']}"
        return {"transcript": path, "status": status}

    with ThreadPoolExecutor(args.workers) as pool:
        results = list(pool.map(one, args.transcript))
    if any(r["status"].startswith("failed") for r in results):
        args.exit_code = 2
    return {"transcripts": results}


def command_judge(args):
    verdicts = []
    lengths = reports.durations_list(args.durations, args.id_column, args.duration_column) if args.durations else {}
    for path in args.transcript:
        why = reports.judge(read_json(path), lengths.get(os.path.basename(path).split(".")[0], args.duration))
        print(os.path.basename(path), "REJECT: " + "; ".join(why) if why else "accepted")
        verdicts.append({"transcript": path, "accepted": not why, "reasons": why})
    return {"verdicts": verdicts, "rejected": sum(not v["accepted"] for v in verdicts)}


def command_index(args):
    rows = [reports.index_row(os.path.splitext(os.path.basename(p))[0], read_json(p))
            for p in sorted(glob.glob(os.path.join(args.transcripts, "*.json")))]
    out = args.out or os.path.join(args.transcripts, "index.tsv")
    with open(out, "w", encoding="utf-8") as handle:
        handle.write(reports.index_tsv(rows))
    totals = reports.index_totals(rows)
    print(totals["recordings"], "recordings", totals["hours"], "hours", totals["silent"], "silent", totals["segments"], "segments", totals["words"], "words")
    return {"index": out, **totals}


def command_text(args):
    doc = read_json(args.transcript)
    why = reports.judge(doc, args.duration)
    if why and not args.even_if_rejected:
        print("REJECT: " + "; ".join(why), file=sys.stderr)
        args.exit_code = 2
        return {"refused": args.transcript, "reasons": why}
    title = args.title or os.path.splitext(os.path.basename(doc.get("source") or args.transcript))[0]
    header = [f"Source: {doc['source']}"] if doc.get("source") else []
    header.append(f"Transcript: whisper, word timings in {os.path.basename(args.transcript)}")
    header = args.header or header
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(reports.as_text(doc, title, args.paragraph_seconds, header))
    count = len(reports.paragraphs(doc, args.paragraph_seconds))
    print(count, "paragraphs")
    return {"text": args.out, "paragraphs": count, "rejected_but_written": bool(why)}


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
    m = sub.add_parser("transcribe-many", help="a transcript for every recording in a folder, skipping ones already done")
    m.add_argument("--recordings", required=True, help="the folder of recordings")
    m.add_argument("--pattern", default="*", help="which files in it (default every file)")
    m.add_argument("--out-dir", required=True, help="where <name>.json goes for each recording")
    m.add_argument("--workers", type=int, default=1, help="how many to hear at once")
    m.add_argument("--max-load", type=float, help="wait while the computer's load average is above this")
    engine(m)
    m.set_defaults(run=command_transcribe_many)
    f = sub.add_parser("find-loops", help="which transcripts hold repetition loops, and how many seconds they cover")
    f.add_argument("--transcript", nargs="+", required=True)
    f.set_defaults(run=command_find_loops)
    r = sub.add_parser("repair", help="hear again only the looped windows and splice them in")
    r.add_argument("--transcript", required=True)
    r.add_argument("--audio", required=True)
    r.add_argument("--out")
    engine(r)
    r.set_defaults(run=command_repair)
    rm = sub.add_parser("repair-many", help="repair many transcripts, each from the recording it names")
    rm.add_argument("--transcript", nargs="+", required=True)
    rm.add_argument("--workers", type=int, default=1)
    rm.add_argument("--max-load", type=float, help="wait while the computer's load average is above this")
    engine(rm)
    rm.set_defaults(run=command_repair_many)
    j = sub.add_parser("judge", help="whether each whole answer looks looped or invented, and why")
    j.add_argument("--transcript", nargs="+", required=True)
    j.add_argument("--duration", type=float, help="the recording's length in seconds, when the transcript does not say it")
    j.add_argument("--durations", help="a tab-separated list of each recording's length, one row per transcript name")
    j.add_argument("--id-column", default="id", help="the --durations column holding the transcript's name (default id)")
    j.add_argument("--duration-column", default="duration", help="the --durations column holding the seconds (default duration)")
    j.set_defaults(run=command_judge)
    i = sub.add_parser("index", help="one line per transcript in a folder, with the totals")
    i.add_argument("--transcripts", required=True, help="the folder of <name>.json transcripts")
    i.add_argument("--out", help="the index file (default <folder>/index.tsv)")
    i.set_defaults(run=command_index)
    x = sub.add_parser("text", help="the transcript as [m:ss] paragraphs, refused when judge rejects it")
    x.add_argument("--transcript", required=True)
    x.add_argument("--out", required=True)
    x.add_argument("--title")
    x.add_argument("--header", action="append", help="a line under the title (repeat for more); replaces the source and transcript lines")
    x.add_argument("--duration", type=float, help="the recording's length in seconds, for the judge, when the transcript does not say it")
    x.add_argument("--paragraph-seconds", type=float, default=30.0)
    x.add_argument("--even-if-rejected", action="store_true", help="write it anyway, for a person to look at")
    x.set_defaults(run=command_text)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.exit_code = 0
    result = args.run(args)
    print(json.dumps({"result": result}, ensure_ascii=False))
    return args.exit_code


if __name__ == "__main__":
    sys.exit(main())

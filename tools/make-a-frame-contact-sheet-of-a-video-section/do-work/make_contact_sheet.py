#!/usr/bin/env python3
"""Cut a short low-resolution section of a video and make one contact sheet of its frames, reporting every failure.

  python3 make_contact_sheet.py --source URL_OR_FILE --name NAME --start S --end E --folder FOLDER [--step 4] [--cols 4]

A URL is fetched with yt-dlp, only the section, at 360p or less, into FOLDER/clips/<name>-<start>-<end>.<ext>; a clip already
there is used again. A local video file is read directly from S to E. ffmpeg takes one frame every --step seconds, 320 pixels
wide, into a grid --cols wide: FOLDER/frames/<name>-<start>-<end>-sheet.jpg. Every command and its output go to
FOLDER/frames/<name>-<start>-<end>.log, and its last lines are printed on failure; arguments are separate argv items and nothing
is hidden. Each heavy process runs alone under nice -n 20. The last line printed is {"result": {...}}; exit 0 only when the
sheet exists and is not empty.
"""
import argparse
import json
import sys
from pathlib import Path
import subprocess

LONGEST_SECTION = 300


def answer(result, code):
    print(json.dumps({"result": result}))
    sys.exit(code)


def run(cmd, log):
    with open(log, "a", encoding="utf-8") as handle:
        handle.write("$ " + " ".join(cmd) + "\n")
        handle.flush()
        try:
            return subprocess.run(["nice", "-n", "20"] + cmd, stdout=handle, stderr=subprocess.STDOUT).returncode
        except FileNotFoundError as error:
            handle.write(f"{error}\n")
            return 127


def fail(message, log):
    print("FAILED: " + message, file=sys.stderr)
    try:
        tail = Path(log).read_text(encoding="utf-8").splitlines()[-8:]
        print(f"log {log}:\n" + "\n".join(tail), file=sys.stderr)
    except OSError:
        tail = []
    answer({"error": message, "log": str(log), "log_tail": tail}, 1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--source", required=True, help="a video URL yt-dlp can read, or a video file on this computer")
    parser.add_argument("--name", required=True, help="the name the clip, sheet and log files start with")
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--folder", required=True, help="the folder clips/ and frames/ are made in")
    parser.add_argument("--step", type=int, default=4, help="seconds between frames")
    parser.add_argument("--cols", type=int, default=4, help="frames per row of the sheet")
    args = parser.parse_args(argv)
    if not (0 <= args.start < args.end) or args.end - args.start > LONGEST_SECTION:
        answer({"error": f"start and end must satisfy 0 <= start < end and cover at most {LONGEST_SECTION} s"}, 2)
    if args.step < 1 or args.cols < 1:
        answer({"error": "step and cols must be whole numbers of 1 or more"}, 2)
    if "/" in args.name or not args.name.strip():
        answer({"error": "name must be a plain file name start, with no '/'"}, 2)
    folder = Path(args.folder)
    stem = f"{args.name}-{args.start}-{args.end}"
    (folder / "clips").mkdir(parents=True, exist_ok=True)
    (folder / "frames").mkdir(parents=True, exist_ok=True)
    log = folder / "frames" / f"{stem}.log"
    log.write_text("", encoding="utf-8")
    local = Path(args.source)
    if local.is_file():
        clip, seek = local, ["-ss", str(args.start), "-to", str(args.end)]
    else:
        clips = sorted((folder / "clips").glob(stem + ".*"))
        if not clips:
            code = run(["yt-dlp", args.source, "-f", "bv*[height<=360]+ba/b[height<=360]/best",
                        "--download-sections", f"*{args.start}-{args.end}",
                        "-o", str(folder / "clips" / (stem + ".%(ext)s"))], log)
            clips = sorted((folder / "clips").glob(stem + ".*"))
            if code != 0 or not clips:
                fail(f"yt-dlp exit {code}, clip files: {[c.name for c in clips]}", log)
        clip, seek = clips[0], []
    if clip.stat().st_size == 0:
        fail("clip file is empty", log)
    sheet = folder / "frames" / f"{stem}-sheet.jpg"
    rows = max(1, ((args.end - args.start) // args.step + args.cols - 1) // args.cols)
    code = run(["ffmpeg", "-loglevel", "error", "-y"] + seek + ["-i", str(clip), "-vf",
                f"fps=1/{args.step},scale=320:-1,tile={args.cols}x{rows}", "-frames:v", "1", str(sheet)], log)
    if code != 0 or not sheet.exists() or sheet.stat().st_size == 0:
        fail(f"ffmpeg exit {code}, sheet missing or empty", log)
    answer({"sheet": str(sheet), "clip": str(clip), "log": str(log), "columns": args.cols, "rows": rows}, 0)


if __name__ == "__main__":
    main()

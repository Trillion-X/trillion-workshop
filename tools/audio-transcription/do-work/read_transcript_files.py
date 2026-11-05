#!/usr/bin/env python3
"""Parse a drive's transcript files (srt, vtt, json, txt) into the common words.json shape.

  read_transcript_files.py read-file  --file FILE --out FILE.words.json [--format EXT] [--fps N]
  read_transcript_files.py read-files --list LIST.tsv --bytes DIR --out-dir DIR [--root NAME] [--origin NAME] [--fps N]

read-files reads a tab-separated list with a header (kind, ext, origin, identity, bytes, sha256, display_path: what
pick_transcript_files.py writes) and the bytes of each file as <bytes>/<hex>.<ext>, the hex being the identity after its
"1f:"; it writes <out-dir>/<hex>.words.json with
{source, display_path, root, origin, identity, kind, timing: word|segment|none, duration, words, segments} and, when nothing
in the file is timed, its whole text. A file already read, or whose bytes are not in the folder, is skipped and counted.
txt files in hh:mm:ss:ff timecode are read at --fps frames a second (24 by default). The last line printed is
{"result": {...}}.
"""
import argparse, html, json, os, re, sys

TS = r"(\d+):(\d\d):(\d\d)[.,](\d+)"
TC = r"(\d\d):(\d\d):(\d\d):(\d\d)"
FPS = 24.0


def sec(h, m, s, f, frac=1000.0):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(f) / frac


def parse_cues(text):
    out = []
    for blk in re.split(r"\n\s*\n", html.unescape(text)):
        m = re.search(TS + r"\s*-->\s*" + TS, blk)
        if m:
            g = m.groups()
            body = " ".join(blk[m.end():].split())
            out.append({"text": body, "start": sec(*g[:3], g[3], 10 ** len(g[3])), "end": sec(*g[4:7], g[7], 10 ** len(g[7]))})
    return out


def parse_hash_txt(text):
    out = []
    for m in re.finditer(r"^## " + TS + r" - " + TS + r"\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M):
        g = m.groups()
        out.append({"text": " ".join(g[8].split()), "start": sec(*g[:3], g[3], 10 ** len(g[3])), "end": sec(*g[4:7], g[7], 10 ** len(g[7]))})
    return out


def parse_tc_txt(text):
    out = []
    for m in re.finditer(r"^" + TC + r" - " + TC + r"\n(?:[^\n]*\n)?(.*?)(?=^\d\d:\d\d:\d\d:\d\d - |\Z)", text, re.S | re.M):
        g = m.groups()
        out.append({"text": " ".join(g[8].split()), "start": sec(*g[:3], g[3], FPS), "end": sec(*g[4:7], g[7], FPS)})
    return out


def parse(path, ext):
    raw = open(path, errors="replace").read()
    words, segs, source, duration = [], [], None, None
    if ext == "json":
        d = json.loads(raw)
        source, duration = d.get("source"), d.get("duration")
        for s in d.get("segments", []):
            segs.append({"text": s["text"].strip(), "start": s["start"], "end": s["end"]})
            for w in s.get("words") or []:
                words.append({"text": w["word"].strip(), "start": w["start"], "end": w["end"]})
    else:
        if ext in ("srt", "vtt"):
            segs = parse_cues(raw)
        else:
            m = re.search(r"^source: (.*)$", raw, re.M)
            source = m.group(1).strip() if m else None
            segs = parse_hash_txt(raw) or parse_tc_txt(raw)
    segs = [s for s in segs if s["text"]]
    if segs:
        timing = "word" if words else "segment"
        duration = duration or max(s["end"] for s in segs)
    else:
        timing = "none"
    return {"timing": timing, "source": source, "duration": duration, "words": words, "segments": segs,
            "text": None if segs else " ".join(raw.split())}


def read_files(args):
    os.makedirs(args.out_dir, exist_ok=True)
    counts, written, already, missing = {}, 0, 0, 0
    with open(args.list, encoding="utf-8") as listing:
        rows = list(listing)
    for line in rows[1:]:
        kind, ext, origin, ident, nbytes, sha, display = line.rstrip("\n").split("\t")
        hexid = ident.split(":", 1)[1]
        p = os.path.join(args.bytes, f"{hexid}.{ext}")
        out = os.path.join(args.out_dir, f"{hexid}.words.json")
        if not os.path.exists(p) or os.path.exists(out):
            missing += not os.path.exists(p)
            already += os.path.exists(p)
            continue
        r = parse(p, ext)
        doc = {"source": r["source"] or display, "display_path": display, "root": args.root, "origin": args.origin, "identity": ident,
               "kind": kind, "timing": r["timing"], "duration": r["duration"], "words": r["words"], "segments": r["segments"]}
        if r["text"]:
            doc["text"] = r["text"]
        with open(out, "w", encoding="utf-8") as handle:
            json.dump(doc, handle, ensure_ascii=False)
        written += 1
        counts[(ext, r["timing"])] = counts.get((ext, r["timing"]), 0) + 1
    for k, v in sorted(counts.items()):
        print(k, v)
    return {"written": written, "already_read": already, "not_in_files": missing,
            "by_format_and_timing": {f"{ext} {timing}": n for (ext, timing), n in sorted(counts.items())}}


def read_file(args):
    ext = (args.format or os.path.splitext(args.file)[1][1:]).lower()
    if ext not in ("srt", "vtt", "json", "txt"):
        raise SystemExit(f"{args.file}: give --format srt, vtt, json or txt; {ext or 'no extension'} is not a transcript format read here")
    r = parse(args.file, ext)
    doc = {"source": r["source"] or args.file, "timing": r["timing"], "duration": r["duration"], "words": r["words"], "segments": r["segments"]}
    if r["text"]:
        doc["text"] = r["text"]
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(doc, handle, ensure_ascii=False)
    print(args.file, r["timing"], len(r["segments"]), "segments", len(r["words"]), "words")
    return {"words_json": args.out, "timing": r["timing"], "segments": len(r["segments"]), "words": len(r["words"]), "duration": r["duration"]}


def main(argv=None):
    global FPS
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("read-file", help="one transcript file into one words.json")
    one.add_argument("--file", required=True)
    one.add_argument("--out", required=True)
    one.add_argument("--format", help="srt, vtt, json or txt (default: the file's extension)")
    many = sub.add_parser("read-files", help="every file of a list, from a folder of their bytes")
    many.add_argument("--list", required=True, help="the tab-separated list pick_transcript_files.py writes")
    many.add_argument("--bytes", required=True, help="the folder holding <hex>.<ext> for each listed file")
    many.add_argument("--out-dir", required=True, help="where <hex>.words.json goes")
    many.add_argument("--root", default="", help="the drive or library the files came from, kept in each words.json")
    many.add_argument("--origin", default="", help="where the bytes were read from (a store's name), kept in each words.json")
    for p in (one, many):
        p.add_argument("--fps", type=float, default=FPS, help="frames a second of hh:mm:ss:ff timecode in txt files (default 24)")
    args = parser.parse_args(argv)
    FPS = args.fps
    result = (read_file if args.command == "read-file" else read_files)(args)
    print(json.dumps({"result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

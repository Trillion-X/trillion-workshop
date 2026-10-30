#!/usr/bin/env python3
"""Keep principles, each backed by words checked against the captions of the videos they came from.

  cite_principles.py corpus      --captions FOLDER [FOLDER ...] --out corpus.jsonl [--views-table FILE.tsv]
  cite_principles.py candidates  --corpus FILE --terms FILE --out FOLDER [--caps FILE]
  cite_principles.py find        --corpus FILE --video ID --quote TEXT
  cite_principles.py verify      --corpus FILE --rows GLOB [--caption-files GLOB ...]
  cite_principles.py registry    --corpus FILE --rows GLOB --out principles.jsonl [--id-map FILE] [--lanes FILE] [--merge FILE]

A captions folder holds <id>.info.json (the video's details) and <id>.en.json3 (YouTube captions) per video. Every command prints its
account, then one last line {"result": {...}}. verify exits 1 when a quote is not in its captions or its video has none.
"""
import argparse
import csv
import glob
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
import captions as c  # noqa: E402
import registry  # noqa: E402

DEFAULT_URL = "https://youtu.be/{video}?t={t}"
CAPTION_SUFFIXES = (".en.json3", ".en-orig.json3")


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def read_lines(pattern):
    """Every non-empty line of every file matching the glob, as (file, line number, text)."""
    for path in sorted(glob.glob(pattern)):
        with open(path, encoding="utf-8") as handle:
            for number, line in enumerate(handle.read().splitlines()):
                if line.strip():
                    yield path, number, line


def load_corpus(path):
    corpus = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            video = json.loads(line)
            corpus[video["id"]] = video
    return corpus


def caption_file(folder, video_id):
    for suffix in CAPTION_SUFFIXES:
        if os.path.exists(os.path.join(folder, video_id + suffix)):
            return os.path.join(folder, video_id + suffix)
    found = sorted(glob.glob(os.path.join(folder, video_id + ".en*.json3")))
    return found[0] if found else None


def command_corpus(args):
    views = defaultdict(list)
    if args.views_table:
        with open(args.views_table, encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle, delimiter="\t"):
                try:
                    views[((row.get("channel") or "").strip(), row.get("kind"))].append(int(row["views"]))
                except (ValueError, TypeError, KeyError):
                    continue  # a row with no views number says nothing about the usual
    usual = c.medians([(key, n) for key, numbers in views.items() for n in numbers])
    where = {}
    for folder in args.captions:
        for path in glob.glob(os.path.join(folder, "*.info.json")):
            where.setdefault(os.path.basename(path).split(".")[0], folder)
    infos = {}
    for video_id in sorted(where):
        try:
            info = read_json(os.path.join(where[video_id], video_id + ".info.json"))
        except (OSError, ValueError):
            continue
        infos[video_id] = dict(id=video_id, channel=(info.get("channel") or "").strip(), title=info.get("title"), views=info.get("view_count"),
                               duration=info.get("duration"), kind=c.kind_of(info), date=info.get("upload_date"),
                               desc=(info.get("description") or "")[:1500],
                               chapters=[(ch.get("start_time"), ch.get("title")) for ch in (info.get("chapters") or [])])
    own = c.medians([((x["channel"], x["kind"]), x["views"]) for x in infos.values() if x["views"] is not None])
    written, without = 0, 0
    with open(args.out, "w", encoding="utf-8") as out:
        for video_id, video in infos.items():
            path = caption_file(where[video_id], video_id)
            try:
                segs = c.segs_from_json3(read_json(path)) if path else []
            except (OSError, ValueError):
                segs = []
            if not segs:
                without += 1
                continue
            median = usual.get((video["channel"], video["kind"])) or own.get((video["channel"], video["kind"]))
            video["median"] = median
            video["xmed"] = c.times_the_usual(video["views"], median)
            video["segs"] = segs
            video["capfile"] = os.path.relpath(path, where[video_id])
            out.write(json.dumps(video, ensure_ascii=False) + "\n")
            written += 1
    print(written, "videos with captions;", without, "without")
    return {"videos": written, "without_captions": without, "corpus": args.out}


def command_candidates(args):
    corpus = list(load_corpus(args.corpus).values())
    terms = read_json(args.terms)
    craft = re.compile(terms["topic"], re.I)
    title_pattern = re.compile(terms["title"], re.I)
    advice = re.compile("|".join(terms["advice"]), re.I)
    caps = read_json(args.caps) if args.caps else {}
    by_channel = defaultdict(list)
    for video in corpus:
        by_channel[video["channel"]].append(video)
    os.makedirs(args.out, exist_ok=True)
    summary = []
    for channel, videos in by_channel.items():
        n = len(videos)
        cap = caps.get(channel, 3 * n if n <= 8 else min(220, int(25 + n * 0.12)))
        found = [p for v in videos for p in c.passages(v, craft, advice, title_pattern, args.window_seconds, args.per_video)]
        found.sort(key=lambda p: -p["score"])
        keep = found[:cap]
        name = re.sub(r"[^A-Za-z0-9]+", "-", channel).strip("-") or "x"
        with open(os.path.join(args.out, name + ".jsonl"), "w", encoding="utf-8") as handle:
            for p in keep:
                handle.write(json.dumps(p, ensure_ascii=False) + "\n")
        summary.append((channel, n, len(keep)))
    with open(os.path.join(args.out, "openings.jsonl"), "w", encoding="utf-8") as handle:
        for channel, videos in by_channel.items():
            top = args.openings_per_large_channel if len(videos) > 50 else args.openings_per_channel
            for video in sorted(videos, key=lambda v: -(v["xmed"] or 0))[:top]:
                text = " ".join(line for second, line in video["segs"] if second < args.opening_seconds)
                handle.write(json.dumps(dict(channel=channel, id=video["id"], title=video["title"], views=video["views"], xmed=video["xmed"],
                                             kind=video["kind"], text=text), ensure_ascii=False) + "\n")
    for channel, n, kept in sorted(summary, key=lambda s: -s[1]):
        print(channel, n, kept, sep="\t")
    return {"channels": [{"channel": ch, "videos": n, "passages": k} for ch, n, k in summary], "folder": args.out}


class Verifier:
    """Finds a quote in the captions of the video a row names: the corpus first, then caption files (json3) matched by video id."""

    def __init__(self, corpus, caption_files=()):
        self.corpus = corpus
        self.caption_files = list(caption_files)
        self.cache = {}

    def segs(self, video_id):
        if video_id in self.corpus:
            return self.corpus[video_id]["segs"]
        for pattern in self.caption_files:
            for path in sorted(glob.glob(pattern.replace("{video}", video_id))):
                segs = c.segs_from_json3(read_json(path))
                if segs:
                    return segs
        return None

    def find(self, video_id, quote):
        """Start second of the quote, None when it is not said, 'MISSING' when no captions exist for the video."""
        if video_id not in self.cache:
            segs = self.segs(video_id)
            self.cache[video_id] = None if segs is None else c.CaptionText(segs)
        text = self.cache[video_id]
        return "MISSING" if text is None else text.second_of(quote)


def verify_rows(pattern, verifier, out=print):
    bad = missing = quotes = rows = 0
    for path, number, line in read_lines(pattern):
        try:
            row = json.loads(line)
        except ValueError as error:
            out(f"JSONERR {path} {number} {error}")
            continue
        rows += 1
        for source in row.get("sources", []):
            if not source.get("quote"):
                continue
            quotes += 1
            second = verifier.find(source["video"], source["quote"])
            if second == "MISSING":
                missing += 1
                out(f"MISSING {row['id']} {source['video']} (no caption file)")
            elif second is None:
                bad += 1
                out(f"BAD {row['id']} {source['video']} {source['quote'][:80]}")
            elif abs(second - (source.get("t") or 0)) > 3:
                out(f"TOFF {row['id']} {source['video']} {source.get('t')} {second}")
    out(f"rows {rows} quotes {quotes} bad {bad} missing {missing}")
    return rows, quotes, bad, missing


def command_verify(args):
    rows, quotes, bad, missing = verify_rows(args.rows, Verifier(load_corpus(args.corpus), args.caption_files))
    args.exit_code = 1 if bad or missing else 0
    return {"rows": rows, "quotes": quotes, "bad": bad, "missing": missing}


def command_find(args):
    second = Verifier(load_corpus(args.corpus)).find(args.video, args.quote)
    print({"MISSING": "NOVIDEO", None: "NOTFOUND"}.get(second, second))
    args.exit_code = 0 if isinstance(second, int) else 1 if second is None else 2
    return {"video": args.video, "second": second if isinstance(second, int) else None, "found": isinstance(second, int)}


def command_registry(args):
    corpus = load_corpus(args.corpus)
    rows = {}
    for _, _, line in read_lines(args.rows):
        row = json.loads(line)
        rows[row["id"]] = row
    lanes = read_json(args.lanes) if args.lanes else {}
    merge = read_json(args.merge) if args.merge else {}
    principles, id_map = registry.build_registry(
        list(rows.values()), corpus, lanes.get("stages"), lanes.get("lane_names"), merge.get("groups"), merge.get("contradictions"),
        merge.get("recorded_by", "merge file"), args.url_template)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        for principle in principles:
            handle.write(json.dumps(principle, ensure_ascii=False) + "\n")
    if args.id_map:
        with open(args.id_map, "w", encoding="utf-8") as handle:
            json.dump(id_map, handle)
    quotes = sum(p["evidence"]["quotes"] for p in principles)
    demos = sum(p["evidence"]["demonstrations"] for p in principles)
    print(len(principles), "principles;", quotes, "quotes;", demos, "demos")
    return {"principles": len(principles), "quotes": quotes, "demonstrations": demos, "registry": args.out}


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("corpus", help="one line per captioned video: details, how it did against its channel's usual, captions")
    s.add_argument("--captions", nargs="+", required=True, help="folders of <id>.info.json and <id>.en.json3")
    s.add_argument("--views-table", help="a TSV with the columns channel, kind (short or video) and views, to take each channel's usual views from")
    s.add_argument("--out", required=True)
    s.set_defaults(run=command_corpus)
    s = sub.add_parser("candidates", help="the passages worth reading for principles, per channel, and each channel's best openings")
    s.add_argument("--corpus", required=True)
    s.add_argument("--terms", required=True, help='a JSON file {"topic": "word|word|...", "title": "word|word|...", "advice": ["phrase", ...]}: '
                   'what the principles are about (regular-expression parts), which titles are about it, and how advice sounds in the speakers\' words')
    s.add_argument("--caps", help='a JSON file {channel: most passages to keep} for channels that should differ from the default')
    s.add_argument("--window-seconds", type=float, default=c.WINDOW_SECONDS)
    s.add_argument("--per-video", type=int, default=c.TOP_PASSAGES_PER_VIDEO)
    s.add_argument("--opening-seconds", type=float, default=45)
    s.add_argument("--openings-per-channel", type=int, default=3)
    s.add_argument("--openings-per-large-channel", type=int, default=12, help="for a channel with more than 50 videos")
    s.add_argument("--out", required=True)
    s.set_defaults(run=command_candidates)
    s = sub.add_parser("find", help="the second a quote is said at in one video's captions")
    s.add_argument("--corpus", required=True)
    s.add_argument("--video", required=True)
    s.add_argument("--quote", required=True)
    s.set_defaults(run=command_find)
    s = sub.add_parser("verify", help="check that every quote in the rows is an exact substring of its video's captions")
    s.add_argument("--corpus", required=True)
    s.add_argument("--rows", required=True, help="a glob of JSONL files of rows with sources [{video, t, quote}]")
    s.add_argument("--caption-files", nargs="*", default=[], help="globs of json3 caption files for videos not in the corpus; {video} is the video id")
    s.set_defaults(run=command_verify)
    s = sub.add_parser("registry", help="merge the rows into one ranked registry with each principle's evidence")
    s.add_argument("--corpus", required=True)
    s.add_argument("--rows", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--id-map", help="where to write {working id: principle id}")
    s.add_argument("--lanes", help='a JSON file {"stages": {stage: [lanes]}, "lane_names": {lane: canonical lane}}')
    s.add_argument("--merge", help='a JSON file {"groups": [{"ids": [...], "text"?}], "contradictions": [[id, id, how]], "recorded_by"?}')
    s.add_argument("--url-template", default=DEFAULT_URL)
    s.set_defaults(run=command_registry)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.exit_code = 0
    result = args.run(args)
    print(json.dumps({"result": result}, ensure_ascii=False))
    return args.exit_code


if __name__ == "__main__":
    sys.exit(main())

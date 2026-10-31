#!/usr/bin/env python3
"""Keep principles, strategies, lessons or any other rows a person asks for, each backed by words checked against the captions of the
videos they came from.

  cite_principles.py corpus      [--captions FOLDER ...] [--transcripts FOLDER ...] [--infos FOLDER ...] [--caption-lines FILE ...] --out corpus.jsonl [--views-table FILE.tsv]
  cite_principles.py coverage    --corpus FILE [--rows GLOB ...] [--out FILE.json]
  cite_principles.py candidates  --corpus FILE --terms FILE --out FOLDER [--caps FILE]
  cite_principles.py extract     --corpus FILE --asks FILE --model FILE --out FOLDER [--channels NAME ...] [--videos FILE] [--concurrency N] [--max-load L]
  cite_principles.py find        --corpus FILE --video ID --quote TEXT
  cite_principles.py verify      --corpus FILE --rows GLOB [--caption-files GLOB ...]
  cite_principles.py registry    --corpus FILE --rows GLOB --out principles.jsonl [--id-map FILE] [--lanes FILE] [--merge FILE]

A captions folder holds <id>.info.json (the video's details) and <id>.en.json3 (YouTube captions) per video; a transcripts folder holds
word-timed <id>.json files whose info files may sit in an --infos folder; a caption-lines file holds one video per line, {video_id, status,
lines: [[second, words]], info} (a harvester's captions.jsonl), read as it is. Every command prints its account, then one last line
{"result": {...}}. verify exits 1 when a quote is not in its captions or its video has none.
"""
import argparse
import csv
import glob
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
import captions as c  # noqa: E402
import extraction as x  # noqa: E402
import registry  # noqa: E402

DEFAULT_URL = "https://youtu.be/{video}?t={t}"
CAPTION_SUFFIXES = (".en.json3", ".en-orig.json3")
LINE_WORDS = 12


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


def segs_from_transcript(document):
    """[[start second, text]] from a word-timed transcript: `segments` [{start, text}], or `words` [{text, start, type}] made into
    lines that end at a sentence's end or after LINE_WORDS words. Words are joined by one space whatever spacing entries the
    transcript holds or leaves out; entries of any other type are not words."""
    if document.get("segments"):
        return [[round(s.get("start") or 0, 1), (s.get("text") or "").strip()] for s in document["segments"] if (s.get("text") or "").strip()]
    segs, line, start = [], [], None
    for word in document.get("words") or []:
        text = (word.get("text") or "").strip()
        if word.get("type", "word") != "word" or not text:
            continue
        if start is None:
            start = word.get("start") or 0
        line.append(text)
        if len(line) >= LINE_WORDS or text[-1:] in ".?!":
            segs.append([round(start, 1), " ".join(line)])
            line, start = [], None
    if line:
        segs.append([round(start, 1), " ".join(line)])
    return segs


def platform_of(info):
    """The site a video is from: its extractor's name, else the main part of its page's host name (www.youtube.com -> youtube)."""
    named = (info.get("extractor_key") or info.get("extractor") or "").lower()
    if named:
        return named
    host = urllib.parse.urlparse(info.get("webpage_url") or "").hostname or ""
    parts = [p for p in host.split(".") if p not in ("www", "m", "mobile")]
    return parts[-2] if len(parts) >= 2 else None


def video_of(video_id, info):
    return dict(id=video_id, platform=platform_of(info),
                channel=(info.get("channel") or info.get("uploader") or "").strip(),
                channel_url=info.get("channel_url") or info.get("uploader_url"), title=info.get("title"), views=info.get("view_count"),
                duration=info.get("duration"), kind=c.kind_of(info), date=info.get("upload_date"), url=info.get("webpage_url"),
                desc=(info.get("description") or "")[:1500],
                chapters=[(ch.get("start_time"), ch.get("title")) for ch in (info.get("chapters") or [])])


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

    def info_folder(name, folder):
        return next((f for f in [folder] + args.infos if os.path.exists(os.path.join(f, name + ".info.json"))), None)

    for folder in args.captions:
        names = {os.path.basename(p)[:-len(".info.json")] for p in glob.glob(os.path.join(folder, "*.info.json"))}
        names |= {os.path.basename(p).split(".en")[0] for p in glob.glob(os.path.join(folder, "*.en*.json3"))}
        for name in sorted(names):
            found = info_folder(name, folder)
            if found:
                where.setdefault(name, ("captions", folder, found))
    for folder in args.transcripts:
        for path in glob.glob(os.path.join(folder, "*.json")):
            name = os.path.basename(path)[:-len(".json")]
            if "." in name:
                continue  # an info file or another sidecar, not a transcript
            found = info_folder(name, folder)
            if found:
                where.setdefault(name, ("transcript", folder, found))
    lined = {}
    for path in args.caption_lines:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                entry = json.loads(line)
                video_id = entry.get("video_id") or (entry.get("info") or {}).get("id")
                if video_id and video_id not in where and video_id not in lined:
                    lined[video_id] = (path, entry)
    infos = {}
    for video_id, (path, entry) in lined.items():
        infos[video_id] = video_of(video_id, {"webpage_url": entry.get("url"), **(entry.get("info") or {})})
    for video_id in sorted(where):
        try:
            infos[video_id] = video_of(video_id, read_json(os.path.join(where[video_id][2], video_id + ".info.json")))
        except (OSError, ValueError):
            continue
    own = c.medians([((x["channel"], x["kind"]), x["views"]) for x in infos.values() if x["views"] is not None])
    written, without = 0, 0
    with open(args.out, "w", encoding="utf-8") as out:
        for video_id, video in infos.items():
            if video_id in lined:
                path, entry = lined[video_id]
                folder = os.path.dirname(path)
                segs = [[second, text.strip()] for second, text in entry.get("lines") or [] if (text or "").strip()] if entry.get("status", "ready") == "ready" else []
            else:
                form, folder, _ = where[video_id]
                path = caption_file(folder, video_id) if form == "captions" else os.path.join(folder, video_id + ".json")
                try:
                    segs = (c.segs_from_json3 if form == "captions" else segs_from_transcript)(read_json(path)) if path else []
                except (OSError, ValueError):
                    segs = []
            if not segs:
                without += 1
                continue
            median = usual.get((video["channel"], video["kind"])) or own.get((video["channel"], video["kind"]))
            video["median"] = median
            video["xmed"] = c.times_the_usual(video["views"], median)
            video["segs"] = segs
            video["words"] = sum(len(text.split()) for _, text in segs)
            video["capfile"] = os.path.relpath(path, folder)
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
        with open(os.path.join(args.out, file_name(channel) + ".jsonl"), "w", encoding="utf-8") as handle:
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


def file_name(channel):
    return re.sub(r"[^A-Za-z0-9]+", "-", channel or "").strip("-") or "x"


def videos_cited(row):
    """Every video a row names: its own `video`, and those of its sources and demonstrations."""
    named = {row.get("video")} | {s.get("video") for s in row.get("sources") or []} | {d.get("video") for d in row.get("demonstrated_in") or []}
    return named - {None}


def command_coverage(args):
    mined = defaultdict(int)
    row_files = []
    for pattern in args.rows:
        for file, _, line in read_lines(pattern):
            try:
                row = json.loads(line)
            except ValueError:
                continue
            # Extract outcomes and rejected model answers also name videos. They are not kept knowledge rows.
            if 'failed_parts' in row or ('why' in row and 'row' in row) or ('error' in row and 'attempt' in row):
                continue
            for video in videos_cited(row):
                mined[video] += 1
            if row.get('sources') and file not in row_files:
                row_files.append(file)
    completed = {video for video, entry in read_done(args.done).items() if not entry.get('failed_parts')} if args.done else set()
    groups = defaultdict(lambda: dict(channel_url=None, videos=0, words=0, shorts=0, mined_videos=0, rows=0))
    with open(args.corpus, encoding="utf-8") as handle:
        for line in handle:
            video = json.loads(line)
            group = groups[(video.get("platform") or "", video.get("channel") or "")]
            group["channel_url"] = group["channel_url"] or video.get("channel_url")
            group["videos"] += 1
            group["words"] += video.get("words") or sum(len(text.split()) for _, text in video["segs"])
            group["shorts"] += video.get("kind") == "short"
            group["mined_videos"] += video["id"] in mined
            group["rows"] += mined.get(video["id"], 0)
            if args.done:
                group['completed_videos'] = group.get('completed_videos', 0) + (video['id'] in completed)
    table = sorted(({"platform": p, "channel": ch, **g} for (p, ch), g in groups.items()), key=lambda g: -g["words"])
    print("platform", "channel", "videos", "shorts", "words", "mined_videos", sep="\t")
    for g in table:
        print(g["platform"], g["channel"], g["videos"], g["shorts"], g["words"], g["mined_videos"], sep="\t")
    keys = ("videos", "shorts", "words", "mined_videos", "rows") + (('completed_videos',) if args.done else ())
    totals = {k: sum(g[k] for g in table) for k in keys}
    if args.out:
        with open(args.out + '.part', "w", encoding="utf-8") as handle:
            json.dump({"totals": totals, "channels": table,
                       "row_files": [dict(path=os.path.relpath(os.path.abspath(file), os.path.dirname(os.path.abspath(args.out))),
                                          **({'sidecar': os.path.relpath(os.path.splitext(os.path.abspath(file))[0] + '.nxn.json', os.path.dirname(os.path.abspath(args.out)))}
                                             if os.path.exists(os.path.splitext(file)[0] + '.nxn.json') else {})) for file in row_files]},
                      handle, ensure_ascii=False, indent=1)
        os.replace(args.out + '.part', args.out)
    return {"channels": len(table), **totals, "out": args.out}


class Model:
    """A chat model behind the OpenAI-compatible /chat/completions shape (Ollama, llama.cpp, MLX, LM Studio, a rented runtime).

    spec = {"url": base ending before /chat/completions, "model", "key_env"?: the environment variable holding a key, "max_tokens"?,
    "body"?: more request fields the server reads (for example {"chat_template_kwargs": {"enable_thinking": false}})}.
    """

    def __init__(self, spec, timeout=900):
        if not spec.get("url") or not spec.get("model"):
            sys.exit("The model file needs url and model.")
        self.spec, self.timeout = spec, timeout
        self.key = os.environ.get(spec["key_env"]) if spec.get("key_env") else None
        if spec.get("key_env") and not self.key:
            sys.exit(f"The model needs a key in the environment variable {spec['key_env']}, which is not set.")

    def ask(self, system, user, schema=None):
        body = {"model": self.spec["model"], "temperature": 0, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                **({"max_tokens": self.spec["max_tokens"]} if self.spec.get("max_tokens") else {}), **(self.spec.get("body") or {})}
        if schema:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "rows", "strict": True, "schema": schema}}
        headers = {"Content-Type": "application/json", **({"Authorization": "Bearer " + self.key} if self.key else {})}
        request = urllib.request.Request(self.spec["url"].rstrip("/") + "/chat/completions", json.dumps(body).encode(), headers)
        with urllib.request.urlopen(request, timeout=self.timeout) as answer:
            reply = json.load(answer)
        return reply["choices"][0]["message"].get("content") or "", reply.get("usage") or {}


def wait_for_load(most):
    """Sleep while the machine's one-minute load average is above `most` (other work shares it)."""
    while most and os.getloadavg()[0] > most:
        time.sleep(20)


def read_done(path):
    done = {}
    if os.path.exists(path):
        for _, _, line in read_lines(path):
            entry = json.loads(line)
            done[entry["video"]] = entry
    return done


def command_extract(args):
    asks = read_json(args.asks)
    model = Model(read_json(args.model))
    corpus = load_corpus(args.corpus)
    os.makedirs(args.out, exist_ok=True)
    done_path = os.path.join(args.out, "done.jsonl")
    done = read_done(done_path)
    wanted = set(args.channels or [])
    listed = None
    if args.videos:
        with open(args.videos, encoding="utf-8") as handle:
            listed = [line.strip() for line in handle if line.strip()]
    rank = {channel: i for i, channel in enumerate(args.channels or [])}
    order = listed if listed is not None else sorted(corpus, key=lambda v: (rank.get(corpus[v]["channel"], 0), corpus[v]["channel"], v))
    todo = [corpus[v] for v in order if v in corpus and (not wanted or corpus[v]["channel"] in wanted)
            and (v not in done or done[v].get("failed_parts"))]
    if args.limit:
        todo = todo[:args.limit]
    by_channel = defaultdict(list)
    for video in todo:
        by_channel[video["channel"]].append(video)
    most_words = args.chunk_words or asks.get("chunk_words", 1500)
    chunks = [chunk for videos in by_channel.values() for chunk in x.parts_of(videos, most_words)]
    remaining = defaultdict(int)
    for chunk in chunks:
        for part in chunk:
            remaining[part["video"]] += 1
    captions = {}

    def captions_of(video_id):
        if video_id not in captions:
            captions[video_id] = x.Captions(corpus[video_id]["segs"], corpus[video_id].get("duration"))
        return captions[video_id]

    base = {"extracted_by": model.spec["model"], "asks": asks.get("name")}

    def ask(system, user, schema, usage):
        """One answer from the model. While the server cannot be reached (it is starting, or was restarted), wait for it, up to
        --wait-for-model seconds in all; an answer the server gives, even an error status, is returned or raised at once."""
        waited = 0
        while True:
            wait_for_load(args.max_load)
            try:
                content, used = model.ask(system, user, schema)
                for key in ("prompt_tokens", "completion_tokens"):
                    usage[key] = usage.get(key, 0) + used.get(key, 0)
                return content
            except urllib.error.HTTPError:
                raise
            except (urllib.error.URLError, ConnectionError) as error:
                if waited >= args.wait_for_model:
                    raise
                print(f"the model cannot be reached ({error}); waiting", file=sys.stderr, flush=True)
                time.sleep(30)
                waited += 30

    def work(chunk):
        user = x.prompt_of(asks, chunk, corpus)
        failures = []
        for attempt in range(args.attempts):
            started, content, usage = time.time(), None, {}
            try:
                content = ask(asks["system"], user, asks.get("reply_schema"), usage)
                kept, dropped = x.rows_of_reply(asks, chunk, corpus, captions_of, x.reply_rows(content, asks["rows_key"]), base)
                return dict(kept=kept, dropped=dropped, usage=usage, seconds=time.time() - started, failures=failures)
            except (urllib.error.URLError, OSError, ValueError, KeyError) as error:
                failures.append({"videos": [part["video"] for part in chunk], "attempt": attempt + 1, "error": str(error),
                                 "answer": (content or "")[:4000]})
                print(f"part of {chunk[0]['video']} failed ({error}); attempt {attempt + 1} of {args.attempts}", file=sys.stderr, flush=True)
                if attempt + 1 < args.attempts:
                    time.sleep(args.retry_seconds * (attempt + 1))
        return dict(kept=[], dropped=[], usage={}, seconds=0, failures=failures, failed=True)

    held = defaultdict(lambda: dict(rows=[], dropped=0, failed_parts=0, prompt_tokens=0, completion_tokens=0, seconds=0.0))
    lock = threading.Lock()
    totals = dict(videos=0, rows=0, dropped=0, failed_parts=0, prompt_tokens=0, completion_tokens=0)
    began = time.time()

    def write_coverage():
        if not args.coverage_out:
            return
        files = sorted({os.path.join(args.out, file_name(video['channel']) + '.jsonl') for video in corpus.values()})
        command_coverage(argparse.Namespace(corpus=args.corpus, rows=[file for file in files if os.path.exists(file)],
                                            done=done_path, out=args.coverage_out))

    def finish(video_id):
        entry = held.pop(video_id)
        rows = [{"id": f"{video_id}@{row['sources'][0]['t']}#{k}", **row}
                for k, row in enumerate(sorted(entry.pop("rows"), key=lambda r: r["sources"][0]["t"]), 1)]
        video = corpus[video_id]
        if entry["failed_parts"]:
            rows = []  # a video is written whole or not at all, so the next run asks for all of it again without repeating rows
        with open(os.path.join(args.out, file_name(video["channel"]) + ".jsonl"), "a", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        line = dict(video=video_id, channel=video["channel"], words=video.get("words"), rows=len(rows), **entry, model=model.spec["model"],
                    at=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
        with open(done_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")
        totals["videos"] += 1
        totals["rows"] += len(rows)
        if totals["videos"] % args.report_every == 0:
            spent = time.time() - began
            print(f"{totals['videos']} videos, {totals['rows']} rows, {totals['completion_tokens']} tokens written in {spent:.0f} s "
                  f"({totals['completion_tokens'] / max(spent, 1):.1f} tokens/s)", flush=True)
            write_coverage()

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool, \
            open(os.path.join(args.out, "dropped.jsonl"), "a", encoding="utf-8") as dropped_file, \
            open(os.path.join(args.out, "failed.jsonl"), "a", encoding="utf-8") as failed_file:
        for chunk, result in zip(chunks, pool.map(work, chunks)):
            result["failed"] = int(result.get("failed", False))
            with lock:
                for drop in result["dropped"]:
                    dropped_file.write(json.dumps(drop, ensure_ascii=False) + "\n")
                for failure in result["failures"]:
                    failed_file.write(json.dumps(failure, ensure_ascii=False) + "\n")
                dropped_file.flush()
                failed_file.flush()
                totals["dropped"] += len(result["dropped"])
                totals["failed_parts"] += result["failed"]
                totals["prompt_tokens"] += result["usage"].get("prompt_tokens", 0)
                totals["completion_tokens"] += result["usage"].get("completion_tokens", 0)
                share = 1 / len(chunk)
                for part in chunk:
                    entry = held[part["video"]]
                    entry["rows"].extend(r for r in result["kept"] if r["sources"][0]["video"] == part["video"] and r not in entry["rows"])
                    entry["failed_parts"] += result["failed"]
                    entry["prompt_tokens"] += round(result["usage"].get("prompt_tokens", 0) * share)
                    entry["completion_tokens"] += round(result["usage"].get("completion_tokens", 0) * share)
                    entry["seconds"] = round(entry["seconds"] + result["seconds"] * share, 1)
                    entry["dropped"] += sum(1 for d in result["dropped"] if d.get("video") == part["video"])
                    remaining[part["video"]] -= 1
                    if remaining[part["video"]] == 0:
                        finish(part["video"])
    spent = time.time() - began
    write_coverage()
    print(f"{totals['videos']} videos, {totals['rows']} rows kept, {totals['dropped']} dropped, {totals['failed_parts']} parts failed, "
          f"{spent:.0f} s", flush=True)
    return {**totals, "chunks": len(chunks), "seconds": round(spent), "out": args.out}


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("corpus", help="one line per captioned video: details, how it did against its channel's usual, captions")
    s.add_argument("--captions", nargs="*", default=[], help="folders of <id>.info.json and <id>.en.json3")
    s.add_argument("--transcripts", nargs="*", default=[], help="folders of word-timed transcripts <id>.json (segments [{start, text}] or words [{text, start, type}])")
    s.add_argument("--infos", nargs="*", default=[], help="folders holding the <id>.info.json of those transcripts, when not beside them")
    s.add_argument("--caption-lines", nargs="*", default=[], help="files of one video per line: {video_id, status, lines: [[second, words]], info} (a harvester's captions.jsonl)")
    s.add_argument("--views-table", help="a TSV with the columns channel, kind (short or video) and views, to take each channel's usual views from")
    s.add_argument("--out", required=True)
    s.set_defaults(run=command_corpus)
    s = sub.add_parser("coverage", help="videos, shorts and words per platform and channel, and how many videos the rows already cite")
    s.add_argument("--corpus", required=True)
    s.add_argument("--rows", nargs="*", default=[], help="globs of JSONL rows naming video, sources[].video or demonstrated_in[].video")
    s.add_argument("--done", help="extraction's done.jsonl: count fully read videos separately, including those that yielded zero rows")
    s.add_argument("--out", help="where to write the table as JSON")
    s.set_defaults(run=command_coverage)
    s = sub.add_parser("extract", help="ask a chat model for rows from every part of every video, each quote placed on the exact caption words")
    s.add_argument("--corpus", required=True)
    s.add_argument("--asks", required=True, help="the person's JSON file: system, user, part_header, reply_schema, rows_key, part_field, quote_field, "
                   "and optionally chunk_words, quote_most_words, quote_match_at_least, description_chars, name")
    s.add_argument("--model", required=True, help='a JSON file {"url", "model", "key_env"?, "max_tokens"?, "body"?}')
    s.add_argument("--out", required=True, help="the folder for <channel>.jsonl rows, done.jsonl (one line per finished video) and dropped.jsonl")
    s.add_argument("--channels", nargs="*", help="only these channels, in this order")
    s.add_argument("--videos", help="a file of video ids, one per line, in the order to read them")
    s.add_argument("--limit", type=int, help="at most this many videos this run")
    s.add_argument("--chunk-words", type=int, help="most words a model reads at once (default the asks' chunk_words, else 1500)")
    s.add_argument("--concurrency", type=int, default=1, help="requests in flight at once (a server with several slots answers them together)")
    s.add_argument("--max-load", type=float, help="wait before each request while the one-minute load average is above this")
    s.add_argument("--attempts", type=int, default=3, help="times to ask for one part before the video is left for the next run")
    s.add_argument("--retry-seconds", type=float, default=10, help="wait this many seconds times the attempt number before asking again")
    s.add_argument("--wait-for-model", type=float, default=1800, help="seconds to keep waiting for a model server that cannot be reached")
    s.add_argument("--report-every", type=int, default=10, help="print throughput every this many videos")
    s.add_argument("--coverage-out", help="atomically refresh coverage and source-row manifest after each progress report and at the end")
    s.set_defaults(run=command_extract)
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

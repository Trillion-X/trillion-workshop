#!/usr/bin/env python3
"""File the moments of spoken transcripts into topic buckets, with a local Ollama model and no spend.

  bucket_moments.py tag          --transcripts FOLDER [--vocabulary FILE] [--clips NAME ...] [--limit N] [--dry-out FILE] [--model M]
  bucket_moments.py tag-moments  --moments FILE.jsonl --tagged FILE.jsonl [--vocabulary FILE] [--limit N] [--model M]
  bucket_moments.py report       --transcripts FOLDER [--vocabulary FILE]

tag cuts each <name>.words.json into moments and writes them back into the file with their buckets and a relevance from 0 to 1.
tag-moments tags a file of moments ({"id", "text", ...} per line) and appends each to the tagged file as its batch finishes,
so a rerun skips what is done. The vocabulary (default <transcripts>/buckets.json or <tagged>.buckets.json) is DATA that
grows as the model proposes buckets. Every command prints its account, then one last line {"result": {...}}.
Needs Ollama running on this computer (https://ollama.com) with the model pulled.
"""
import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
import moments as m  # noqa: E402

DEFAULTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data", "bucketing-defaults.json")
WORDS_SUFFIX = ".words.json"


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, document, **options):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, **options)


def load_defaults(args):
    return read_json(args.defaults or DEFAULTS_FILE)


def load_vocabulary(path, defaults):
    return read_json(path) if os.path.exists(path) else m.new_vocabulary(defaults)


def ask(args, defaults, vocabulary, batch):
    """One chat with the local model: the vocabulary and the moments in, its JSON reply out."""
    listing = "\n".join(f"- {k}: {v['description']}" for k, v in vocabulary["buckets"].items())
    user = "Vocabulary:\n" + listing + "\n\nMoments:\n" + "\n".join(f'[{x["id"]}] {x["text"]}' for x in batch)
    body = {"model": args.model, "stream": False, "format": "json", "options": {"temperature": 0},
            "messages": [{"role": "system", "content": defaults["system_prompt"]}, {"role": "user", "content": user}]}
    request = urllib.request.Request(args.ollama_url.rstrip("/") + "/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=900) as answer:
        return json.loads(json.load(answer)["message"]["content"])


def tag_batch(args, defaults, vocabulary, batch):
    """Tag a batch, then ask again for each moment the reply left out, alone."""
    m.apply_reply(vocabulary, batch, ask(args, defaults, vocabulary, batch))
    for moment in [x for x in batch if x.get("untagged")]:
        moment.pop("untagged")
        moment.pop("relevance")
        m.apply_reply(vocabulary, [moment], ask(args, defaults, vocabulary, [moment]))


def transcript_paths(folder):
    return sorted(os.path.join(folder, name) for name in os.listdir(folder) if name.endswith(WORDS_SUFFIX))


def command_tag(args):
    if args.limit and not args.dry_out:
        sys.exit("--limit stops partway through a transcript, which would leave moments with no buckets in it; use it with --dry-out, which writes the moments to a separate file.")
    defaults = load_defaults(args)
    vocab_path = args.vocabulary or os.path.join(args.transcripts, "buckets.json")
    vocabulary = load_vocabulary(vocab_path, defaults)
    seen, filed = 0, []
    for path in transcript_paths(args.transcripts):
        name = os.path.basename(path)[:-len(WORDS_SUFFIX)]
        if args.clips and name not in args.clips:
            continue
        doc = read_json(path)
        if "segments" not in doc:
            print(name, "has no segments, left alone")
            continue
        if "moments" in doc and not args.dry_out:
            continue
        found = m.moments_of(doc, args.gap, args.max_words)
        for i, moment in enumerate(found):
            moment["id"] = i
        for i in range(0, len(found), args.batch):
            batch = found[i:i + args.batch]
            tag_batch(args, defaults, vocabulary, batch)
            seen += len(batch)
            if args.limit and seen >= args.limit:
                break
        for moment in found:
            moment["id"] = f'{name}#{moment["id"]}'
        if args.dry_out:
            with open(args.dry_out, "a", encoding="utf-8") as out:
                for moment in found:
                    out.write(json.dumps({"clip": name, **moment}, ensure_ascii=False) + "\n")
        else:
            by_segment = {si: moment for moment in found for si in moment["segments"]}
            for si, segment in enumerate(doc["segments"]):
                owner = by_segment[si]
                segment["moment"], segment["buckets"], segment["relevance"] = owner["id"], owner["buckets"], owner["relevance"]
            doc["moments"] = found
            write_json(path, doc)
            write_json(vocab_path, vocabulary, indent=1)
            print(name, len(found), "moments", flush=True)
        filed.append({"clip": name, "moments": len(found)})
        if args.limit and seen >= args.limit:
            break
    return {"clips": filed, "moments_tagged": seen, "vocabulary": vocab_path, "buckets_in_vocabulary": len(vocabulary["buckets"])}


def command_tag_moments(args):
    defaults = load_defaults(args)
    vocab_path = args.vocabulary or args.tagged + ".buckets.json"
    done = set()
    if os.path.exists(args.tagged):
        with open(args.tagged, encoding="utf-8") as handle:
            done = {json.loads(line)["id"] for line in handle}
    with open(args.moments, encoding="utf-8") as handle:
        todo = [x for x in map(json.loads, handle) if x["id"] not in done]
    if args.limit:
        todo = todo[:args.limit]
    vocabulary = load_vocabulary(vocab_path, defaults)
    with open(args.tagged, "a", encoding="utf-8") as out:
        for i in range(0, len(todo), args.batch):
            batch = todo[i:i + args.batch]
            work = [{"id": j, "text": x["text"]} for j, x in enumerate(batch)]
            tag_batch(args, defaults, vocabulary, work)
            for moment, tagged in zip(batch, work):
                moment["buckets"], moment["relevance"] = tagged["buckets"], tagged["relevance"]
                out.write(json.dumps(moment, ensure_ascii=False) + "\n")
            out.flush()
            write_json(vocab_path, vocabulary, indent=1)
    return {"moments_tagged": len(todo), "already_tagged": len(done), "tagged": args.tagged, "vocabulary": vocab_path}


def command_report(args):
    vocab_path = args.vocabulary or os.path.join(args.transcripts, "buckets.json")
    vocabulary = read_json(vocab_path)["buckets"]
    moments = [x for path in transcript_paths(args.transcripts) for x in read_json(path).get("moments", [])]
    counted = m.count_buckets(moments, vocabulary)
    print(counted["moments"], "moments", counted["untagged"], "untagged", counted["bands"])
    print(len(vocabulary), "buckets in vocabulary")
    for bucket, count, description in counted["per_bucket"]:
        print(count, bucket, "-", description[:70])
    return {**counted, "per_bucket": [{"bucket": b, "moments": c, "description": d} for b, c, d in counted["per_bucket"]],
            "buckets_in_vocabulary": len(vocabulary)}


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def model_options(p, model):
        p.add_argument("--model", default=model, help="the Ollama model (default %(default)s)")
        p.add_argument("--ollama-url", default="http://localhost:11434", help="where Ollama listens (default %(default)s)")
        p.add_argument("--defaults", help="a JSON file with system_prompt, seed_buckets and note_vocabulary instead of read-data/bucketing-defaults.json")
        p.add_argument("--vocabulary", help="the vocabulary file (read, and written back as it grows)")
        p.add_argument("--batch", type=int, default=m.BATCH, help="moments asked about at once (default %(default)s)")
        p.add_argument("--limit", type=int, default=0, help="stop after about this many moments (0 = all)")

    t = sub.add_parser("tag", help="cut transcripts into moments and write each moment's buckets and relevance into them")
    t.add_argument("--transcripts", required=True, help="the folder of <name>.words.json transcripts")
    t.add_argument("--clips", nargs="*", help="only these transcript names")
    t.add_argument("--dry-out", help="append the moments to this file instead of writing them into the transcripts (and tag again even if tagged)")
    t.add_argument("--gap", type=float, default=m.GAP_SECONDS, help="seconds of silence that end a moment (default %(default)s)")
    t.add_argument("--max-words", type=int, default=m.MAX_WORDS, help="words after which a moment ends (default %(default)s)")
    model_options(t, "qwen2.5:14b-instruct")
    t.set_defaults(run=command_tag)
    tm = sub.add_parser("tag-moments", help="tag a file of moments, one JSON per line, resumable")
    tm.add_argument("--moments", required=True)
    tm.add_argument("--tagged", required=True, help="the file the tagged moments are appended to")
    model_options(tm, "gemma3:4b")
    tm.set_defaults(run=command_tag_moments)
    r = sub.add_parser("report", help="moments per bucket and per relevance band")
    r.add_argument("--transcripts", required=True)
    r.add_argument("--vocabulary")
    r.set_defaults(run=command_report)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    result = args.run(args)
    print(json.dumps({"result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

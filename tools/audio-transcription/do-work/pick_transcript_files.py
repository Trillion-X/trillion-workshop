#!/usr/bin/env python3
"""Join the asset index's transcript files of one root to the namespace store by sha256 (read only).

  pick_transcript_files.py --assets assets.jsonl --root NAME --out LIST.tsv (--held HELD.json | --namespace-sqlite FILE)

asset index sha256 -> '12:<sha256>' alias -> '1f:' identity -> file row (origin, size). The asset index is JSON lines
{root, ext, name, display_path, sha256}. The store is the files door's answer, given as --held
{"aliases": {"<sha256>": "<identity>"}, "files": {"<identity>": {"origin", "byte_length"}}}, or a namespace sqlite copy
opened read only. Writes the list (kind, ext, origin, identity, bytes, sha256, display_path) that read_transcript_files.py
read-files takes and prints counts, then {"result": {...}}. No bytes are read here.
"""
import argparse, collections, json, os, re, sqlite3, sys, urllib.parse

LIVE = 9223372036854775807

TRANSCRIPT = re.compile(r"transcript|_raw\.|_cleaned_up|_clean\.|_rag\.|\.srt$|\.vtt$", re.I)


def kind_of(name, display):
    low = (display or name).lower()
    if low.endswith((".srt", ".vtt")):
        return "srt"
    if "_raw." in low:
        return "raw"
    if "_cleaned_up" in low or "_clean." in low:
        return "cleaned"
    if "_rag." in low:
        return "rag"
    return "transcript-named"


def held_from_sqlite(path):
    """The aliases and files a namespace sqlite copy holds now, read only."""
    STORE = "file:" + urllib.parse.quote(path) + "?mode=ro&immutable=1"    # the namespace sqlite copy
    db = sqlite3.connect(STORE, uri=True)
    alias = {i[3:]: json.loads(b)["identity"] for i, b in db.execute(
        "select id, body from versions where resource='@namespace/aliases' and valid_to=? and deleted=0", (LIVE,))}
    files = {i: json.loads(b) for i, b in db.execute(
        "select id, body from versions where resource='@namespace/files' and valid_to=? and deleted=0", (LIVE,))}
    return alias, files


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--assets", required=True, help="the asset index, JSON lines")
    parser.add_argument("--root", required=True, help="the root (drive or library) whose transcript files are taken")
    parser.add_argument("--out", required=True, help="the list to write")
    store = parser.add_mutually_exclusive_group(required=True)
    store.add_argument("--held", help="the files door's answer: {aliases, files}")
    store.add_argument("--namespace-sqlite", help="a namespace sqlite copy, opened read only")
    args = parser.parse_args(argv)
    if args.held:
        with open(args.held, encoding="utf-8") as handle:
            held = json.load(handle)
        alias, files = held.get("aliases", {}), held.get("files", {})
    else:
        alias, files = held_from_sqlite(args.namespace_sqlite)
    OUT = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(OUT, exist_ok=True)
    rows, stats = [], collections.Counter()
    for line in open(args.assets):
        r = json.loads(line)
        if r["root"] != args.root or r["ext"] not in ("srt", "vtt", "json", "txt"):
            continue
        name, display = r["name"], r.get("display_path") or ""
        if not (TRANSCRIPT.search(name) or "transcript" in display.lower()):
            continue
        k = kind_of(name, display)
        ident = alias.get(r["sha256"]) or (f"1f:{r['sha256']}" if f"1f:{r['sha256']}" in files else None)
        f = files.get(ident) if ident else None
        origin = f["origin"] if f else "missing"
        stats[(k, origin)] += 1
        rows.append((k, r["ext"], origin, ident or "", f["byte_length"] if f else "", r["sha256"], display or name))
    with open(args.out, "w") as out:
        out.write("kind\text\torigin\tidentity\tbytes\tsha256\tdisplay_path\n")
        for row in rows:
            out.write("\t".join(str(c) for c in row) + "\n")
    print(len(rows), "transcript-like files")
    for (k, o), n in sorted(stats.items()):
        print(k, o, n)
    print(json.dumps({"result": {"files": len(rows), "list": args.out,
                                 "by_kind_and_origin": {f"{k} {o}": n for (k, o), n in sorted(stats.items())}}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

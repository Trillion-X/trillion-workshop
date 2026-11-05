#!/usr/bin/env python3
"""Split cloud-results transcripts into moments (text only, no timing in the source).

  cut_text_into_moments.py --results-sqlite FILE (--held HELD.json | --namespace-sqlite FILE) --out moments.jsonl [--max-words N]

Reads a cloud-results sqlite copy read only (table results: identity, kind, value; kinds transcript {text}, library-entry
{name, path, media_kind} and facts {duration}) and the person's file store for each transcript's origin: the files door's
answer as --held {"aliases": {"<sha256>": "<identity>"}, "files": {"<identity>": {"origin"}}}, or a namespace sqlite copy
opened read only. Writes one line per moment with
{id, identity, name, path, media_kind, duration, source: b2|r2|drive-only, text, frac_start, frac_end,
 est_start, est_end, timing: "estimated-from-text-position", duplicates:[identity...]}.
Identical transcripts (raw/cleaned copies) are kept once, listing the other identities. Prints the coverage (moments per
source, transcripts per source and media kind, hours of media with known duration), then {"result": {...}}.
"""
import argparse, collections, hashlib, json, os, re, sqlite3, sys, urllib.parse

LIVE = 9223372036854775807
MAX_WORDS = 120


def sentences(text):
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


def chunks(text):
    out, cur, n = [], [], 0
    for s in sentences(text):
        w = len(s.split())
        if cur and n + w > MAX_WORDS:
            out.append(" ".join(cur)); cur, n = [], 0
        cur.append(s); n += w
    if cur:
        out.append(" ".join(cur))
    return out


def held_store(args):
    """{sha256: identity} and {identity: origin}: from the files door's answer, or a namespace sqlite copy read only."""
    if args.held:
        with open(args.held, encoding="utf-8") as handle:
            held = json.load(handle)
        return held.get("aliases", {}), {i: f.get("origin") for i, f in held.get("files", {}).items()}
    STORE = "file:" + urllib.parse.quote(args.namespace_sqlite) + "?mode=ro&immutable=1"    # the namespace sqlite copy
    store = sqlite3.connect(STORE, uri=True)
    alias = {i[3:]: json.loads(b)["identity"] for i, b in store.execute(
        "select id, body from versions where resource='@namespace/aliases' and valid_to=? and deleted=0", (LIVE,))}
    origin = {i: json.loads(b)["origin"] for i, b in store.execute(
        "select id, body from versions where resource='@namespace/files' and valid_to=? and deleted=0", (LIVE,))}
    return alias, origin


def main(argv=None):
    global MAX_WORDS
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--results-sqlite", required=True, help="the cloud-results sqlite copy, opened read only")
    store_given = parser.add_mutually_exclusive_group(required=True)
    store_given.add_argument("--held", help="the files door's answer: {aliases, files}")
    store_given.add_argument("--namespace-sqlite", help="a namespace sqlite copy, opened read only")
    parser.add_argument("--out", required=True, help="the moments file (JSON lines) to write")
    parser.add_argument("--max-words", type=int, default=MAX_WORDS, help="the most words in one moment (default 120)")
    args = parser.parse_args(argv)
    MAX_WORDS = args.max_words
    CLOUD = "file:" + urllib.parse.quote(args.results_sqlite) + "?mode=ro&immutable=1"    # the cloud-results.sqlite copy
    cloud = sqlite3.connect(CLOUD, uri=True)
    alias, origin = held_store(args)
    entry = {i: json.loads(v) for i, v in cloud.execute("select identity, value from results where kind='library-entry'")}
    facts = {i: json.loads(v) for i, v in cloud.execute("select identity, value from results where kind='facts'")}
    seen, kept, n_files, n_moments, by_source = {}, [], 0, 0, {}
    for ident, value in cloud.execute("select identity, value from results where kind='transcript' order by identity"):
        text = (json.loads(value).get("text") or "").strip()
        if len(text.split()) < 3:
            continue
        key = hashlib.blake2b(text.encode(), digest_size=16).hexdigest()
        if key in seen:
            seen[key].append(ident); continue
        seen[key] = dups = []
        kept.append((ident, text, dups))
    # Coverage, as the moments are written: moments per source, distinct transcripts per source and media kind, hours.
    tr, mo, hours = collections.Counter(), collections.Counter(), 0.0
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as out:
        for ident, text, dups in kept:
            h = ident.split(":", 1)[1]
            file_id = alias.get(h) or (f"1f:{h}" if f"1f:{h}" in origin else None)
            src = {"backblaze-b2": "b2", "cloudflare-r2": "r2"}.get(origin.get(file_id), "drive-only")
            e, dur = entry.get(ident, {}), facts.get(ident, {}).get("duration")
            parts = chunks(text)
            total = sum(len(p) for p in parts) or 1
            pos = 0
            n_files += 1
            by_source[src] = by_source.get(src, 0) + 1
            tr[(src, e.get("media_kind"))] += 1; hours += (dur or 0) / 3600
            for i, p in enumerate(parts):
                a, b = pos / total, (pos + len(p)) / total
                pos += len(p)
                out.write(json.dumps({"id": f"x{h[:12]}#{i}", "identity": ident, "name": e.get("name"), "path": e.get("path"),
                                      "media_kind": e.get("media_kind"), "duration": dur, "source": src, "text": p,
                                      "frac_start": round(a, 4), "frac_end": round(b, 4),
                                      "est_start": round(a * dur, 1) if dur else None, "est_end": round(b * dur, 1) if dur else None,
                                      "timing": "estimated-from-text-position", "duplicates": dups}, ensure_ascii=False) + "\n")
                n_moments += 1
                mo[src] += 1
    print(n_files, "distinct transcripts", n_moments, "moments", by_source, sum(len(v) for v in seen.values()), "duplicate copies dropped")
    print(dict(mo), round(hours, 1), "hours of media with known duration")
    for k, v in sorted(tr.items(), key=str):
        print(k, v)
    print(json.dumps({"result": {
        "moments": args.out, "transcripts": n_files, "moments_written": n_moments, "by_source": by_source,
        "moments_by_source": dict(mo), "transcripts_by_source_and_kind": {f"{s} {k}": v for (s, k), v in sorted(tr.items(), key=str)},
        "hours_with_known_length": round(hours, 1), "duplicates_dropped": sum(len(v) for v in seen.values())}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

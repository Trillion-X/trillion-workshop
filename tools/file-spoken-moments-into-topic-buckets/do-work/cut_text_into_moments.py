"""Split cloud-results transcripts into moments (text only, no timing in the source).

Reads the cloud-results.sqlite copy (CLOUD_RESULTS) read-only and the namespace store (TRILLION_NAMESPACE) for
the copy's place, both as the place running this reports it holds them. Writes library/transcripts/expansion/moments.jsonl: one line per moment with
{id, identity, name, path, media_kind, duration, source: b2|r2|drive-only, text, frac_start, frac_end,
 est_start, est_end, timing: "estimated-from-text-position", duplicates:[identity...]}.
Identical transcripts (raw/cleaned copies) are kept once, listing the other identities.
"""
import hashlib, json, os, re, sqlite3, urllib.parse

import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[1])  # this repository, wherever this place keeps it
# Stores are held by places, not by one computer: each root below is what the place running this reports it holds.
CLOUD = "file:" + urllib.parse.quote(os.environ["CLOUD_RESULTS"]) + "?mode=ro&immutable=1"    # the cloud-results.sqlite copy
STORE = "file:" + urllib.parse.quote(os.environ["TRILLION_NAMESPACE"]) + "?mode=ro&immutable=1"    # the namespace sqlite copy
OUT = CHECKOUT + "/library/transcripts/drive"
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


def main():
    cloud = sqlite3.connect(CLOUD, uri=True)
    store = sqlite3.connect(STORE, uri=True)
    alias = {i[3:]: json.loads(b)["identity"] for i, b in store.execute(
        "select id, body from versions where resource='@namespace/aliases' and valid_to=? and deleted=0", (LIVE,))}
    origin = {i: json.loads(b)["origin"] for i, b in store.execute(
        "select id, body from versions where resource='@namespace/files' and valid_to=? and deleted=0", (LIVE,))}
    entry = {i: json.loads(v) for i, v in cloud.execute("select identity, value from results where kind='library-entry'")}
    facts = {i: json.loads(v) for i, v in cloud.execute("select identity, value from results where kind='facts'")}
    seen, n_files, n_moments, by_source = {}, 0, 0, {}
    os.makedirs(OUT, exist_ok=True)
    with open(OUT + "/moments.jsonl", "w") as out:
        for ident, value in cloud.execute("select identity, value from results where kind='transcript' order by identity"):
            text = (json.loads(value).get("text") or "").strip()
            if len(text.split()) < 3:
                continue
            key = hashlib.blake2b(text.encode(), digest_size=16).hexdigest()
            if key in seen:
                seen[key].append(ident); continue
            seen[key] = dups = []
            h = ident.split(":", 1)[1]
            file_id = alias.get(h) or (f"1f:{h}" if f"1f:{h}" in origin else None)
            src = {"backblaze-b2": "b2", "cloudflare-r2": "r2"}.get(origin.get(file_id), "drive-only")
            e, dur = entry.get(ident, {}), facts.get(ident, {}).get("duration")
            parts = chunks(text)
            total = sum(len(p) for p in parts) or 1
            pos = 0
            n_files += 1
            by_source[src] = by_source.get(src, 0) + 1
            for i, p in enumerate(parts):
                a, b = pos / total, (pos + len(p)) / total
                pos += len(p)
                out.write(json.dumps({"id": f"x{h[:12]}#{i}", "identity": ident, "name": e.get("name"), "path": e.get("path"),
                                      "media_kind": e.get("media_kind"), "duration": dur, "source": src, "text": p,
                                      "frac_start": round(a, 4), "frac_end": round(b, 4),
                                      "est_start": round(a * dur, 1) if dur else None, "est_end": round(b * dur, 1) if dur else None,
                                      "timing": "estimated-from-text-position", "duplicates": dups}, ensure_ascii=False) + "\n")
                n_moments += 1
    print(n_files, "distinct transcripts", n_moments, "moments", by_source, sum(len(v) for v in seen.values()), "duplicate copies dropped")


main()

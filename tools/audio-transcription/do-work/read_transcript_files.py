"""Parse a drive's transcript files read from B2 (srt, vtt, json, txt) into the common words.json shape.

Reads library/transcripts/drive/b2-only.tsv and b2-bytes/<hex>.<ext>; writes b2/<hex>.words.json with
{source, root:"drive", origin:"b2", identity, kind, timing: word|segment|none, duration, words, segments}.
"""
import html, json, os, re

import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[1])  # this repository, wherever this place keeps it
D = CHECKOUT + "/library/transcripts/drive"
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


def main():
    os.makedirs(D + "/b2", exist_ok=True)
    counts = {}
    for line in list(open(D + "/b2-only.tsv"))[1:]:
        kind, ext, origin, ident, nbytes, sha, display = line.rstrip("\n").split("\t")
        hexid = ident.split(":", 1)[1]
        p = f"{D}/b2-bytes/{hexid}.{ext}"
        if not os.path.exists(p) or os.path.exists(f"{D}/b2/{hexid}.words.json"):
            continue
        r = parse(p, ext)
        doc = {"source": r["source"] or display, "display_path": display, "root": "drive", "origin": "b2", "identity": ident,
               "kind": kind, "timing": r["timing"], "duration": r["duration"], "words": r["words"], "segments": r["segments"]}
        if r["text"]:
            doc["text"] = r["text"]
        json.dump(doc, open(f"{D}/b2/{hexid}.words.json", "w"), ensure_ascii=False)
        counts[(ext, r["timing"])] = counts.get((ext, r["timing"]), 0) + 1
    for k, v in sorted(counts.items()):
        print(k, v)


main()

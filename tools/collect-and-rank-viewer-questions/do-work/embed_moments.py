"""Builds the searchable list of things the person said and embeds it.

usage: embed_moments.py <transcripts-dir> <moments.tsv | -> <out-dir>
Sources:
  1. <transcripts-dir>/*.words.json (words with text, start, end; root is where the recording is): real word times. Words are cut into sentences at . ? !
     (short ones merged forward, long ones cut at 45 words); time_basis "word".
  2. <moments.tsv> (optional, - for none: clip, start_s, end_s, text, transcript_source, media_location): older recordings
     whose times are estimated from character position (transcript_source holds est-from-duration); time_basis "estimated".
Whisper loop output ("a little bit of a little bit...") is dropped by a unique-word ratio test.
Writes <out-dir>/moments.jsonl (clip, from, to, quote, time_basis, media_location) and moments.npy (bge-small-en-v1.5, normalized).
The last line printed is {"result": {moments, out}}.
"""
import csv
import glob
import json
import os
import sys

import numpy as np
from sentence_transformers import SentenceTransformer

MIN_WORDS = 8
MAX_WORDS = 45


def distinct_enough(text):
    words = text.lower().split()
    return len(words) >= MIN_WORDS and len(set(words)) / len(words) >= 0.55


def sentences(words):
    current = []
    for word in words:
        current.append(word)
        ends = word["text"].rstrip().endswith((".", "?", "!"))
        if (ends and len(current) >= MIN_WORDS) or len(current) >= MAX_WORDS:
            yield current
            current = []
    if len(current) >= MIN_WORDS:
        yield current


def main():
    transcripts, slate, out_dir = sys.argv[1:4]
    rows = []
    for path in sorted(glob.glob(transcripts + "/*.words.json")):
        clip = os.path.basename(path).removesuffix(".words.json")
        document = json.load(open(path))
        for chunk in sentences(document["words"]):
            quote = " ".join(word["text"] for word in chunk)
            if distinct_enough(quote):
                rows.append({"clip": clip, "from": round(chunk[0]["start"], 2), "to": round(chunk[-1]["end"], 2),
                             "quote": quote, "time_basis": "word", "media_location": document.get("root")})
    table = open(slate).read().replace("\x00", "").splitlines() if slate != "-" else []
    for row in csv.DictReader(table, delimiter="\t"):
        if not row["start_s"] or not row["end_s"]:
            continue
        quote = " ".join(row["text"].split()[:60])
        if distinct_enough(quote):
            rows.append({"clip": row["clip"], "from": float(row["start_s"]), "to": float(row["end_s"]), "quote": quote,
                         "time_basis": "estimated" if "est-from-duration" in row["transcript_source"] else "transcript",
                         "media_location": row["media_location"]})
    seen = set()
    unique = []
    for row in rows:
        key = row["quote"].lower()
        if key not in seen:
            seen.add(key)
            unique.append(row)
    print(len(unique), "moments", file=sys.stderr)
    model = SentenceTransformer("BAAI/bge-small-en-v1.5")
    vectors = model.encode([row["quote"] for row in unique], batch_size=128, normalize_embeddings=True, show_progress_bar=False)
    os.makedirs(out_dir, exist_ok=True)
    np.save(out_dir + "/moments.npy", vectors.astype(np.float32))
    with open(out_dir + "/moments.jsonl", "w") as out:
        for row in unique:
            out.write(json.dumps(row) + "\n")
    print(json.dumps({"result": {"moments": len(unique), "out": out_dir}}))


main()

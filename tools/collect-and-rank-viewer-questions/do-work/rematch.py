"""
import json
import sys

import numpy as np
import torch
from sentence_transformers import CrossEncoder, SentenceTransformer

POOL = 40
KEEP = 0.5
PER_QUESTION = 3
PREFIX = "Represent this sentence for searching relevant passages: "


def reach(source, timing):
    if source == "ssd":
        return "ssd-cuttable-now"
    if source == "b2":
        return "word-timed" if timing == "word" else "b2-needs-word-timing"
    if source == "r2":
        return "word-timed" if timing == "word" else "r2-needs-word-timing"
    return "drive-only"


def main():
    root, tagged = sys.argv[1:3]
    pool = []
    for line in open(root + "/raw/moments/moments.jsonl"):
        row = json.loads(line)
        ssd = row["time_basis"] == "word"
        pool.append({"clip": row["clip"], "from": row["from"], "to": row["to"], "quote": row["quote"],
                     "time_basis": row["time_basis"], "media_location": row["media_location"],
                     "reach": "ssd-cuttable-now" if ssd else "drive-only", "origin": "slate-moments"})
    old_count = len(pool)

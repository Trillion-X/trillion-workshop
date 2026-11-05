"""Builds library/viewer-questions/questions.json from the hand-picked candidates.

usage: build_library.py <viewer-questions-dir> <tools-dir> <icp-file>
Inputs (all under <dir>/raw unless noted): candidates.tsv, reddit.jsonl, moments.jsonl + moments.npy;
<tools-dir>: picks.txt (candidate id, bucket code, kind), icp_inferred.tsv, asker_overrides.json; the ICP file the
inferred questions were read from (named in each source as <icp-file>:<line>).
A question is always the asker's verbatim sentence. Frequency is measured, not guessed: how many other
sentences in the whole sample (every candidate from 25 subreddits and 8 YouTube videos) mean nearly the same thing,
plus the post's score and comment count or the comment's likes.
"""
import json
import re
import sys

import numpy as np
import torch
from sentence_transformers import CrossEncoder, SentenceTransformer

SIMILAR = 0.82
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
MOMENT_MIN = 0.25
RERANK_POOL = 40
MOMENTS_PER_QUESTION = 3
CODES = {
    "UN": "unawareness-what-am-i-missing", "PO": "synthetic-d3a3f445d9a6-imsynthetic-d3a3f445d9a6", "OT": "synthetic-46ee21bed239-threats",
    "CU": "curiosity-and-avoidance", "FO": "focus-distraction-action-inaction", "SK": "skills-and-anti-skills",
    "GO": "goals-and-anti-goals", "VA": "values-and-anti-values", "PA": "passions-and-anti-passions",
    "PH": "physical", "ME": "mental", "EM": "emotional", "AN": "animate-people-and-relationships",
    "IN": "inanimate-instruments-and-resources",
}
KINDS = {"q": "question", "i": "issue", "p": "problem", "d": "dream", "o": "outcome"}
LEAD = re.compile(r"^(and|but|so|or|also|plus|hi everyone,?|guys,?|hey,?|ok,?|okay,?)\s+", re.I)


def asker_line(question):
    line = re.sub(r"[\\*_`>]+", "", question)
    line = re.sub(r"\s+", " ", line).strip(" -,;:\"'")
    line = LEAD.sub("", line)
    line = re.sub(r"\s+\?$", "?", line)
    line = line[0].upper() + line[1:]
    return line


def main():
    root, tools, icp_file = sys.argv[1:4]
    raw = root + "/raw"
    candidates = {}
    for line in open(raw + "/candidates.tsv"):
        index, kind, url, segment, score, question = line.rstrip("\n").split("\t")
        candidates[index] = {"kind": kind, "url": url, "segment": segment, "score": int(score), "question": question}
    comments = {}
    for line in open(raw + "/reddit.jsonl"):
        post = json.loads(line)
        comments["https://www.reddit.com" + (post["permalink"] or "")] = post["num_comments"] or 0
    overrides = json.load(open(tools + "/asker_overrides.json"))

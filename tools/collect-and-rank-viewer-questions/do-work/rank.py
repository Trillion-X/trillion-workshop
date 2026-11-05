"""First-pass sort of candidates into AA buckets for reading.

usage: rank.py <buckets.json> <candidates.tsv> <per-bucket> > ranked.tsv
Assigns each candidate the bucket whose regexes hit most (ties: first listed), then prints the top N per bucket by
score and by how many bucket hits it has. This only orders the reading list; the written questions.json is chosen by hand.
"""
import json
import re
import sys

buckets = json.load(open(sys.argv[1]))["buckets"]
compiled = {name: [re.compile(p, re.I) for p in patterns] for name, patterns in buckets.items()}
limit = int(sys.argv[3])
groups = {name: [] for name in buckets}
for line in open(sys.argv[2]):
    index, kind, url, segment, score, question = line.rstrip("\n").split("\t")
    hits = {name: sum(1 for p in ps if p.search(question)) for name, ps in compiled.items()}
    best = max(hits, key=lambda name: hits[name])
    if hits[best] == 0:
        continue
    groups[best].append((hits[best], int(score), index, kind, segment, url, question))
for name, items in groups.items():
    items.sort(key=lambda row: (-row[0], -row[1]))
    for hits, score, index, kind, segment, url, question in items[:limit]:
        print(f"{index}\t{name}\t{kind}\t{segment}\t{score}\t{question}")

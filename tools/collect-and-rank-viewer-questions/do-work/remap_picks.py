"""Rewrites picks.txt and asker_overrides.json ids after candidates.tsv was regenerated with more sources.

usage: remap_picks.py <old-candidates.tsv> <new-candidates.tsv> <picks.txt> <asker_overrides.json>
An id keeps its meaning by question text + source URL; a pick whose text no longer exists stops the run.
"""
import json
import sys

old, new, picks_path, overrides_path = sys.argv[1:5]


def read(path):
    rows = {}
    for line in open(path):
        index, _kind, url, _segment, _score, question = line.rstrip("\n").split("\t")
        rows[index] = (url, question)
    return rows


old_rows, new_rows = read(old), read(new)
by_text = {value: index for index, value in new_rows.items()}
mapping = {index: by_text[value] for index, value in old_rows.items() if value in by_text}
lines = []
for line in open(picks_path):
    if line.startswith("#") or not line.strip():
        lines.append(line)
        continue
    index, code, kind = line.split()
    lines.append(f"{mapping[index]} {code} {kind}\n")
open(picks_path, "w").writelines(lines)
overrides = json.load(open(overrides_path))
json.dump({mapping[k]: v for k, v in overrides.items()}, open(overrides_path, "w"), indent=2, ensure_ascii=False)
print("remapped", sum(1 for k, v in mapping.items() if k != v), "ids")

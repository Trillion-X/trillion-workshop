"""Rewrites picks.txt and asker_overrides.json ids after candidates.tsv was regenerated with more sources.

usage: remap_picks.py <old-candidates.tsv> <new-candidates.tsv> <picks.txt> [<asker_overrides.json>]
An id keeps its meaning by question text + source URL; a pick whose text no longer exists stops the run.
<asker_overrides.json> is {candidate id: asker line}, or a settings file holding it as asker_overrides (the ids there are
rewritten in place); give the settings row's settings, then write them back to the row.
The last line printed is {"result": {remapped}}, or {"error": ...} naming a pick that is gone.
"""
import json
import sys

old, new, picks_path = sys.argv[1:4]
overrides_path = sys.argv[4] if len(sys.argv) > 4 else None


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
    if index not in mapping:
        print(json.dumps({"error": f"Pick {index} names a question no longer among the new candidates: pick it again."}))
        sys.exit(2)
    lines.append(f"{mapping[index]} {code} {kind}\n")
open(picks_path, "w").writelines(lines)
if overrides_path:
    held = json.load(open(overrides_path))
    overrides = held.get("asker_overrides", held) if isinstance(held.get("asker_overrides"), dict) else held
    remapped = {mapping[k]: v for k, v in overrides.items()}
    if overrides is not held:
        held["asker_overrides"] = remapped
        remapped = held
    json.dump(remapped, open(overrides_path, "w"), indent=2, ensure_ascii=False)
print("remapped", sum(1 for k, v in mapping.items() if k != v), "ids", file=sys.stderr)
print(json.dumps({"result": {"remapped": sum(1 for k, v in mapping.items() if k != v)}}))

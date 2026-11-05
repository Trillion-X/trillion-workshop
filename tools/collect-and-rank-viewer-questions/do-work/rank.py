"""First-pass sort of candidates into AA buckets for reading.

usage: rank.py <settings.json> <candidates.tsv> <per-bucket> [<ranked.tsv>]
<settings.json> holds the person's settings row (or the settings): `buckets` maps each of their bucket names to its
regexes, in the order ties go to. Assigns each candidate the bucket whose regexes hit most (ties: first listed), then prints the top N per bucket by
score and by how many bucket hits it has. This only orders the reading list; the written questions.json is chosen by hand.
Without <ranked.tsv> the lines go to standard output; the last line printed is {"result": {ranked, per_bucket}}.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "settings", "read-data"))
import settings as person_settings  # noqa: E402

FOLDER = "collect-and-rank-viewer-questions"
TOOL = "tool:collect-and-rank-viewer-questions"


def settings_from(path):
    """The person's settings for this tool, read through tools/settings: a JSON file holding their list:settings row as
    the door read it ({id, type: "record:setting", value}, id record:setting:collect-and-rank-viewer-questions~<scope_kind>~
    <scope_id>), or a JSON file of the settings themselves."""
    given = json.load(open(path))
    if not isinstance(given, dict) or not ("value" in given or "records" in given or "settings" in given):
        return given if isinstance(given, dict) else {}
    try:
        if "id" in given and person_settings.parse_id(given["id"])[0] != FOLDER:
            raise person_settings.SettingError(f"{given['id']} holds the settings of another tool: give this tool's own row (record:setting:{FOLDER}~<scope_kind>~<scope_id>).")
        return person_settings.setting(given, FOLDER, default={}, tool=TOOL) or {}
    except person_settings.SettingError as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)


buckets = settings_from(sys.argv[1]).get("buckets")
if not isinstance(buckets, dict) or not buckets:
    print(json.dumps({"error": "The settings hold no buckets: give `buckets`, {bucket name: [regex, ...]}, in the person's settings row."}))
    sys.exit(2)
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
out = open(sys.argv[4], "w") if len(sys.argv) > 4 else sys.stdout
counts = {}
for name, items in groups.items():
    counts[name] = min(len(items), limit)
    items.sort(key=lambda row: (-row[0], -row[1]))
    for hits, score, index, kind, segment, url, question in items[:limit]:
        print(f"{index}\t{name}\t{kind}\t{segment}\t{score}\t{question}", file=out)
if out is not sys.stdout:
    out.close()
print(json.dumps({"result": {"ranked": sum(counts.values()), "per_bucket": counts}}))

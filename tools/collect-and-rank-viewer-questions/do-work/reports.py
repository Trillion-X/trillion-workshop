"""Prints the questions worth a closer look: recurring, high-engagement, or with a strong answer moment.

usage: shortlist.py <questions.json>
"""
import json
import sys

for entry in json.load(open(sys.argv[1]))["questions"]:
    frequency = entry["frequency_estimate"]
    strong = [m for m in entry["answer_moments"] if m["match_quality"] == "strong"]
    similar = frequency["similar_in_sample"] if frequency else 0
    engagement = frequency["engagement"] if frequency else {}
    interest = similar + len(strong) * 3 + (1 if entry["evidence"] == "inferred" else 0)
    if similar >= 2 or strong or engagement.get("comment_likes", 0) >= 100:
        print(f"{entry['id']} sim={similar} eng={engagement} strong={len(strong)} [{entry['bucket'][:10]}] {entry['asker_line'][:120]}")

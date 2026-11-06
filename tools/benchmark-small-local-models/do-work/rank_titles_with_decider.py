"""Rank YouTube title candidates with decider-2b: one yes/no per title, P(yes) used only as a ranking.
usage: rank_titles.py <final.json {ref_id: title}> <out.json> [question]"""
"""As first run that was its command line (rank_titles.py was this script); here it is one JSON request:
  python3 tools/benchmark-small-local-models/do-work/rank_titles_with_decider.py <request.json>   (or stdin)

Request: titles ({ ref_id: title }, or its file), question (the yes/no question asked of each title, the person's own),
model (a decider-style choice classifier snapshot), device (optional), write_to.
Answer: { result: { meta, ranked: [{ ref, title, p_yes }] } }, best first."""
import json, sys, time, resource
from pathlib import Path
import torch
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"read-data")); import computer
R = computer.request(); MODEL = computer.need(R, "model")
titles = computer.json_of(computer.need(R, "titles"), "titles")
Q = computer.need(R, "question")
d, load_s = computer.load_decider(MODEL)
reqs = [(f"A YouTube video title:\n\"{t}\"", [{"question": Q, "options": ["no", "yes"]}]) for t in titles.values()]
t0 = time.time(); out = []
for k in range(0, len(reqs), 8):
    out += d.decide_batch(reqs[k:k+8])
el = time.time() - t0
rows = sorted(({"ref": r, "title": t, "p_yes": round(o[0]["probs"]["yes"], 4)} for (r, t), o in zip(titles.items(), out)),
              key=lambda x: -x["p_yes"])
meta = {"model": MODEL, "question": Q, "load_s": round(load_s, 1), "ms_per_decision": round(1000*el/len(reqs)),
        "mps_GB": computer.mps_gb(computer.device()), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9, 2)}
for x in rows: print(x["p_yes"], x["title"])
print(meta)
computer.answer({"meta": meta, "ranked": rows})

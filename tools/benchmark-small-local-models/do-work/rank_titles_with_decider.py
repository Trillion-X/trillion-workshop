"""Rank YouTube title candidates with decider-2b: one yes/no per title, P(yes) used only as a ranking.
usage: rank_titles.py <final.json {ref_id: title}> <out.json> [question]"""
import json, sys, time, resource
from pathlib import Path
import torch
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"lib"))
from dec import load
titles = json.load(open(sys.argv[1]))
Q = sys.argv[3] if len(sys.argv) > 3 else "Would a viewer interested in fitness and food click this title?"
d, load_s = load()
reqs = [(f"A YouTube video title:\n\"{t}\"", [{"question": Q, "options": ["no", "yes"]}]) for t in titles.values()]
t0 = time.time(); out = []
for k in range(0, len(reqs), 8):
    out += d.decide_batch(reqs[k:k+8])
el = time.time() - t0
rows = sorted(({"ref": r, "title": t, "p_yes": round(o[0]["probs"]["yes"], 4)} for (r, t), o in zip(titles.items(), out)),
              key=lambda x: -x["p_yes"])
meta = {"model": "Mapika/decider-2b", "question": Q, "load_s": round(load_s, 1), "ms_per_decision": round(1000*el/len(reqs)),
        "mps_GB": round(torch.mps.driver_allocated_memory()/1e9, 2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9, 2)}
json.dump({"meta": meta, "ranked": rows}, open(sys.argv[2], "w"), indent=1, ensure_ascii=False)
for x in rows: print(x["p_yes"], x["title"])
print(meta)

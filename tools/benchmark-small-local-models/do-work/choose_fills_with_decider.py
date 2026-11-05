"""Stage B with decider-2b: choose one option per slot (choice question), plus 'none fits' and 'escalate'."""
import json, sys, time, resource
from pathlib import Path
import torch
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[3])  # this repository, wherever this place keeps it
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"lib"))
from dec import load
LISTING = json.load(open(pathlib.Path(CHECKOUT) / "library/fills/_catalog/listings/workflow-listing.json"))
COND = sys.argv[1] if len(sys.argv) > 1 else "bge-reranker-v2-m3"
O = json.load(open(H/f"options-{COND}.json"))["slots"]
NONE, ESC = "none of these is a true value for this blank; leave it empty", "escalate to a bigger model"
d, load_s = load()
res = {}; times = []
for sid, s in O.items():
    state = {"what is being launched": {"title": LISTING["title"], "job": LISTING["job"], "steps": LISTING["steps"]},
             "script line with a blank": s["line"].replace(f"[{sid}]", "___"),
             "the blank": f"a {s['type']}: {s['note']}",
             "rule": "Only a candidate that is literally true of what is being launched may fill the blank. The other words of the line stay as they are."}
    opts = [o["text"] for o in s["options"]] + [NONE, ESC]
    q = [{"question": "Which candidate should fill the blank?", "options": opts},
         {"question": "Does any candidate fit the blank truthfully and grammatically?", "options": ["no", "yes"]}]
    t = time.time(); r = d.decide(json.dumps(state), q); times.append(time.time() - t)
    probs = r[0]["probs"]
    res[sid] = {"choice": r[0]["choice"], "confidence": round(r[0]["confidence"], 4),
                "index": opts.index(r[0]["choice"]), "any_fits_yes": round(r[1]["probs"].get("yes", 0), 4),
                "top3": sorted(probs.items(), key=lambda x: -x[1])[:3]}
    print(sid, "->", r[0]["choice"], round(r[0]["confidence"], 3), "| any fits P(yes)=", round(r[1]["probs"].get("yes",0),3))
meta = {"model": "Mapika/decider-2b v10", "load_s": round(load_s,1), "ms_per_request_median": round(1000*sorted(times)[len(times)//2]), "ms_first": round(1000*times[0]),
        "mps_GB": round(torch.mps.driver_allocated_memory()/1e9,2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2)}
json.dump({"meta": meta, "choices": res}, open(H/f"choice-decider-{COND}.json","w"), indent=1); print(meta)

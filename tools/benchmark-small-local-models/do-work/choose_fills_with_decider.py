"""Stage B with decider-2b: choose one option per slot (choice question), plus 'none fits' and 'escalate'."""
"""
  python3 tools/benchmark-small-local-models/do-work/choose_fills_with_decider.py <request.json>   (or stdin)

Request: options (make_typed_options.py's or rank_pool_for_blanks.py's answer, or its file), listing (what is being
launched: { title, job, steps }, or its file), model (a decider-style choice classifier snapshot in the Hugging Face cache), device (optional), write_to.
Answer: { result: { meta, choices: { slot id: { choice, confidence, index, any_fits_yes, top3 } } } }."""
import json, sys, time, resource
from pathlib import Path
import torch
import pathlib
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"read-data")); import computer
R = computer.request(); MODEL = computer.need(R, "model")
def load(): return computer.load_decider(MODEL)
LISTING = computer.json_of(computer.need(R, "listing"), "listing")
O = computer.json_of(computer.need(R, "options"), "options")["slots"]
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
meta = {"model": MODEL, "load_s": round(load_s,1), "ms_per_request_median": round(1000*sorted(times)[len(times)//2]), "ms_first": round(1000*times[0]),
        "mps_GB": computer.mps_gb(computer.device()), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2)}
print(meta)
computer.answer({"meta": meta, "choices": res})

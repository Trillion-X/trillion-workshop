"""Stage B, yes/no shape: decider-2b judges each FILLED line (one yes/no per candidate, batched).
Pick the candidate with the highest P(yes); if it is under the threshold the slot stays empty (abstain -> Opus)."""
"""
  python3 tools/benchmark-small-local-models/do-work/judge_filled_lines_with_decider.py <request.json>   (or stdin)

Request: options (make_typed_options.py's or rank_pool_for_blanks.py's answer, or its file), listing (what is being
launched: { title, job, steps }, or its file), model (a decider-style choice classifier snapshot), product (the product the listing is in), device (optional), write_to.
Answer: { result: { meta, choices: { slot id: { choice, p_yes, ranked: [[p, text]] } } } }."""
import json, sys, time, resource
from pathlib import Path
import torch
import pathlib
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"read-data")); import computer
R = computer.request(); MODEL = computer.need(R, "model")
def load(): return computer.load_decider(MODEL)
LISTING = computer.json_of(computer.need(R, "listing"), "listing")
O = computer.json_of(computer.need(R, "options"), "options")["slots"]
d, load_s = load()
facts = f"What is being launched: '{LISTING['title']}', a workflow in the product {computer.need(R, 'product')}. {LISTING['job']} Steps: {'; '.join(LISTING['steps'])}."
res = {}; tt = 0; n = 0
for sid, s in O.items():
    reqs = []
    for o in s["options"]:
        filled = s["line"].replace(f"[{sid}]", o["text"])
        reqs.append((f"{facts}\nA founder will say this line in a launch video:\n\"{filled}\"",
                     [{"question": f"Is the inserted words '{o['text']}' a correct {s['type'].lower()} ({s['note']}) that is true of what is being launched?", "options": ["no", "yes"]}]))
    t = time.time(); out = []
    for k in range(0, len(reqs), 8):
        out += d.decide_batch(reqs[k:k+8])
    tt += time.time() - t; n += len(reqs)
    py = [r[0]["probs"]["yes"] for r in out]
    j = max(range(len(py)), key=py.__getitem__)
    res[sid] = {"choice": s["options"][j]["text"], "p_yes": round(py[j], 4), "ranked": sorted(((round(p, 3), s["options"][i]["text"]) for i, p in enumerate(py)), reverse=True)[:4]}
    print(sid, "->", res[sid]["choice"], res[sid]["p_yes"], "| next:", res[sid]["ranked"][1:3])
meta = {"model": MODEL, "shape": "yes/no per filled line", "load_s": round(load_s,1), "ms_per_decision": round(1000*tt/n), "decisions": n,
        "mps_GB": computer.mps_gb(computer.device()), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2)}
print(meta)
computer.answer({"meta": meta, "choices": res})

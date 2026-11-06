"""Stage A: rank the sourced pool per slot with a small cross-encoder; keep the top 12 as the slot's options."""
"""
  python3 tools/benchmark-small-local-models/do-work/rank_pool_for_blanks.py <request.json>   (or stdin)

Request: template (a word template), pool (make_candidate_pool.py's answer, or its file), model (a sentence-transformers
cross-encoder), device (optional), write_to.
A slot of type PERSON-LINE (another person's own words) is never filled from a pool.
Answer: { result: { meta, slots: { slot id: { query, line, type, note, options: [{ text, source, origin, score }] } } } }."""
import json, sys, time, resource
from pathlib import Path
import torch
from sentence_transformers import CrossEncoder
import pathlib
H = Path(__file__).parent
sys.path.insert(0, str(H.parent/"read-data")); import computer
from template_blanks import load
R = computer.request()
pool = computer.json_of(computer.need(R, "pool"), "pool"); pool = pool["pool"] if isinstance(pool, dict) else pool
_, lines, slots = load(computer.need(R, "template"))
MODEL = computer.need(R, "model")
t0 = time.time(); ce = CrossEncoder(MODEL, device=computer.device()); load_s = time.time()-t0
out = {}; tt = 0; pairs = 0
for sid, s in slots.items():
    if s["type"] == "PERSON-LINE": continue   # another person's own words: never chosen from a pool
    line = lines[s["lines"][0]]["text"]
    q = f"A {s['type'].lower()} that is {s['note']}, to fill the blank in: \"{line.replace('['+sid+']', '___')}\""
    t = time.time(); sc = ce.predict([(q, p["text"]) for p in pool], batch_size=64); tt += time.time()-t; pairs += len(pool)
    top = sorted(range(len(pool)), key=lambda i: -float(sc[i]))[:12]
    out[sid] = {"query": q, "line": line, "type": s["type"], "note": s["note"], "options": [dict(pool[i], score=round(float(sc[i]), 3)) for i in top]}
meta = {"model": MODEL, "load_s": round(load_s,1), "ms_per_pair": round(1000*tt/pairs, 2), "pairs": pairs, "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2), "mps_GB": computer.mps_gb(computer.device())}
tag = MODEL.split("/")[-1]
meta["tag"] = tag
print(meta)
computer.answer({"meta": meta, "slots": out})

"""Stage A: rank the sourced pool per slot with a small cross-encoder; keep the top 12 as the slot's options."""
import json, sys, time, resource
from pathlib import Path
import torch
from sentence_transformers import CrossEncoder
import pathlib
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"lib")); import place
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[3])  # this repository, wherever this place keeps it
sys.path.insert(0, str(Path(__file__).parent)); from slots import load
H = Path(__file__).parent
LISTING = json.load(open(pathlib.Path(CHECKOUT) / "library/fills/_catalog/listings/workflow-listing.json"))
pool = json.load(open(H/"pool.json"))
_, lines, slots = load()
MODEL = sys.argv[1] if len(sys.argv) > 1 else "BAAI/bge-reranker-v2-m3"
t0 = time.time(); ce = CrossEncoder(MODEL, device=place.device()); load_s = time.time()-t0
out = {}; tt = 0; pairs = 0
for sid, s in slots.items():
    if s["type"] == "PERSON-LINE": continue   # another person's own words: never chosen from a pool
    line = lines[s["lines"][0]]["text"]
    q = f"A {s['type'].lower()} that is {s['note']}, to fill the blank in: \"{line.replace('['+sid+']', '___')}\""
    t = time.time(); sc = ce.predict([(q, p["text"]) for p in pool], batch_size=64); tt += time.time()-t; pairs += len(pool)
    top = sorted(range(len(pool)), key=lambda i: -float(sc[i]))[:12]
    out[sid] = {"query": q, "line": line, "type": s["type"], "note": s["note"], "options": [dict(pool[i], score=round(float(sc[i]), 3)) for i in top]}
meta = {"model": MODEL, "load_s": round(load_s,1), "ms_per_pair": round(1000*tt/pairs, 2), "pairs": pairs, "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2), "mps_GB": round(torch.mps.driver_allocated_memory()/1e9,2)}
tag = MODEL.split("/")[-1]
json.dump({"meta": meta, "slots": out}, open(H/f"options-{tag}.json","w"), indent=1); print(meta)

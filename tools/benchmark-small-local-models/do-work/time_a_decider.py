"""Time a decider-style choice classifier: its load, then four runs of a made-up two-question case, with the device and
memory it used.

  python3 tools/benchmark-small-local-models/do-work/time_a_decider.py <request.json>   (or stdin)

Request: model (its repository in the Hugging Face cache), revision (optional: one snapshot), device (optional).
Answer: { result: { device, load_s, ms: [4 runs], choice, confidence, alloc_GB, maxrss_GB } }."""
import sys, time, torch, resource
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import computer
R = computer.request()
D=str(computer.snapshot(computer.need(R, "model"), R.get("revision"))); DEV=computer.device()
sys.path.insert(0, D)
from decider.infer import Decider
t=time.time(); d = Decider(D, device=DEV); print("load", round(time.time()-t,1),"s")
load_s = round(time.time()-t,1); ms = []
q=[{"question": "Which department should handle this?", "options": ["billing", "technical support", "sales"]},
   {"question": "Does this need a refund action?", "options": ["no", "yes"]}]
for i in range(4):
    t=time.time(); r=d.decide("My card was charged twice for the same purchase.", q); print(round((time.time()-t)*1000),"ms", r[0]['choice'], round(r[0]['confidence'],3), r[1]['choice'])
    ms.append(round((time.time()-t)*1000))
print(DEV, "alloc GB", round((torch.mps.driver_allocated_memory() if DEV == "mps" else torch.cuda.memory_allocated() if DEV == "cuda" else 0)/1e9,2), "maxrss GB", round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2))
alloc = (torch.mps.driver_allocated_memory() if DEV == "mps" else torch.cuda.memory_allocated() if DEV == "cuda" else 0)
computer.answer({"device": DEV, "load_s": load_s, "ms": ms, "choice": r[0]["choice"], "confidence": round(r[0]["confidence"], 3),
              "alloc_GB": round(alloc/1e9, 2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9, 2)})

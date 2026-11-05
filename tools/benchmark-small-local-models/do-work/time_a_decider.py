import sys, time, torch, resource
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent/"lib")); import place
D=str(place.snapshot("Mapika/decider-2b", "b37f7e1ba3fbc9238004cf531fabbee2619973fd")); DEV=place.device()
sys.path.insert(0, D)
from decider.infer import Decider
t=time.time(); d = Decider(D, device=DEV); print("load", round(time.time()-t,1),"s")
q=[{"question": "Which department should handle this?", "options": ["billing", "technical support", "sales"]},
   {"question": "Does this need a refund action?", "options": ["no", "yes"]}]
for i in range(4):
    t=time.time(); r=d.decide("My card was charged twice for the same purchase.", q); print(round((time.time()-t)*1000),"ms", r[0]['choice'], round(r[0]['confidence'],3), r[1]['choice'])
print(DEV, "alloc GB", round((torch.mps.driver_allocated_memory() if DEV == "mps" else torch.cuda.memory_allocated() if DEV == "cuda" else 0)/1e9,2), "maxrss GB", round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2))

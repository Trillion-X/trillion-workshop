"""Condition B: typed candidate pools. A rule (no model) adds every candidate of the slot's TYPE from the sources
(listing title/steps/clauses for FEATURE/OBJECT/TITLE, product names for PRODUCT, number spans for NUMBER/UNIT/WHO,
dated git facts for TIME); the reranker's top 6 are kept beside them. Options are shuffled with a fixed seed."""
import json, random
from pathlib import Path
H = Path(__file__).parent
pool = json.load(open(H/"pool.json"))
A = json.load(open(H/"options-bge-reranker-v2-m3.json"))["slots"]
by = lambda pred: [p for p in pool if pred(p)]
TYPED = {
 "FEATURE": by(lambda p: p["origin"] == "listing"),
 "OBJECT": by(lambda p: p["origin"] == "listing"),
 "TITLE": by(lambda p: p["origin"] == "listing"),
 "PRODUCT": by(lambda p: p["origin"] in ("site-name",)) + by(lambda p: p["origin"] == "listing")[:1],
 "NUMBER": by(lambda p: p["origin"].endswith("-number") or p["origin"] == "git-fact"),
 "UNIT": by(lambda p: p["origin"].endswith("-number")),
 "WHO": by(lambda p: p["origin"].endswith("-number")),
 "TIME": by(lambda p: p["origin"] == "git-fact"),
}
out = {}
for sid, s in A.items():
    seen, opts = set(), []
    for o in TYPED[s["type"]] + s["options"][:6]:
        if o["text"] not in seen: seen.add(o["text"]); opts.append({k: o[k] for k in ("text", "source", "origin")})
    random.Random(sid).shuffle(opts)
    out[sid] = dict(s, options=opts)
    print(sid, s["type"], len(opts))
json.dump({"meta": {"condition": "typed pools + reranker top 6"}, "slots": out}, open(H/"options-typed.json", "w"), indent=1)

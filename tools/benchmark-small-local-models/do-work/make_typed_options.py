"""Condition B: typed candidate pools. A rule (no model) adds every candidate of the slot's TYPE from the sources
(listing title/steps/clauses for FEATURE/OBJECT/TITLE, product names for PRODUCT, number spans for NUMBER/UNIT/WHO,
dated git facts for TIME); the reranker's top 6 are kept beside them. Options are shuffled with a fixed seed."""
"""
  python3 -I tools/benchmark-small-local-models/do-work/make_typed_options.py <request.json>   (or stdin)

Request: pool (make_candidate_pool.py's answer, or its file), ranked (rank_pool_for_blanks.py's answer, or its file),
write_to. The origins the rules read are the ones make_candidate_pool.py gives. A slot of another type keeps only the
reranker's top 6. Answer: { result: { meta, slots: { slot id: { ...ranked slot, options: [{ text, source, origin }] } } } }.
Standard library only."""
import json, random, sys
from pathlib import Path
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"read-data")); import place
R = place.request()
pool = place.json_of(place.need(R, "pool"), "pool"); pool = pool["pool"] if isinstance(pool, dict) else pool
A = place.json_of(place.need(R, "ranked"), "ranked")["slots"]
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
    for o in TYPED.get(s["type"], []) + s["options"][:6]:
        if o["text"] not in seen: seen.add(o["text"]); opts.append({k: o[k] for k in ("text", "source", "origin")})
    random.Random(sid).shuffle(opts)
    out[sid] = dict(s, options=opts)
    print(sid, s["type"], len(opts))
place.answer({"meta": {"condition": "typed pools + reranker top 6"}, "slots": out})

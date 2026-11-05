"""Per-field agreement with Opus shots.tsv (top-1 in Opus's value set; Opus 'unknown' rows skipped), confusions, calibration."""
import json, sys, collections
from pathlib import Path
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"lib"))
from labels import FIELDS, opus_set
S = json.load(open(H/"sample.json"))
def systems():
    for f in sorted(H.glob("pred-*.json")):
        P = json.load(open(f)); rows = P["rows"]
        keys = {k.split("|")[1] for r in rows[:1] for k in r if "|" in k and k.count("|") == 1}
        if keys:
            for mode in sorted(keys): yield f"{P['meta'].get('tag', f.stem[5:])}|{mode}", {r["i"]: {fl: (r.get(f"{fl}|{mode}") or [None])[0] for fl in FIELDS} | {"_conf": {fl: r.get(f"{fl}|{mode}|conf") for fl in FIELDS}} for r in rows}, P["meta"]
        else:
            yield f.stem[5:], {r["i"]: {fl: r.get(fl) for fl in FIELDS} for r in rows}, P["meta"]
def centered():
    """SigLIP with each label's mean score over all frames subtracted (an unsupervised prior correction, no labels used)."""
    f = H/"pred-siglip2-so400m.json"
    if not f.exists(): return
    P = json.load(open(f)); rows = P["rows"]
    from labels import values
    for mode in ("bare", "defined"):
        if f"shot_size|{mode}|all" not in rows[0]: continue
        pred = {}
        means = {fl: [sum(r[f"{fl}|{mode}|all"][j] for r in rows)/len(rows) for j in range(len(values(fl)))] for fl in FIELDS}
        for r in rows:
            pred[r["i"]] = {fl: values(fl)[max(range(len(values(fl))), key=lambda j: r[f"{fl}|{mode}|all"][j] - means[fl][j])] for fl in FIELDS}
        yield f"siglip2-so400m|{mode}-centered", pred, P["meta"]
import itertools
res = {}
for name, pred, meta in itertools.chain(systems(), centered()):
    out = {}
    for fl in FIELDS:
        n = ok = 0; conf = collections.Counter(); cal = []
        for i, p in pred.items():
            g = opus_set(S[i], fl)
            if not g: continue
            n += 1; hit = p.get(fl) in g; ok += hit
            if not hit: conf[(",".join(sorted(g)), p.get(fl))] += 1
            c = (p.get("_conf") or {}).get(fl)
            if c is not None: cal.append((c, hit))
        base = collections.Counter(v for i in pred for v in [sorted(opus_set(S[i], fl))[0] if opus_set(S[i], fl) else None] if v).most_common(1)
        d = {"n": n, "agree": round(ok / n, 3) if n else None, "top_confusions": [f"opus {a} -> {b} x{c}" for (a, b), c in conf.most_common(4)]}
        if cal:
            for t in (0.7, 0.8, 0.9):
                a = [h for c, h in cal if c >= t]
                d[f"t{t}"] = {"answered": round(len(a)/len(cal), 3), "agree_when_answered": round(sum(a)/len(a), 3) if a else None}
            hi = [h for c, h in cal if c >= 0.5]; lo = [h for c, h in cal if c < 0.5]
            d["mean_conf"] = round(sum(c for c, _ in cal)/len(cal), 3)
        out[fl] = d
    res[name] = {"meta": meta, "fields": out}
# majority-class baseline: always answer Opus's most common value
mb = {}
for fl in FIELDS:
    c = collections.Counter(v for s in S if "frame" in s for v in opus_set(s, fl))
    top = c.most_common(1)[0][0]; rows = [s for s in S if "frame" in s and opus_set(s, fl)]
    mb[fl] = {"value": top, "agree": round(sum(top in opus_set(s, fl) for s in rows)/len(rows), 3)}
res["majority-baseline"] = {"fields": {fl: {"agree": v["agree"], "value": v["value"]} for fl, v in mb.items()}}
json.dump(res, open(H/"scores.json", "w"), indent=1)
print(f"{'system':34s}" + "".join(f"{fl[:11]:>12s}" for fl in FIELDS))
for name, r in res.items():
    print(f"{name:34s}" + "".join(f"{(r['fields'][fl]['agree'] or 0):12.3f}" for fl in FIELDS))

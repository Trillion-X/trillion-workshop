"""Per-field agreement with Opus shots.tsv (top-1 in Opus's value set; Opus 'unknown' rows skipped), confusions, calibration.
(As first run Opus labelled shots.tsv; here the reference labels are the sampled shots' `reference`, whoever made them.)

  python3 -I tools/benchmark-small-local-models/do-work/score_frame_labels.py <request.json>   (or stdin)

Request: shots (the sample, each with reference, w and h), vocabulary ({ field: { value: definition } }), labels
([the files label_frames_* answers were written to (their write_to)], each system named by its meta.tag, else the
file's name), reference_name (who made the reference
labels), unknown (the reference value that means not known), list_separator, shape_field and shape_ratios (optional:
the field whose reference is the named width/height ratio nearest the shot's own), thresholds ([confidence]), write_to.
Answer: { result: { "<system>|<mode>": { meta, fields: { field: { n, agree, top_confusions, t<line>, mean_conf } } },
"<system>|<mode>-centered": ..., "majority-baseline": { fields } } }. Standard library only."""
import json, sys, collections
import math
from pathlib import Path
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"read-data")); import place
R = place.request()
FIELDS, values, _ = place.vocabulary(R)
S = place.shots_of(R); WHO = place.need(R, "reference_name"); UNKNOWN = place.need(R, "unknown"); SEP = place.need(R, "list_separator")
def truth_orientation(w, h):
    r = math.log(w / h)
    opts = place.need(R, "shape_ratios")
    return min(opts, key=lambda k: abs(math.log(opts[k]) - r))
def opus_set(s, f):
    """The reference labeller's accepted values of field f for shot s (the name is the first run's: Opus labelled them)."""
    if f == R.get("shape_field"): return {truth_orientation(s["w"], s["h"])}
    return {x.strip() for x in (s["reference"].get(f) or "").split(SEP) if x.strip() and x.strip() != UNKNOWN}
LABELS = place.need(R, "labels")
for f in LABELS:
    if not isinstance(f, str) or not Path(f).is_file(): place.refuse(f"labels names {f!r}, which is not a file: give the files the label answers were written to")
def tag_of(f, P): return P.get("meta", {}).get("tag") or Path(f).stem
def systems():
    for f in LABELS:
        P = json.load(open(f)); rows = P["rows"]
        tag = tag_of(f, P)
        keys = {k.split("|")[1] for r in rows[:1] for k in r if "|" in k and k.count("|") == 1}
        if keys:
            for mode in sorted(keys): yield f"{tag}|{mode}", {r["i"]: {fl: (r.get(f"{fl}|{mode}") or [None])[0] for fl in FIELDS} | {"_conf": {fl: r.get(f"{fl}|{mode}|conf") for fl in FIELDS}} for r in rows}, P["meta"]
        else:
            yield tag, {r["i"]: {fl: r.get(fl) for fl in FIELDS} for r in rows}, P["meta"]
def centered():
    """SigLIP with each label's mean score over all frames subtracted (an unsupervised prior correction, no labels used)."""
    # every labels file whose rows carry each value's score (<field>|<mode>|all)
    for f in LABELS:
      P = json.load(open(f)); rows = P["rows"]
      tag = tag_of(f, P)
      for mode in ("bare", "defined"):
        if not rows or f"{FIELDS[0]}|{mode}|all" not in rows[0]: continue
        pred = {}
        means = {fl: [sum(r[f"{fl}|{mode}|all"][j] for r in rows)/len(rows) for j in range(len(values(fl)))] for fl in FIELDS}
        for r in rows:
            pred[r["i"]] = {fl: values(fl)[max(range(len(values(fl))), key=lambda j: r[f"{fl}|{mode}|all"][j] - means[fl][j])] for fl in FIELDS}
        yield f"{tag}|{mode}-centered", pred, P["meta"]
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
        d = {"n": n, "agree": round(ok / n, 3) if n else None, "top_confusions": [f"{WHO} {a} -> {b} x{c}" for (a, b), c in conf.most_common(4)]}
        if cal:
            for t in place.need(R, "thresholds"):
                a = [h for c, h in cal if c >= t]
                d[f"t{t}"] = {"answered": round(len(a)/len(cal), 3), "agree_when_answered": round(sum(a)/len(a), 3) if a else None}
            hi = [h for c, h in cal if c >= 0.5]; lo = [h for c, h in cal if c < 0.5]
            d["mean_conf"] = round(sum(c for c, _ in cal)/len(cal), 3)
        out[fl] = d
    res[name] = {"meta": meta, "fields": out}
# majority-class baseline: always answer the reference's most common value
mb = {}
for fl in FIELDS:
    c = collections.Counter(v for s in S if "frame" in s for v in opus_set(s, fl))
    if not c: mb[fl] = {"value": None, "agree": None}; continue
    top = c.most_common(1)[0][0]; rows = [s for s in S if "frame" in s and opus_set(s, fl)]
    mb[fl] = {"value": top, "agree": round(sum(top in opus_set(s, fl) for s in rows)/len(rows), 3)}
res["majority-baseline"] = {"fields": {fl: {"agree": v["agree"], "value": v["value"]} for fl, v in mb.items()}}
print(f"{'system':34s}" + "".join(f"{fl[:11]:>12s}" for fl in FIELDS))
for name, r in res.items():
    print(f"{name:34s}" + "".join(f"{(r['fields'][fl]['agree'] or 0):12.3f}" for fl in FIELDS))
place.answer(res)

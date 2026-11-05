"""An editor's job, approximated: 'is this take complete and final?' over transcript segments.
No labelled multi-take footage exists in the library, so takes are built from REAL transcript sentences:
the sentence as spoken = a usable take; three controlled faults = not usable (cut off mid-sentence,
false start then restart, trailing self-correction). Labels are by construction, stated as such."""
import json, random, re, sys, time
from pathlib import Path
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[3])  # this repository, wherever this place keeps it
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"lib"))
T = pathlib.Path(CHECKOUT) / "library/transcripts"
rnd = random.Random(7)
sents = []
for f in sorted(T.glob("*.json"))[::9][:25]:
    d = json.load(open(f)); words = [w.get("text", "") for w in d.get("words", []) if w.get("type", "word") == "word"]
    text = " ".join(words)
    for s in re.split(r"(?<=[.!?])\s+", text):
        if 9 <= len(s.split()) <= 22: sents.append((f.stem, s))
rnd.shuffle(sents); sents = sents[:40]
items = []
for k, (vid, s) in enumerate(sents):
    w = s.split()
    kind = ["complete", "complete", "cut", "restart", "selfcorrect"][k % 5] if k < 40 else "complete"
    if kind == "complete": t = s
    elif kind == "cut": t = " ".join(w[: max(3, int(len(w) * rnd.uniform(0.45, 0.7)))])
    elif kind == "restart": n = rnd.randint(2, 4); t = " ".join(w[:n]) + ", uh, sorry, let me start again. " + s
    else: t = s.rstrip(".!?") + ", no wait, that's wrong, let me redo that."
    items.append({"video": vid, "kind": kind, "usable": kind == "complete", "take": t})
from dec import load
d, _ = load()
res = []; tt = 0
for it in items:
    q = [{"question": "Is this take complete and final, so an editor can use it as is?", "options": ["no", "yes"]}]
    t = time.time(); r = d.decide(f"A creator recorded this take for a short video:\n\"{it['take']}\"", q); tt += time.time() - t
    res.append(dict(it, p_yes=round(r[0]["probs"]["yes"], 4)))
acc = sum((r["p_yes"] >= 0.5) == r["usable"] for r in res) / len(res)
by = {}
for r in res: by.setdefault(r["kind"], []).append((r["p_yes"] >= 0.5) == r["usable"])
abst = {}
for th in (0.7, 0.8, 0.9):
    a = [r for r in res if max(r["p_yes"], 1 - r["p_yes"]) >= th]
    abst[th] = {"answered": len(a), "right": sum((r["p_yes"] >= 0.5) == r["usable"] for r in a)}
out = {"n": len(res), "acc": round(acc, 3), "by_kind": {k: f"{sum(v)}/{len(v)}" for k, v in by.items()}, "abstain": abst, "ms_per_decision": round(1000 * tt / len(res))}
print(out); json.dump({"meta": out, "rows": res}, open(H/"takes-decider.json", "w"), indent=1)

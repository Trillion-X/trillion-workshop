import os
"""Turn a chooser's picks into fill.py input (value + the candidate's own source), render with the word-template tools,
and measure drift against the template. Usage: render.py <choice.json> <options-cond> <tag> [--conf-key k --abstain t]"""
import json, subprocess, sys, argparse
from pathlib import Path
H = Path(__file__).parent; TLV = Path(__file__).resolve().parents[3]; WT = Path(os.environ["TRILLION_WORKSHOP"])/"tools/fill-a-template-without-changing-its-words/do-work"
ap = argparse.ArgumentParser(); ap.add_argument("choice"); ap.add_argument("cond"); ap.add_argument("tag")
ap.add_argument("--conf-key"); ap.add_argument("--abstain", type=float, default=0.0); a = ap.parse_args()
C = json.load(open(H/a.choice))["choices"]; O = json.load(open(H/f"options-{a.cond}.json"))["slots"]
fills = {}
for sid, c in C.items():
    ch = c.get("choice") if isinstance(c, dict) else c
    conf = c.get(a.conf_key, 1.0) if (isinstance(c, dict) and a.conf_key) else 1.0
    src = next((o["source"] for o in O[sid]["options"] if o["text"] == ch), None)
    if ch and src and conf >= a.abstain:
        fills[sid] = {"value": ch, "sources": [src], "note": f"chosen by {a.tag}"}
    else:
        fills[sid] = {"needs": "no candidate chosen (none fits, escalated, or below threshold)"}
fj = H/"out"/f"fills-{a.tag}.json"; fj.parent.mkdir(exist_ok=True)
json.dump({"title": f"a format x a listing, chosen by {a.tag}", "root": str(TLV), "fills": fills}, open(fj, "w"), indent=1)
md = H/"out"/f"fill-{a.tag}.md"; piece = H/"out"/f"fill-{a.tag}.piece.json"
r = subprocess.run([sys.executable, str(WT/"fill.py"), str(H/"word.template.json"), str(fj), str(md), "--piece", str(piece), "--root", str(TLV)], capture_output=True, text=True)
print(r.stdout[-300:], r.stderr[-500:])
r = subprocess.run([sys.executable, str(WT/"drift.py"), str(H/"word.template.json"), str(piece), "--json", str(H/"out"/f"drift-{a.tag}.json"), "--root", str(TLV)], capture_output=True, text=True, cwd=TLV)
print("\n".join(r.stdout.splitlines()[:3]), r.stderr[-300:])

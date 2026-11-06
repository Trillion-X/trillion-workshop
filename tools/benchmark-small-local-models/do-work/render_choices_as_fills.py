import os
"""Turn a chooser's picks into fill.py input (value + the candidate's own source), render with the word-template tools,
and measure drift against the template.
The word-template tools are this checkout's tools/fill-a-template-without-changing-its-words (fill.py, drift.py).

  python3 -I tools/benchmark-small-local-models/do-work/render_choices_as_fills.py <request.json>   (or stdin)

Request: choice (a choose_* or judge_* answer, or its file), options (the options it chose from, or their file), tag
(who chose), conf_key (optional: the choice's field whose value must reach abstain, for example confidence or p_yes),
abstain (default 0), template (the word template), root (the folder the candidates' sources are read from), title
(the fills' title, with {tag}), out_dir (where word.template.json, a copy of the template, and out/fills-<tag>.json, fill-<tag>.md, fill-<tag>.piece.json and
drift-<tag>.json are written), write_to.
Answer: { result: { fills, written: { fills, md, piece, drift }, drift, errors: [what fill.py or drift.py said when it
failed] } }."""
import json, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import computer
R = computer.request()
H = Path(computer.need(R, "out_dir")); TLV = Path(computer.need(R, "root")); WT = Path(__file__).resolve().parents[2]/"fill-a-template-without-changing-its-words/do-work"
TEMPLATE = Path(computer.need(R, "template"))
if not TEMPLATE.is_file(): computer.refuse(f"template {TEMPLATE} is not there: name the word template")
import shutil; H.mkdir(parents=True, exist_ok=True); shutil.copy(TEMPLATE, H/"word.template.json")  # the template beside its fills
class A: pass
a = A(); a.tag = computer.need(R, "tag"); a.conf_key = R.get("conf_key"); a.abstain = float(R.get("abstain", 0.0))
C = computer.json_of(computer.need(R, "choice"), "choice")["choices"]; O = computer.json_of(computer.need(R, "options"), "options")["slots"]
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
json.dump({"title": computer.need(R, "title").replace("{tag}", a.tag), "root": str(TLV), "fills": fills}, open(fj, "w"), indent=1)
md = H/"out"/f"fill-{a.tag}.md"; piece = H/"out"/f"fill-{a.tag}.piece.json"
r = subprocess.run([sys.executable, str(WT/"fill.py"), str(H/"word.template.json"), str(fj), str(md), "--piece", str(piece), "--root", str(TLV)], capture_output=True, text=True)
print(r.stdout[-300:], r.stderr[-500:])
said = [] if r.returncode == 0 else ["fill: " + r.stderr.strip()[-500:]]
r = subprocess.run([sys.executable, str(WT/"drift.py"), str(H/"word.template.json"), str(piece), "--json", str(H/"out"/f"drift-{a.tag}.json"), "--root", str(TLV)], capture_output=True, text=True, cwd=TLV)
print("\n".join(r.stdout.splitlines()[:3]), r.stderr[-300:])
said += [] if r.returncode == 0 else ["drift: " + r.stderr.strip()[-500:]]
dj = H/"out"/f"drift-{a.tag}.json"
computer.answer({"fills": fills, "written": {"fills": str(fj), "md": str(md), "piece": str(piece), "drift": str(dj)},
              "drift": json.load(open(dj)) if dj.exists() and not said else None, "errors": said})

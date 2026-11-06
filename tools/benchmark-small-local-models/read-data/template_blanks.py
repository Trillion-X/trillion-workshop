"""Read the word-level template: speech.word lines with slot runs marked, and the first line each text slot sits in.

load(template) reads a word template (tools/fill-a-template-without-changing-its-words makes them) and answers
(template, lines { line id: { job, text with each slot run as [slot id] } }, slots { slot id: { ...slot, lines } });
a slot in no speech.word line is left out. Run as a command, the request is { template } and the answer
{ result: { lines, slots } }."""
import json, sys
from pathlib import Path
H = Path(__file__).parent
def load(template):
    if not Path(template).is_file():
        sys.path.insert(0, str(H)); import computer; computer.refuse(f"template {template} is not there: name a word template JSON file")
    p = json.load(open(template))
    tok = {t["id"]: t for t in p["tokens"]}
    lines = {}
    for ln in p["lines"]:
        if ln["dim"] != "speech.word": continue
        parts, prev = [], None
        for tid in ln["tokens"]:
            t = tok[tid]
            if t.get("mark") == "SLOT":
                if t.get("slot") != prev: parts.append(f"[{t['slot']}]")
                prev = t.get("slot")
            else:
                parts.append(t["dims"].get("speech.word", "")); prev = None
        lines[ln["id"]] = {"job": ln.get("job"), "text": " ".join(x for x in parts if x)}
    where = {}
    for lid, l in lines.items():
        for sid in p["slots"]:
            if f"[{sid}]" in l["text"]: where.setdefault(sid, []).append(lid)
    slots = {sid: dict(s, lines=where.get(sid, [])) for sid, s in p["slots"].items() if where.get(sid)}
    return p, lines, slots
if __name__ == "__main__":
    sys.path.insert(0, str(H)); import computer
    p, lines, slots = load(computer.need(computer.request(), "template"))
    for lid, l in lines.items(): print(lid, "|", l["text"])
    for sid, s in slots.items(): print(sid, s["type"], s["lines"], s["note"])
    computer.answer({"lines": lines, "slots": slots})

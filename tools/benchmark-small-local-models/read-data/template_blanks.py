"""Read the word-level template: speech.word lines with slot runs marked, and the first line each text slot sits in."""
import json
from pathlib import Path
H = Path(__file__).parent
def load():
    p = json.load(open(H/"word.template.json"))
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
    p, lines, slots = load()
    for lid, l in lines.items(): print(lid, "|", l["text"])
    for sid, s in slots.items(): print(sid, s["type"], s["lines"], s["note"])

"""Five shot slots from a format's FORMAT.md; ~10 candidate frames each from other library videos' shots.tsv rows of the right kind."""
"""
  python3 -I tools/benchmark-small-local-models/do-work/sample_candidates_for_slots.py <request.json>   (or stdin)

Request: library (formats/<creator>/<video>/shots.tsv and videos/<video>.mp4), slots ([{ slot, desc (the shot the
slot needs, in words), kind: [shots.tsv kind], need_screen: [screen] (optional) }], the format's own shot slots),
exclude_prefix (the format's own videos, never a candidate), write_to. As first run: rows of at least 0.5 s, videos
of at most 240 s, 10 candidates per slot from 10 different videos, seed 2026.
Answer: { result: { slots: [{ ...slot, cands: [{ video, row, t_mid, text }] }] } }. Needs ffprobe."""
import csv, json, random, subprocess, sys
from pathlib import Path
import pathlib
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import place
R = place.request()
LIB = pathlib.Path(place.need(R, "library")); EXCLUDE = place.need(R, "exclude_prefix")
SLOTS = place.need(R, "slots")
for s_ in SLOTS:
    if not {"slot", "desc", "kind"} <= set(s_): place.refuse("each of `slots` is { slot, desc, kind: [shots.tsv kind], need_screen: [screen] }")
dur = {}
def vdur(v):
    if v not in dur:
        try: r = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",str(LIB/"videos"/f"{v}.mp4")],capture_output=True,text=True)
        except FileNotFoundError: place.refuse("ffprobe is not on PATH: install ffmpeg")
        try: dur[v] = float(r.stdout.strip())
        except: dur[v] = 1e9
    return dur[v]
rows = []
for f in sorted((LIB/"formats").glob("*/*/shots.tsv")):
    v = f.parent.name
    if v.startswith(EXCLUDE) or not (LIB/"videos"/f"{v}.mp4").exists(): continue
    for i, r in enumerate(csv.DictReader(open(f), delimiter="\t")):
        try: d = float(r["t1"]) - float(r["t0"])
        except: continue
        if d >= 0.5: rows.append(dict(r, video=v, row=i, tsv=str(f)))
rnd = random.Random(2026)
out = []
for s in SLOTS:
    c = [r for r in rows if r.get("kind") in s["kind"] and (not s.get("need_screen") or r.get("screen") in s["need_screen"])]
    rnd.shuffle(c); picked, seen = [], set()
    for r in c:
        if r["video"] in seen or vdur(r["video"]) > 240: continue
        seen.add(r["video"]); picked.append(r)
        if len(picked) == 10: break
    out.append(dict(s, kind=sorted(s["kind"]), need_screen=sorted(s.get("need_screen", [])),
                    cands=[{"video": r["video"], "row": r["row"], "t_mid": round((float(r["t0"])+float(r["t1"]))/2, 3),
                            "text": "; ".join(f"{k}: {r.get(k,'')}" for k in ["kind","shot_size","angle","subject","screen","place","light","action","camera_movement"])} for r in picked]))
print([len(s["cands"]) for s in out])
place.answer({"slots": out})

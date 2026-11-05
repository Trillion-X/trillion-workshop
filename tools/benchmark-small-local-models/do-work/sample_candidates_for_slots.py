"""Five shot slots from a format's FORMAT.md; ~10 candidate frames each from other library videos' shots.tsv rows of the right kind."""
import csv, json, random, subprocess
from pathlib import Path
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[3])  # this repository, wherever this place keeps it
LIB = pathlib.Path(CHECKOUT) / "library"; H = Path(__file__).parent
SLOTS = [
 {"slot": 1, "desc": "Hook a-roll: the founder outdoors at golden hour, laptop on lap, medium shot talking to the lens", "kind": {"a-roll"}},
 {"slot": 3, "desc": "Before: over-the-shoulder close of a real laptop screen filmed with a camera, showing the old page or a messy screen", "kind": {"screen", "insert"}, "need_screen": {"screen-filmed", "screen-capture", "screen-composite"}},
 {"slot": 5, "desc": "Detail story: a macro close-up of fingers pressing keys on a keyboard, or the product's new logo on a plain background", "kind": {"insert", "b-roll", "motion-graphic", "cutaway"}},
 {"slot": 6, "desc": "Demo tour: a camera filming a laptop screen while scrolling through a product page section by section", "kind": {"screen"}},
 {"slot": 8, "desc": "Proof cameo: two people standing outdoors, one holding a handheld microphone, a street interview with a real user", "kind": {"a-roll", "b-roll", "reaction", "user-clip"}},
]
dur = {}
def vdur(v):
    if v not in dur:
        r = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",str(LIB/"videos"/f"{v}.mp4")],capture_output=True,text=True)
        try: dur[v] = float(r.stdout.strip())
        except: dur[v] = 1e9
    return dur[v]
rows = []
for f in sorted((LIB/"formats").glob("*/*/shots.tsv")):
    v = f.parent.name
    if v.startswith("the-format-video") or not (LIB/"videos"/f"{v}.mp4").exists(): continue
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
json.dump(out, open(H/"sample.json","w"), indent=1)
print([len(s["cands"]) for s in out])

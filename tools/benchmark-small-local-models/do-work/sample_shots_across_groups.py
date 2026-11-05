"""Pick ~30 videos across creators and up to 10 shots each from Opus shots.tsv. Writes exp1/sample.json."""
import csv, json, random, subprocess
from pathlib import Path
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[3])  # this repository, wherever this place keeps it
LIB = pathlib.Path(CHECKOUT) / "library"
random.seed(17)
by_creator = {}
for f in sorted((LIB/"formats").glob("*/*/shots.tsv")):
    vid = f.parent.name
    if not (LIB/"videos"/f"{vid}.mp4").exists():
        continue
    by_creator.setdefault(f.parent.parent.name, []).append(f)
creators = sorted(by_creator)
random.shuffle(creators)
picked = []
# round-robin: one per creator first, then second from big creators
for rnd in range(3):
    for c in creators:
        if len(picked) >= 30: break
        fs = by_creator[c]
        if rnd < len(fs) and (rnd == 0 or len(fs) >= 10):
            picked.append(random.Random(c+str(rnd)).sample(fs, len(fs))[rnd])
out = []
for f in picked:
    vid = f.parent.name
    rows = list(csv.DictReader(open(f), delimiter="\t"))
    rows = [r for r in rows if r.get("t0") and r.get("t1")]
    def dur(r):
        try: return float(r["t1"]) - float(r["t0"])
        except: return 0
    ok = [ (i,r) for i,r in enumerate(rows) if dur(r) >= 0.4]
    if len(ok) > 10:
        step = len(ok)/10
        ok = [ok[int(k*step)] for k in range(10)]
    p = json.loads(subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height:stream_side_data=rotation","-of","json",str(LIB/"videos"/f"{vid}.mp4")],capture_output=True,text=True).stdout)
    st = p["streams"][0]; w,h = st["width"], st["height"]
    rot = 0
    for sd in st.get("side_data_list",[]) or []:
        rot = abs(int(sd.get("rotation",0)))
    if rot in (90,270): w,h = h,w
    for i,r in ok:
        out.append({"video": vid, "creator": f.parent.parent.name, "tsv": str(f), "row": i,
                    "t_mid": round((float(r["t0"])+float(r["t1"]))/2, 3), "w": w, "h": h,
                    "opus": {k: r.get(k,"") for k in ["shot_size","angle","screen","subject","place","light","kind","action","made_how"]}})
json.dump(out, open(Path(__file__).parent/"sample.json","w"), indent=1)
print(len(picked), "videos", len(out), "shots", len({o['creator'] for o in out}), "creators")

"""Pick ~30 videos across creators and up to 10 shots each from a format library's shots.tsv tables (one per video, at
<library>/formats/<creator>/<video>/shots.tsv, its video at <library>/videos/<video>.mp4), so a benchmark asks about
shots spread over creators, drawn again the same from the seed.

  python3 -I tools/benchmark-small-local-models/do-work/sample_shots_across_groups.py <request.json>   (or stdin)

Request: library, seed, videos (how many), rounds (passes over the creators), big_creator (after the first pass a
creator gives another video only with at least this many), per_video (at most this many shots, evenly spaced),
min_seconds (shorter shots are left out), fields (the shots.tsv columns kept as each shot's `reference`), write_to.
Answer: { result: { shots: [{ video, creator, tsv, row, t_mid, w, h, reference }], videos, creators } }. Needs ffprobe."""
import csv, json, random, subprocess, sys
from pathlib import Path
import pathlib
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import place
R = place.request()
LIB = pathlib.Path(place.need(R, "library"))
random.seed(place.need(R, "seed"))
N, ROUNDS, BIG, PER, MIN_S = (place.need(R, k) for k in ("videos", "rounds", "big_creator", "per_video", "min_seconds"))
by_creator = {}
for f in sorted((LIB/"formats").glob("*/*/shots.tsv")):
    vid = f.parent.name
    if not (LIB/"videos"/f"{vid}.mp4").exists():
        continue
    by_creator.setdefault(f.parent.parent.name, []).append(f)
if not by_creator: place.refuse(f"no {LIB}/formats/*/*/shots.tsv has its video in {LIB}/videos: check `library`")
creators = sorted(by_creator)
random.shuffle(creators)
picked = []
# round-robin: one per creator first, then second from big creators
for rnd in range(ROUNDS):
    for c in creators:
        if len(picked) >= N: break
        fs = by_creator[c]
        if rnd < len(fs) and (rnd == 0 or len(fs) >= BIG):
            picked.append(random.Random(c+str(rnd)).sample(fs, len(fs))[rnd])
out = []
for f in picked:
    vid = f.parent.name
    rows = list(csv.DictReader(open(f), delimiter="\t"))
    rows = [r for r in rows if r.get("t0") and r.get("t1")]
    def dur(r):
        try: return float(r["t1"]) - float(r["t0"])
        except: return 0
    ok = [ (i,r) for i,r in enumerate(rows) if dur(r) >= MIN_S]
    if len(ok) > PER:
        step = len(ok)/PER
        ok = [ok[int(k*step)] for k in range(PER)]
    try:
        p = json.loads(subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height:stream_side_data=rotation","-of","json",str(LIB/"videos"/f"{vid}.mp4")],capture_output=True,text=True).stdout)
    except FileNotFoundError:
        place.refuse("ffprobe is not on PATH: install ffmpeg")
    st = p["streams"][0]; w,h = st["width"], st["height"]
    rot = 0
    for sd in st.get("side_data_list",[]) or []:
        rot = abs(int(sd.get("rotation",0)))
    if rot in (90,270): w,h = h,w
    for i,r in ok:
        out.append({"video": vid, "creator": f.parent.parent.name, "tsv": str(f), "row": i,
                    "t_mid": round((float(r["t0"])+float(r["t1"]))/2, 3), "w": w, "h": h,
                    "reference": {k: r.get(k,"") for k in place.need(R, "fields")}})
print(len(picked), "videos", len(out), "shots", len({o['creator'] for o in out}), "creators")
place.answer({"shots": out, "videos": len(picked), "creators": len({o['creator'] for o in out})})

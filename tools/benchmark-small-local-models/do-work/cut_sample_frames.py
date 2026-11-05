import json, subprocess, shutil
from pathlib import Path
from collections import defaultdict
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[3])  # this repository, wherever this place keeps it
H = Path(__file__).parent
LIB = pathlib.Path(CHECKOUT) / "library"
HF = pathlib.Path(CHECKOUT) / "tools/hfm/bin/hf-media"
S = json.load(open(H/"sample.json"))
by = defaultdict(list)
for i,s in enumerate(S): by[s["video"]].append(i)
fr = H/"frames"; fr.mkdir(exist_ok=True)
for vid, idx in by.items():
    out = H/"ev"/vid
    if out.exists(): shutil.rmtree(out)
    times = [S[i]["t_mid"] for i in idx]
    r = subprocess.run([str(HF),"evidence","frames",str(LIB/"videos"/f"{vid}.mp4"),"--out",str(out),"--times",json.dumps(times),"--max-width","768"],capture_output=True,text=True)
    if r.returncode: print(vid, r.stderr[-400:]); continue
    pngs = sorted(out.rglob("*.png"))
    pngs = [p for p in pngs if "sheet" not in p.name]
    if len(pngs) != len(idx): print(vid, "got", len(pngs), "want", len(idx), [p.name for p in pngs][:3])
    for i,p in zip(idx, pngs):
        dst = fr/f"{i:03d}.png"; shutil.copy(p, dst); S[i]["frame"] = str(dst)
json.dump(S, open(H/"sample.json","w"), indent=1)
print(sum(1 for s in S if "frame" in s), "frames")

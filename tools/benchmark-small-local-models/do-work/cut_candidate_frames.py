import json, subprocess, shutil
from pathlib import Path
from collections import defaultdict
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[3])  # this repository, wherever this place keeps it
H = Path(__file__).parent; LIB = pathlib.Path(CHECKOUT) / "library"
HF = pathlib.Path(CHECKOUT) / "tools/hfm/bin/hf-media"
S = json.load(open(H/"sample.json")); fr = H/"frames"; fr.mkdir(exist_ok=True)
need = defaultdict(list)
for si, s in enumerate(S):
    for ci, c in enumerate(s["cands"]): need[c["video"]].append((si, ci, c["t_mid"]))
for vid, lst in need.items():
    out = H/"ev"/vid
    if out.exists(): shutil.rmtree(out)
    r = subprocess.run([str(HF), "evidence", "frames", str(LIB/"videos"/f"{vid}.mp4"), "--out", str(out), "--times", json.dumps([t for _, _, t in lst]), "--max-width", "768"], capture_output=True, text=True)
    if r.returncode: print(vid, r.stderr[-200:]); continue
    M = json.load(open(out/"manifest.json"))
    idx = {round(tr["requested_seconds"], 3): tr["selected_index"] for tr in M["selection"]["time_requests"]}
    for si, ci, t in lst:
        p = out/f"frame-{idx[round(t, 3)]:08d}.png"
        if p.exists():
            dst = fr/f"s{S[si]['slot']}-c{ci}.png"; shutil.copy(p, dst); S[si]["cands"][ci]["frame"] = str(dst.resolve())
json.dump(S, open(H/"sample.json", "w"), indent=1)
print(sum("frame" in c for s in S for c in s["cands"]), "frames")

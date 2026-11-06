"""Cut each sampled shot's frame at its middle second with the frame tool the person already uses (an hf-media style
`<frame_tool> evidence frames <video> --out <folder> --times <json> --max-width 768`), one run per video, and copy the
frames to <out_dir>/frames/<nnn>.png in the sample's order.

  python3 -I tools/benchmark-small-local-models/do-work/cut_sample_frames.py <request.json>   (or stdin)

Request: shots (sample_shots_across_groups.py's shots, or a file holding its answer), library (videos at
<library>/videos/<video>.mp4), frame_tool, out_dir (the frame tool's folders go to <out_dir>/ev/<video>), write_to.
Answer: { result: { shots: [... with frame], frames } }."""
import json, subprocess, shutil
from pathlib import Path
from collections import defaultdict
import pathlib, sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import computer
R = computer.request()
H = pathlib.Path(computer.need(R, "out_dir")); H.mkdir(parents=True, exist_ok=True)
LIB = pathlib.Path(computer.need(R, "library"))
HF = pathlib.Path(computer.need(R, "frame_tool"))
S = computer.json_of(computer.need(R, "shots"), "shots"); S = S["shots"] if isinstance(S, dict) else S
by = defaultdict(list)
for i,s in enumerate(S): by[s["video"]].append(i)
fr = H/"frames"; fr.mkdir(exist_ok=True)
for vid, idx in by.items():
    out = H/"ev"/vid
    if out.exists(): shutil.rmtree(out)
    times = [S[i]["t_mid"] for i in idx]
    try: r = subprocess.run([str(HF),"evidence","frames",str(LIB/"videos"/f"{vid}.mp4"),"--out",str(out),"--times",json.dumps(times),"--max-width","768"],capture_output=True,text=True)
    except FileNotFoundError: computer.refuse(f"the frame tool {HF} is not there: fix `frame_tool`")
    if r.returncode: print(vid, r.stderr[-400:]); continue
    pngs = sorted(out.rglob("*.png"))
    pngs = [p for p in pngs if "sheet" not in p.name]
    if len(pngs) != len(idx): print(vid, "got", len(pngs), "want", len(idx), [p.name for p in pngs][:3])
    for i,p in zip(idx, pngs):
        dst = fr/f"{i:03d}.png"; shutil.copy(p, dst); S[i]["frame"] = str(dst)
print(sum(1 for s in S if "frame" in s), "frames")
computer.answer({"shots": S, "frames": sum(1 for s in S if "frame" in s)})

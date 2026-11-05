"""Cut each candidate's frame for the slots sample_candidates_for_slots.py made, with the frame tool the person already
uses (as in cut_sample_frames.py), reading which frame answers each time from the tool's manifest.json
(selection.time_requests: requested_seconds, selected_index; frames frame-<index:08d>.png), and copy them to
<out_dir>/frames/s<slot>-c<candidate>.png.

  python3 -I tools/benchmark-small-local-models/do-work/cut_candidate_frames.py <request.json>   (or stdin)

Request: slots (sample_candidates_for_slots.py's slots, or a file holding its answer), library, frame_tool, out_dir,
write_to. Answer: { result: { slots: [... each candidate with frame], frames } }."""
import json, subprocess, shutil
from pathlib import Path
from collections import defaultdict
import pathlib, sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import place
R = place.request()
H = pathlib.Path(place.need(R, "out_dir")); LIB = pathlib.Path(place.need(R, "library"))
HF = pathlib.Path(place.need(R, "frame_tool"))
S = place.json_of(place.need(R, "slots"), "slots"); S = S["slots"] if isinstance(S, dict) else S
H.mkdir(parents=True, exist_ok=True); fr = H/"frames"; fr.mkdir(exist_ok=True)
need = defaultdict(list)
for si, s in enumerate(S):
    for ci, c in enumerate(s["cands"]): need[c["video"]].append((si, ci, c["t_mid"]))
for vid, lst in need.items():
    out = H/"ev"/vid
    if out.exists(): shutil.rmtree(out)
    try: r = subprocess.run([str(HF), "evidence", "frames", str(LIB/"videos"/f"{vid}.mp4"), "--out", str(out), "--times", json.dumps([t for _, _, t in lst]), "--max-width", "768"], capture_output=True, text=True)
    except FileNotFoundError: place.refuse(f"the frame tool {HF} is not there: fix `frame_tool`")
    if r.returncode: print(vid, r.stderr[-200:]); continue
    M = json.load(open(out/"manifest.json"))
    idx = {round(tr["requested_seconds"], 3): tr["selected_index"] for tr in M["selection"]["time_requests"]}
    for si, ci, t in lst:
        p = out/f"frame-{idx.get(round(t, 3), -1):08d}.png"
        if p.exists():
            dst = fr/f"s{S[si]['slot']}-c{ci}.png"; shutil.copy(p, dst); S[si]["cands"][ci]["frame"] = str(dst.resolve())
print(sum("frame" in c for s in S for c in s["cands"]), "frames")
place.answer({"slots": S, "frames": sum("frame" in c for s in S for c in s["cands"])})

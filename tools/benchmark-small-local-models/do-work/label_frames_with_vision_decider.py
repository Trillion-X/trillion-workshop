"""Shot labels with decider-2b-vision: image + one lettered question per field, one forward pass per frame.
mode 'bare' shows vocabulary words; mode 'defined' shows each value with its plain definition."""
import json, sys, time, resource
from pathlib import Path
import torch
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"lib")); import place
V = place.snapshot("Mapika/decider-2b-vision"); DEV = place.device()
sys.path.insert(0, str(V))
from decider.vision import VisionDecisionModel
from decider.infer import Example, Q
from labels import FIELDS, values, DEFINE
H = Path(__file__).parent
MODE = sys.argv[1] if len(sys.argv) > 1 else "defined"
QTEXT = {"shot_size": "How much of the subject fills the frame (shot size)?", "angle": "What is the camera angle?",
         "screen": "Is a computer or phone screen shown, and how?", "subject": "What is the main subject of the frame?",
         "light": "What is the main light in the frame?", "orientation": "What is the shape of the video frame?"}
S = json.load(open(H/"sample.json"))
t0 = time.time(); m = VisionDecisionModel(str(V), grad_ckpt=False).to(DEV).eval(); load_s = time.time()-t0
def opts(f): return [f"{v}: {DEFINE[f][v]}" if MODE == "defined" else v for v in values(f)]
# decider-2b-vision reads at most 10 lettered options per question (prompt.LETTERS); larger fields run as a
# two-round tournament: chunks of <=8 in pass 1, the chunk winners in pass 2.
def chunks(vs, n=8): return [vs[k:k+n] for k in range(0, len(vs), n)]
def label(f, v): return f"{v}: {DEFINE[f][v]}" if MODE == "defined" else v
def run(im, plan):
    ex = Example("This is one frame from a short social video. Label the shot.", [Q(QTEXT[f], [label(f, v) for v in vs], 0) for f, vs in plan])
    with torch.no_grad():
        lg = m.slot_logits(m.prepare([(im, ex)]))
    return [torch.softmax(r[:len(vs)], -1).tolist() for (f, vs), r in zip(plan, lg)]
out = []; tt = 0
for i, s in enumerate(S):
    if "frame" not in s: continue
    im = Image.open(s["frame"]).convert("RGB"); im.thumbnail((448, 448))
    t = time.time()
    plan = [(f, c) for f in FIELDS for c in chunks(values(f), 10 if len(values(f)) <= 10 else 8)]
    ps = run(im, plan)
    win = {}
    for (f, vs), p in zip(plan, ps):
        j = max(range(len(vs)), key=p.__getitem__); win.setdefault(f, []).append((vs[j], p[j], vs, p))
    final = [(f, [w[0] for w in ws]) for f, ws in win.items() if len(ws) > 1]
    fp = dict(zip([f for f, _ in final], run(im, final))) if final else {}
    torch.mps.synchronize(); tt += time.time() - t
    row = {"i": i}
    for f, ws in win.items():
        if len(ws) == 1:
            _, _, vs, p = ws[0]
        else:
            vs = [w[0] for w in ws]; p = fp[f]
        order = sorted(range(len(vs)), key=lambda j: -p[j])
        row[f"{f}|{MODE}"] = [vs[j] for j in order[:3]]; row[f"{f}|{MODE}|conf"] = round(p[order[0]], 4)
    out.append(row)
meta = {"model": "Mapika/decider-2b-vision", "mode": MODE, "load_s": round(load_s,1), "ms_per_frame_all_fields": round(1000*tt/len(out)), "n": len(out),
        "mps_GB": round(torch.mps.driver_allocated_memory()/1e9,2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2)}
json.dump({"meta": meta, "rows": out}, open(H/f"pred-decider-vision-{MODE}.json","w"), indent=1); print(meta)

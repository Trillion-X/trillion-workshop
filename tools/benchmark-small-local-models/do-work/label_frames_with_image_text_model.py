"""Zero-shot shot labels with SigLIP2 (open_clip). Two prompt sets: bare vocabulary words and plain definitions.

  python3 tools/benchmark-small-local-models/do-work/label_frames_with_image_text_model.py <request.json>   (or stdin)

Request: shots (with frame; cut_sample_frames.py's answer or a file), vocabulary ({ field: { value: definition } }),
model (an open_clip name, for example hf-hub:<repo>), tag, device (optional), write_to. Each value is asked two ways:
bare ("a video frame, <field>: <value>") and defined ("a video frame: <definition>").
Answer: { result: { meta, rows: [{ i, "<field>|<mode>": [top 3], "<field>|<mode>|all": [score per value] }] } }."""
import json, sys, time, resource
from pathlib import Path
import torch, open_clip
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data"))
import computer; R = computer.request()
FIELDS, values, DEFINE = computer.vocabulary(R)
MODEL = computer.need(R, "model")
TAG = computer.need(R, "tag")
S = computer.shots_of(R)
dev = computer.device()
t0 = time.time()
model, pre = open_clip.create_model_from_pretrained(MODEL)
tok = open_clip.get_tokenizer(MODEL)
if hasattr(tok, "tokenizer") and not hasattr(type(tok.tokenizer), "batch_encode_plus"):
    _hf = tok.tokenizer; type(_hf).batch_encode_plus = lambda self, *a, **k: self(*a, **k)  # transformers 5 removed it; open_clip 3.2 still calls it
model = model.to(dev).eval()
load_s = time.time() - t0
prompts = {}
for f in FIELDS:
    vs = values(f)
    prompts[(f, "bare")] = [f"a video frame, {f.replace('_',' ')}: {v}" for v in vs]
    prompts[(f, "defined")] = [f"a video frame: {DEFINE[f][v]}" for v in vs]
with torch.no_grad():
    temb = {}
    for k, ps in prompts.items():
        e = model.encode_text(tok(ps).to(dev)); temb[k] = torch.nn.functional.normalize(e, dim=-1)
    out = []; t_img = 0
    for s in S:
        if "frame" not in s: continue
        im = pre(Image.open(s["frame"]).convert("RGB")).unsqueeze(0).to(dev)
        t = time.time(); ie = torch.nn.functional.normalize(model.encode_image(im), dim=-1); computer.sync(dev); t_img += time.time() - t
        row = {"i": S.index(s)}
        for (f, mode), te in temb.items():
            sc = (ie @ te.T)[0].float().cpu().tolist()
            vs = values(f); order = sorted(range(len(vs)), key=lambda j: -sc[j])
            row[f"{f}|{mode}"] = [vs[j] for j in order[:3]]
            row[f"{f}|{mode}|all"] = [round(x, 5) for x in sc]
        out.append(row)
n = len(out)
meta = {"model": MODEL, "tag": TAG, "load_s": round(load_s, 1), "ms_per_image": round(1000*t_img/n, 1), "n": n,
        "mps_GB": computer.mps_gb(dev), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9, 2),
        "params_M": round(sum(p.numel() for p in model.parameters())/1e6)}
print(meta)
computer.answer({"meta": meta, "rows": out})

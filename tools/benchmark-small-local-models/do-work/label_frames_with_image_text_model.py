"""Zero-shot shot labels with SigLIP2 (open_clip). Two prompt sets: bare vocabulary words and plain definitions."""
import json, sys, time, resource
from pathlib import Path
import torch, open_clip
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"lib"))
from labels import FIELDS, values, DEFINE
H = Path(__file__).parent
MODEL = sys.argv[1] if len(sys.argv) > 1 else "hf-hub:timm/ViT-SO400M-16-SigLIP2-384"
TAG = sys.argv[2] if len(sys.argv) > 2 else "siglip2-so400m"
S = json.load(open(H/"sample.json"))
import place; dev = place.device()
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
        t = time.time(); ie = torch.nn.functional.normalize(model.encode_image(im), dim=-1); torch.mps.synchronize(); t_img += time.time() - t
        row = {"i": S.index(s)}
        for (f, mode), te in temb.items():
            sc = (ie @ te.T)[0].float().cpu().tolist()
            vs = values(f); order = sorted(range(len(vs)), key=lambda j: -sc[j])
            row[f"{f}|{mode}"] = [vs[j] for j in order[:3]]
            row[f"{f}|{mode}|all"] = [round(x, 5) for x in sc]
        out.append(row)
n = len(out)
meta = {"model": MODEL, "tag": TAG, "load_s": round(load_s, 1), "ms_per_image": round(1000*t_img/n, 1), "n": n,
        "mps_GB": round(torch.mps.driver_allocated_memory()/1e9, 2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9, 2),
        "params_M": round(sum(p.numel() for p in model.parameters())/1e6)}
json.dump({"meta": meta, "rows": out}, open(H/f"pred-{TAG}.json", "w"), indent=1)
print(meta)

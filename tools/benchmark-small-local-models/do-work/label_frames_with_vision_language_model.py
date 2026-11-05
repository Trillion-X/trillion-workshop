"""Shot labels with Qwen3-VL-2B-Instruct (mlx-vlm): one generation per frame returning JSON with every field."""
import json, sys, time, re, resource
from pathlib import Path
import mlx.core as mx
from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"lib"))
from labels import FIELDS, values, DEFINE
H = Path(__file__).parent
REPO = "mlx-community/Qwen3-VL-2B-Instruct-bf16"
S = json.load(open(H/"sample.json"))
t0 = time.time(); model, proc = load(REPO); load_s = time.time()-t0
lines = []
for f in FIELDS:
    lines.append(f'"{f}": one of ' + "; ".join(f'"{v}" ({DEFINE[f][v]})' for v in values(f)))
lines.append('"place": a short phrase for the kind of place, e.g. "home desk by a window"')
PROMPT = ("Label this frame from a short social video. Answer with one JSON object and nothing else, with these keys:\n" + "\n".join(lines))
prompt = apply_chat_template(proc, model.config, PROMPT, num_images=1)
out = []; tt = 0; toks = 0
for i, s in enumerate(S):
    if "frame" not in s: continue
    t = time.time()
    r = generate(model, proc, prompt, [s["frame"]], max_tokens=160, temperature=0.0, verbose=False)
    tt += time.time()-t
    txt = r.text if hasattr(r, "text") else str(r); toks += getattr(r, "generation_tokens", 0)
    m = re.search(r"\{.*\}", txt, re.S); d = {}
    try: d = json.loads(m.group(0)) if m else {}
    except Exception: pass
    row = {"i": i, "raw": txt[:600]}
    for f in FIELDS + ["place"]:
        v = d.get(f); v = v[0] if isinstance(v, list) and v else v
        row[f] = v if isinstance(v, str) else None
    out.append(row)
meta = {"model": REPO, "load_s": round(load_s,1), "s_per_frame": round(tt/len(out),2), "gen_tokens_per_frame": round(toks/len(out)), "n": len(out),
        "peak_mem_GB": round(mx.get_peak_memory()/1e9,2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2)}
json.dump({"meta": meta, "rows": out}, open(H/"pred-qwen3vl-2b.json","w"), indent=1); print(meta)

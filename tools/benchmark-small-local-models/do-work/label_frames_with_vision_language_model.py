"""Shot labels with a vision-language model such as Qwen3-VL-2B-Instruct (mlx-vlm): one generation per frame returning
JSON with every field.

  python3 tools/benchmark-small-local-models/do-work/label_frames_with_vision_language_model.py <request.json>   (or stdin)

Request: shots (with frame), vocabulary ({ field: { value: definition } }), phrases ({ key: what free phrase to give,
for example a kind of place }), instruction (the words before the keys), model (an mlx-vlm repository), max_tokens,
write_to. Answer: { result: { meta, rows: [{ i, raw, <field>: value | null, <phrase key>: text | null }] } }."""
import json, sys, time, re, resource
from pathlib import Path
import mlx.core as mx
from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import place
R = place.request()
FIELDS, values, DEFINE = place.vocabulary(R)
REPO = place.need(R, "model"); PHRASES = place.need(R, "phrases"); MAX = place.need(R, "max_tokens")
S = place.shots_of(R)
t0 = time.time(); model, proc = load(REPO); load_s = time.time()-t0
lines = []
for f in FIELDS:
    lines.append(f'"{f}": one of ' + "; ".join(f'"{v}" ({DEFINE[f][v]})' for v in values(f)))
for k, said in PHRASES.items(): lines.append(f'"{k}": {said}')
PROMPT = (place.need(R, "instruction") + "\n" + "\n".join(lines))
prompt = apply_chat_template(proc, model.config, PROMPT, num_images=1)
out = []; tt = 0; toks = 0
for i, s in enumerate(S):
    if "frame" not in s: continue
    t = time.time()
    r = generate(model, proc, prompt, [s["frame"]], max_tokens=MAX, temperature=0.0, verbose=False)
    tt += time.time()-t
    txt = r.text if hasattr(r, "text") else str(r); toks += getattr(r, "generation_tokens", 0)
    m = re.search(r"\{.*\}", txt, re.S); d = {}
    try: d = json.loads(m.group(0)) if m else {}
    except Exception: pass
    row = {"i": i, "raw": txt[:600]}
    for f in FIELDS + list(PHRASES):
        v = d.get(f); v = v[0] if isinstance(v, list) and v else v
        row[f] = v if isinstance(v, str) else None
    out.append(row)
meta = {"model": REPO, "load_s": round(load_s,1), "s_per_frame": round(tt/len(out),2), "gen_tokens_per_frame": round(toks/len(out)), "n": len(out),
        "peak_mem_GB": round(mx.get_peak_memory()/1e9,2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2)}
print(meta)
place.answer({"meta": meta, "rows": out})

"""Stage B with Qwen3-1.7B (generative, mlx-lm): answer with the option number only."""
"""
  python3 tools/benchmark-small-local-models/do-work/choose_fills_with_language_model.py <request.json>   (or stdin)

Request: options (make_typed_options.py's or rank_pool_for_blanks.py's answer, or its file), listing (what is being
launched: { title, job, steps }, or its file), model (an mlx-lm repository), max_tokens, device (optional), write_to.
Answer: { result: { meta, choices: { slot id: { choice, index, raw } } } }."""
import json, re, sys, time, resource
from pathlib import Path
import mlx.core as mx
from mlx_lm import load, generate
import pathlib
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"read-data")); import place
R = place.request()
LISTING = place.json_of(place.need(R, "listing"), "listing")
O = place.json_of(place.need(R, "options"), "options")["slots"]
NONE, ESC = "none of these is a true value for this blank; leave it empty", "escalate to a bigger model"
REPO = place.need(R, "model"); MAX = place.need(R, "max_tokens")
t0 = time.time(); model, tok = load(REPO); load_s = time.time() - t0
res = {}; times = []
for sid, s in O.items():
    opts = [o["text"] for o in s["options"]] + [NONE, ESC]
    msg = (f"What is being launched: {LISTING['title']}. {LISTING['job']}\n"
           f"Script line with a blank: {s['line'].replace(f'[{sid}]', '___')}\n"
           f"The blank is a {s['type']}: {s['note']}.\nOnly a candidate that is literally true of what is being launched may fill the blank.\n"
           "Candidates:\n" + "\n".join(f"{i}. {o}" for i, o in enumerate(opts)) + "\nAnswer with the number of the best candidate only.")
    prompt = tok.apply_chat_template([{"role": "user", "content": msg}], add_generation_prompt=True, tokenize=False, enable_thinking=False)
    t = time.time(); out = generate(model, tok, prompt=prompt, max_tokens=MAX, verbose=False); times.append(time.time() - t)
    m = re.search(r"\d+", out); k = int(m.group(0)) if m else -1
    ch = opts[k] if 0 <= k < len(opts) else None
    res[sid] = {"choice": ch, "index": k, "raw": out}
    print(sid, "->", ch)
meta = {"model": REPO, "load_s": round(load_s,1), "ms_per_request_median": round(1000*sorted(times)[len(times)//2]),
        "peak_mem_GB": round(mx.get_peak_memory()/1e9,2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2)}
print(meta)
place.answer({"meta": meta, "choices": res})

"""Stage B with Qwen3-1.7B (generative, mlx-lm): answer with the option number only."""
import json, re, sys, time, resource
from pathlib import Path
import mlx.core as mx
from mlx_lm import load, generate
import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[3])  # this repository, wherever this place keeps it
H = Path(__file__).parent
LISTING = json.load(open(pathlib.Path(CHECKOUT) / "library/fills/_catalog/listings/workflow-listing.json"))
COND = sys.argv[1] if len(sys.argv) > 1 else "bge-reranker-v2-m3"
O = json.load(open(H/f"options-{COND}.json"))["slots"]
NONE, ESC = "none of these is a true value for this blank; leave it empty", "escalate to a bigger model"
REPO = "mlx-community/Qwen3-1.7B-bf16"
t0 = time.time(); model, tok = load(REPO); load_s = time.time() - t0
res = {}; times = []
for sid, s in O.items():
    opts = [o["text"] for o in s["options"]] + [NONE, ESC]
    msg = (f"What is being launched: {LISTING['title']}. {LISTING['job']}\n"
           f"Script line with a blank: {s['line'].replace(f'[{sid}]', '___')}\n"
           f"The blank is a {s['type']}: {s['note']}.\nOnly a candidate that is literally true of what is being launched may fill the blank.\n"
           "Candidates:\n" + "\n".join(f"{i}. {o}" for i, o in enumerate(opts)) + "\nAnswer with the number of the best candidate only.")
    prompt = tok.apply_chat_template([{"role": "user", "content": msg}], add_generation_prompt=True, tokenize=False, enable_thinking=False)
    t = time.time(); out = generate(model, tok, prompt=prompt, max_tokens=8, verbose=False); times.append(time.time() - t)
    m = re.search(r"\d+", out); k = int(m.group(0)) if m else -1
    ch = opts[k] if 0 <= k < len(opts) else None
    res[sid] = {"choice": ch, "index": k, "raw": out}
    print(sid, "->", ch)
meta = {"model": REPO, "load_s": round(load_s,1), "ms_per_request_median": round(1000*sorted(times)[len(times)//2]),
        "peak_mem_GB": round(mx.get_peak_memory()/1e9,2), "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2)}
json.dump({"meta": meta, "choices": res}, open(H/f"choice-qwen3-1.7b-{COND}.json","w"), indent=1); print(meta)

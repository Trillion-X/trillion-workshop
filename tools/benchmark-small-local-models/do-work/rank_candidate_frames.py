"""Rank each slot's ~10 candidate frames. method: siglip | decider-vision | decider-text | bge-text | qwen3vl"""
"""
  python3 tools/benchmark-small-local-models/do-work/rank_candidate_frames.py <request.json>   (or stdin)

Request: slots (cut_candidate_frames.py's answer, or its file), method (siglip: an open_clip image-text model;
decider-vision: a decider-vision snapshot; decider-text: a decider snapshot reading each candidate's library text;
bge-text: a sentence-transformers cross-encoder on that text; qwen3vl: an mlx-vlm model scoring 0 to 10), model (that
method's model), reference (optional: { slot: [candidate frame or c<index>, best first] }, a ranking someone made
blind) and reference_name, device (optional), write_to.
Answer: { result: { meta, scores: { frame: score }, rank: { slot: [frame, best first] }, agreement (with a
reference): { top1, top1_in_<reference_name>_top3 } } }."""
import json, sys, time, re, resource
from pathlib import Path
H = Path(__file__).parent; sys.path.insert(0, str(H.parent/"read-data")); import place; R = place.request(); DEV = place.device()
S = place.json_of(place.need(R, "slots"), "slots"); S = S["slots"] if isinstance(S, dict) else S; M = place.need(R, "method"); MODEL = place.need(R, "model")
ORIG = {s["slot"]: [c.get("frame") for c in s["cands"]] for s in S}  # c<index> names a candidate by its place before frameless ones go
for s in S: s["cands"] = [c for c in s["cands"] if "frame" in c]
t0 = time.time(); scores = {}; n = 0; tt = 0
if M == "siglip":
    import torch, open_clip
    from PIL import Image
    model, pre = open_clip.create_model_from_pretrained(MODEL); tok = open_clip.get_tokenizer(MODEL)
    if hasattr(tok, "tokenizer") and not hasattr(type(tok.tokenizer), "batch_encode_plus"):
        type(tok.tokenizer).batch_encode_plus = lambda self, *a, **k: self(*a, **k)
    model = model.to(DEV).eval()
    with torch.no_grad():
        for s in S:
            te = torch.nn.functional.normalize(model.encode_text(tok([s["desc"]]).to(DEV)), dim=-1)
            for c in s["cands"]:
                t = time.time(); ie = torch.nn.functional.normalize(model.encode_image(pre(Image.open(c["frame"]).convert("RGB")).unsqueeze(0).to(DEV)), dim=-1)
                scores[c["frame"]] = float((ie @ te.T)[0, 0]); tt += time.time() - t; n += 1
elif M == "decider-vision":
    import torch
    from PIL import Image
    V = place.snapshot(MODEL); sys.path.insert(0, str(V))
    from decider.vision import VisionDecisionModel
    from decider.infer import Example, Q
    m = VisionDecisionModel(str(V), grad_ckpt=False).to(DEV).eval()
    for s in S:
        ex = Example(f"An editor needs a clip for this slot of a launch video: {s['desc']}", [Q("Does this frame fit the slot?", ["no", "yes"], 0)])
        for c in s["cands"]:
            im = Image.open(c["frame"]).convert("RGB"); im.thumbnail((448, 448))
            t = time.time()
            with torch.no_grad(): lg = m.slot_logits(m.prepare([(im, ex)]))
            scores[c["frame"]] = torch.softmax(lg[0, :2], -1)[1].item(); tt += time.time() - t; n += 1
elif M == "decider-text":
    d, _ = place.load_decider(MODEL)
    for s in S:
        reqs = [(f"An editor needs a clip for this slot of a launch video: {s['desc']}\nCandidate clip, as labelled in the library: {c['text']}",
                 [{"question": "Does this clip fit the slot?", "options": ["no", "yes"]}]) for c in s["cands"]]
        t = time.time(); out = d.decide_batch(reqs); tt += time.time() - t; n += len(reqs)
        for c, r in zip(s["cands"], out): scores[c["frame"]] = r[0]["probs"]["yes"]
elif M == "bge-text":
    from sentence_transformers import CrossEncoder
    ce = CrossEncoder(MODEL, device=DEV)
    for s in S:
        t = time.time(); sc = ce.predict([(s["desc"], c["text"]) for c in s["cands"]]); tt += time.time() - t; n += len(sc)
        for c, x in zip(s["cands"], sc): scores[c["frame"]] = float(x)
elif M == "qwen3vl":
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template
    model, proc = load(MODEL)
    for s in S:
        prompt = apply_chat_template(proc, model.config, f"An editor needs a clip for this slot of a launch video: {s['desc']}\nHow well does this frame fit the slot, from 0 (not at all) to 10 (exactly)? Answer with the number only.", num_images=1)
        for c in s["cands"]:
            t = time.time(); r = generate(model, proc, prompt, [c["frame"]], max_tokens=4, temperature=0.0, verbose=False); tt += time.time() - t; n += 1
            m_ = re.search(r"\d+", r.text if hasattr(r, "text") else str(r)); scores[c["frame"]] = float(m_.group(0)) if m_ else -1
else: place.refuse(f"method {M!r} is not siglip, decider-vision, decider-text, bge-text or qwen3vl")
rank = {s["slot"]: [c["frame"] for c in sorted(s["cands"], key=lambda c: -scores[c["frame"]])] for s in S}
meta = {"method": M, "model": MODEL, "ms_per_candidate": round(1000*tt/max(n,1)), "n": n, "maxrss_GB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9,2), "wall_s": round(time.time()-t0)}
print(meta)
result = {"meta": meta, "scores": scores, "rank": rank}
if R.get("reference"):
    # each slot's best frame against the reference's first, and within its first three
    who = place.need(R, "reference_name"); one = within = 0; n = 0
    for s in S:
        ref = R["reference"].get(str(s["slot"]))
        if not ref or not rank.get(s["slot"]): continue
        frames = {f"c{ci}": f for ci, f in enumerate(ORIG[s["slot"]])}
        ref = [frames.get(x, x) for x in ref]; best = rank[s["slot"]][0]; n += 1
        one += best == ref[0]; within += best in ref[:3]
    result["agreement"] = {"top1": f"{one}/{n}", f"top1_in_{who}_top3": f"{within}/{n}"}
place.answer(result)

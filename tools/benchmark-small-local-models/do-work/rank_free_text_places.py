"""place is free text: rank every distinct Opus place string in the sample for each frame.
qwen3vl: embed its own place phrase (bge-small) and rank Opus strings by cosine. siglip: image vs 'a photo of <place>'.
(As first run: Opus wrote the reference labels, qwen3vl gave the phrases, bge-small and siglip ranked. Here the
reference labels, the phrases and both models are the request's.)

  python3 tools/benchmark-small-local-models/do-work/rank_free_text_places.py <request.json>   (or stdin)

Request: shots (with frame and reference), field (the free-text reference field, for example place), phrased (a
label_frames_with_vision_language_model.py answer, or its file, whose rows hold that field), embedder (a
sentence-transformers model; without one, the small public BAAI/bge-small-en-v1.5), image_text_model (an open_clip name), device (optional), write_to.
Answer: { result: { distinct_places, chance_top1, chance_top5, "<vl>_phrase+<embedder>": { n, top1, top5 },
"<image model>_image": { n, top1, top5 } } }."""
import json, sys
from pathlib import Path
import torch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"read-data")); import computer
R = computer.request(); F = computer.need(R, "field")
DEV = computer.device()
S = computer.shots_of(R); idx = [i for i, s in enumerate(S) if "frame" in s]
places = sorted({S[i]["reference"][F] for i in idx if S[i]["reference"][F] not in ("", "unknown")})
if not places: computer.refuse(f"no sampled shot has a reference {F}: check `field`")
from sentence_transformers import SentenceTransformer
if R.get("embedder"): emb = SentenceTransformer(R["embedder"], device=DEV)
else:
    emb = SentenceTransformer("BAAI/bge-small-en-v1.5", device=DEV)
    R["embedder"] = "BAAI/bge-small-en-v1.5"
P = emb.encode(places, normalize_embeddings=True, convert_to_tensor=True)
PH = computer.json_of(computer.need(R, "phrased"), "phrased")
Q = {r["i"]: r.get(F) or "" for r in PH["rows"]}
def score(rank_fn):
    t1 = t5 = n = 0
    for i in idx:
        g = S[i]["reference"][F]
        if g not in places: continue
        order = rank_fn(i); n += 1; t1 += order[0] == g; t5 += g in order[:5]
    return {"n": n, "top1": round(t1/n, 3), "top5": round(t5/n, 3)}
qe = {i: emb.encode([Q.get(i, "")], normalize_embeddings=True, convert_to_tensor=True)[0] for i in idx}
r_q = score(lambda i: [places[j] for j in torch.argsort(P @ qe[i], descending=True).tolist()])
import open_clip
from PIL import Image
M = computer.need(R, "image_text_model")
model, pre = open_clip.create_model_from_pretrained(M); tok = open_clip.get_tokenizer(M)
if hasattr(tok, "tokenizer") and not hasattr(type(tok.tokenizer), "batch_encode_plus"):
    type(tok.tokenizer).batch_encode_plus = lambda self, *a, **k: self(*a, **k)
model = model.to(DEV).eval()
with torch.no_grad():
    T = torch.nn.functional.normalize(model.encode_text(tok([f"a photo of {p}" for p in places]).to(DEV)), dim=-1)
    IE = {i: torch.nn.functional.normalize(model.encode_image(pre(Image.open(S[i]["frame"]).convert("RGB")).unsqueeze(0).to(DEV)), dim=-1)[0] for i in idx}
r_s = score(lambda i: [places[j] for j in torch.argsort(T @ IE[i], descending=True).tolist()])
name = lambda m: str(m).rstrip("/").split("/")[-1]
out = {"distinct_places": len(places), "chance_top1": round(1/len(places), 3), "chance_top5": round(5/len(places), 3),
       f"{PH.get('meta', {}).get('model', 'phrases')}_phrase+{name(R['embedder'])}": r_q, f"{name(M)}_image": r_s}
print(out); computer.answer(out)

"""place is free text: rank every distinct Opus place string in the sample for each frame.
qwen3vl: embed its own place phrase (bge-small) and rank Opus strings by cosine. siglip: image vs 'a photo of <place>'."""
import json, sys
from pathlib import Path
import torch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"lib")); import place
DEV = place.device()
H = Path(__file__).parent
S = json.load(open(H/"sample.json")); idx = [i for i, s in enumerate(S) if "frame" in s]
places = sorted({S[i]["opus"]["place"] for i in idx if S[i]["opus"]["place"] not in ("", "unknown")})
from sentence_transformers import SentenceTransformer
emb = SentenceTransformer("BAAI/bge-small-en-v1.5", device=DEV)
P = emb.encode(places, normalize_embeddings=True, convert_to_tensor=True)
Q = {r["i"]: r.get("place") or "" for r in json.load(open(H/"pred-qwen3vl-2b.json"))["rows"]}
def score(rank_fn):
    t1 = t5 = n = 0
    for i in idx:
        g = S[i]["opus"]["place"]
        if g not in places: continue
        order = rank_fn(i); n += 1; t1 += order[0] == g; t5 += g in order[:5]
    return {"n": n, "top1": round(t1/n, 3), "top5": round(t5/n, 3)}
qe = {i: emb.encode([Q.get(i, "")], normalize_embeddings=True, convert_to_tensor=True)[0] for i in idx}
r_q = score(lambda i: [places[j] for j in torch.argsort(P @ qe[i], descending=True).tolist()])
import open_clip
from PIL import Image
M = "hf-hub:timm/ViT-SO400M-16-SigLIP2-384"
model, pre = open_clip.create_model_from_pretrained(M); tok = open_clip.get_tokenizer(M)
type(tok.tokenizer).batch_encode_plus = lambda self, *a, **k: self(*a, **k)
model = model.to(DEV).eval()
with torch.no_grad():
    T = torch.nn.functional.normalize(model.encode_text(tok([f"a photo of {p}" for p in places]).to(DEV)), dim=-1)
    IE = {i: torch.nn.functional.normalize(model.encode_image(pre(Image.open(S[i]["frame"]).convert("RGB")).unsqueeze(0).to(DEV)), dim=-1)[0] for i in idx}
r_s = score(lambda i: [places[j] for j in torch.argsort(T @ IE[i], descending=True).tolist()])
out = {"distinct_places": len(places), "chance_top1": round(1/len(places), 3), "chance_top5": round(5/len(places), 3), "qwen3vl_phrase+bge": r_q, "siglip2_image": r_s}
print(out); json.dump(out, open(H/"place-scores.json", "w"), indent=1)

#!/usr/bin/env python3
# tools/match/tcc_encoder.py
#
# PURPOSE: The PHASE factor of the factorized motion-correspondence primitive (plan
# 2026-06-18-motion-correspondence-generative-primitive.md, Codex-converged). A self-supervised
# Temporal Cycle-Consistency (TCC, arXiv:1904.07846) per-frame encoder over NORMALIZED KEYPOINT
# sequences. It learns, with NO labels, an embedding where frame i of one motion maps to the
# same-PHASE frame of another motion BY THE SAME PERSON OR A DIFFERENT ONE — because the input is
# skeleton-only (pixels never seen → identity/appearance contamination is structurally impossible,
# the L063 reason CLIP failed). "What part of the stroke is this" then = nearest neighbour in embedding
# space, cross-identity, for free.
#
# Normalization (CRITICAL — drop identity, KEEP view): translate to hip-mid, scale by torso length,
# DO NOT rotate (rotation/orientation carries camera view + handedness — those are RETAINED factors,
# never folded). Confidence kept as a channel (visibility is part of the geometry signal).
#
# Domain-agnostic: a "sequence" is any tracked-entity keypoint trajectory; tennis/basketball/reading
# all feed the same encoder. ZERO domain vocabulary.
#
# USAGE: tcc_encoder.py train --index DIR [--epochs N] [--dim 32] [--out tcc.pt]
#        tcc_encoder.py align --model tcc.pt --a A.kp.json:W --b B.kp.json:W   (cross-clip phase map)

from __future__ import annotations
import argparse, glob, json, math, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # so `from pose_schema import` works when imported as a module
from pose_schema import COCO, JI, canonicalize_pose_track  # canonical pose schema (SSOT, iter67); #198.2 keypoint canonicalizer
import finite_json as FJ  # #198.6: descriptor reads travel the finite waist (keypoint reads use canonicalize_pose_track, Codex #9)
MC = 0.3
def log(m): print(f"[tcc] {m}", file=sys.stderr, flush=True)

def main_person(kp):
    import statistics
    canonicalize_pose_track(kp)                              # #198.2: a NaN keypoint -> absent (conf 0) before any k[1]/k[2] math (covers tcc_encoder + correspondence._arr, which select via this; idempotent on already-canonical data)
    best=None; bs=-1
    for p in kp.get("persons", []):
        hs=[]
        for f in p["frames"]:
            ys=[k[1] for k in f["kp"] if k[2]>=MC]
            if len(ys)>=6: hs.append(max(ys)-min(ys))
        if hs:
            sc=len(hs)*statistics.median(hs)
            if sc>bs: bs=sc; best=p
    return best

def normalize_frames(frames):
    """[T,51] normalized: translate hip-mid→0, scale by torso length, KEEP rotation. (x,y,conf) per joint."""
    import numpy as np
    out=[]
    for f in frames:
        k=f["kp"]
        def P(i): return k[JI[i]]
        lh,rh = P("l_hip"),P("r_hip"); ls,rs = P("l_shoulder"),P("r_shoulder")
        hipmid=((lh[0]+rh[0])/2,(lh[1]+rh[1])/2); shmid=((ls[0]+rs[0])/2,(ls[1]+rs[1])/2)
        scale=math.hypot(shmid[0]-hipmid[0], shmid[1]-hipmid[1]) or 1.0
        row=[]
        for j in range(17):
            x,y,c=k[j]
            row += [ (x-hipmid[0])/scale, (y-hipmid[1])/scale, c if c>=MC else 0.0 ]
        out.append(row)
    return np.asarray(out, dtype="float32")  # [T,51]

def subsample(arr, max_frames):
    """Uniformly subsample a long sequence to <=max_frames (keeps phase shape, bounds the [T,T] cost)."""
    import numpy as np
    if len(arr)<=max_frames: return arr
    idx=np.linspace(0, len(arr)-1, max_frames).round().astype(int)
    return arr[idx]

def load_sequences(index, min_len=8, max_frames=80):
    """Each motion window of each descriptor → one normalized keypoint sequence (a single 'event')."""
    import numpy as np
    seqs=[]
    for df in sorted(glob.glob(str(Path(index)/"*.desc.json"))):
        key=os.path.basename(df).replace(".desc.json","")
        kpf=Path(index)/"_work"/f"{key}.kp.json"
        if not kpf.exists(): continue
        try:
            d=FJ.load_text(df); kp=canonicalize_pose_track(json.loads(kpf.read_text()))  # #198.6: desc→waist, kp→canonicalize
        except Exception: continue
        person=main_person(kp)
        if not person: continue
        fps=kp.get("video",{}).get("fps",30.0) or 30.0
        frames=person["frames"]; tmap=[fr["t"] for fr in frames]
        for w in d.get("windows",[]):
            lo=min(range(len(tmap)), key=lambda i: abs(tmap[i]-w.get("t0",0)))
            hi=min(range(len(tmap)), key=lambda i: abs(tmap[i]-w.get("t1",0)))
            if hi-lo < min_len: continue
            arr=normalize_frames(frames[lo:hi+1])
            if len(arr)>=min_len: seqs.append(subsample(arr, max_frames))
    return seqs

# ---- model ----
def build_model(dim):
    import torch, torch.nn as nn
    class TCC(nn.Module):
        def __init__(s):
            super().__init__()
            s.net=nn.Sequential(
                nn.Conv1d(51,128,5,padding=2), nn.ReLU(),
                nn.Conv1d(128,128,5,padding=2), nn.ReLU(),
                nn.Conv1d(128,dim,3,padding=1))
        def forward(s,x):                      # x: [B,T,51]
            e=s.net(x.transpose(1,2)).transpose(1,2)   # [B,T,dim]
            return e/ (e.norm(dim=-1,keepdim=True)+1e-6)
    return TCC()

def cycle_loss(emb_u, emb_v):
    """TCC cycle-back regression (arXiv:1904.07846): soft-NN u→v→u must return to i. MSE on the index."""
    import torch
    Tu=emb_u.shape[0]; Tv=emb_v.shape[0]
    d_uv = ((emb_u[:,None,:]-emb_v[None,:,:])**2).sum(-1)   # [Tu,Tv]
    alpha = torch.softmax(-d_uv, dim=1)                     # soft NN of each u in v
    soft_v = alpha @ emb_v                                  # [Tu,dim]
    d_back = ((soft_v[:,None,:]-emb_u[None,:,:])**2).sum(-1)  # [Tu,Tu]
    beta = torch.softmax(-d_back, dim=1)
    idx = torch.arange(Tu, dtype=torch.float32, device=emb_u.device)
    ret = beta @ idx                                        # predicted return position
    return ((ret-idx)**2).mean()/max(1,Tu)

def train(index, epochs, dim, outp):
    import torch, numpy as np, random
    seqs=load_sequences(index)
    log(f"loaded {len(seqs)} motion sequences")
    if len(seqs)<4: log("too few sequences"); return 1
    dev="mps" if torch.backends.mps.is_available() else "cpu"
    model=build_model(dim).to(dev)
    opt=torch.optim.Adam(model.parameters(), lr=1e-3)
    # deterministic pairing schedule (no RNG seed dependence on Date): index-derived
    N=len(seqs)
    for ep in range(epochs):
        tot=0.0; nb=0
        order=[(i,(i*7+ep*3+1)%N) for i in range(N)]
        for i,j in order:
            if i==j: j=(j+1)%N
            u=torch.from_numpy(seqs[i]).unsqueeze(0).to(dev)
            v=torch.from_numpy(seqs[j]).unsqueeze(0).to(dev)
            eu=model(u)[0]; ev=model(v)[0]
            loss=cycle_loss(eu,ev)+cycle_loss(ev,eu)
            opt.zero_grad(); loss.backward(); opt.step()
            tot+=float(loss); nb+=1
        if ep%5==0 or ep==epochs-1: log(f"epoch {ep}: cycle-loss {tot/max(1,nb):.4f}")
    torch.save({"state":model.state_dict(),"dim":dim}, outp)
    log(f"saved {outp}")
    return 0

def align(model_path, a, b):
    import torch, numpy as np
    ck=torch.load(model_path, map_location="cpu"); model=build_model(ck["dim"]); model.load_state_dict(ck["state"]); model.eval()
    def load(spec):
        p,_,w=spec.partition(":"); kp=canonicalize_pose_track(json.loads(Path(p).read_text())); person=main_person(kp)  # #198.6: kp→canonicalize
        return normalize_frames(person["frames"])
    A=load(a); B=load(b)
    with torch.no_grad():
        ea=model(torch.from_numpy(A).unsqueeze(0))[0]; eb=model(torch.from_numpy(B).unsqueeze(0))[0]
    d=((ea[:,None,:]-eb[None,:,:])**2).sum(-1)
    nn=d.argmin(1)
    print(json.dumps({"len_a":len(A),"len_b":len(B),
                      "phase_map_a_to_b":[int(x) for x in nn.tolist()],
                      "monotonic_frac": float((nn[1:]>=nn[:-1]).float().mean())}))
    return 0

def main():
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="cmd")
    t=sub.add_parser("train"); t.add_argument("--index",required=True); t.add_argument("--epochs",type=int,default=40)
    t.add_argument("--dim",type=int,default=32); t.add_argument("--out",default="tools/match/tcc.pt")
    al=sub.add_parser("align"); al.add_argument("--model",required=True); al.add_argument("--a",required=True); al.add_argument("--b",required=True)
    a=ap.parse_args()
    if a.cmd=="train": return train(a.index,a.epochs,a.dim,a.out)
    if a.cmd=="align": return align(a.model,a.a,a.b)
    ap.print_help(); return 1

if __name__=="__main__": raise SystemExit(main())

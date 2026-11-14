#!/usr/bin/env python3
# tools/match/view_encoder.py
#
# PURPOSE: The learned VIEW factor of the factorized correspondence primitive (plan
# 2026-06-18-motion-correspondence-generative-primitive). Replaces the HAND-engineered viewpoint features
# (sideness/face_rel/leg_torso/ear_sign — which I, the programmer, PICKED = instance-solving) with a
# self-supervised, identity-invariant, learned clip-level view embedding.
#
# OBJECTIVE (InfoNCE contrastive): a positive pair = two FAR-APART-in-time temporal crops of the SAME clip
# (same camera angle, DIFFERENT motion phase → forces the embedding to be PHASE-INVARIANT but VIEW-sensitive).
# Negatives = crops of OTHER clips, EXCLUDING same-source siblings (a sub-clip of the same parent video is the
# same camera → a false negative; group-aware, same lesson as the eval leakage). Skeleton-only input → identity/
# appearance dropped STRUCTURALLY (the L063 reason CLIP failed). NO rotation/flip aug (view must stay sensitive;
# mirror is handled at MATCH time as equivariance, never folded).
#
# ZERO domain vocabulary. Output = one view embedding per clip-window → a generic FACTOR in correspondence.py.
#
# USAGE: view_encoder.py train --index DIR [--epochs N] [--dim 24] [--out view.pt]

from __future__ import annotations
import argparse, glob, json, os, sys
from pathlib import Path
import numpy as np
HERE=Path(__file__).resolve().parent; sys.path.insert(0,str(HERE))
import tcc_encoder as T
import finite_json as FJ                 # #198.6: descriptor reads via the finite waist
from pose_schema import canonicalize_pose_track  # #198.6: keypoint reads canonicalize per-keypoint (Codex #9)
from source_group import source_group   # LABEL-FREE leakage-exclusion key (iter61): the matcher's encoders must
#  NOT reach eval_viewpoint's ground-truth label_of — that is measurement-only (import-isolation lock §7).
def log(m): print(f"[view] {m}", file=sys.stderr, flush=True)

def load_with_groups(index, min_len=12, max_frames=80):
    items=[]
    for df in sorted(glob.glob(str(Path(index)/"*.desc.json"))):
        key=os.path.basename(df).replace(".desc.json",""); kpf=Path(index)/"_work"/f"{key}.kp.json"
        if not kpf.exists(): continue
        try: d=FJ.load_text(df); kp=canonicalize_pose_track(json.loads(kpf.read_text()))  # #198.6: desc→waist, kp→canonicalize
        except Exception: continue
        person=T.main_person(kp)
        if not person: continue
        frames=person["frames"]; tmap=[f["t"] for f in frames]; g=source_group(df)
        for w in d.get("windows",[]):
            lo=min(range(len(tmap)),key=lambda i:abs(tmap[i]-w.get("t0",0)))
            hi=min(range(len(tmap)),key=lambda i:abs(tmap[i]-w.get("t1",0)))
            if hi-lo<min_len: continue
            arr=T.subsample(T.normalize_frames(frames[lo:hi+1]),max_frames)
            items.append({"seq":arr,"group":g})   # label dropped (iter61): it was never read by the self-
            #  supervised InfoNCE loss (positives=temporal crops of same clip; negatives via "group") — dead.
    return items

def build_view_model(dim):
    import torch, torch.nn as nn
    class View(nn.Module):
        def __init__(s):
            super().__init__()
            s.conv=nn.Sequential(nn.Conv1d(51,128,5,padding=2),nn.ReLU(),
                                 nn.Conv1d(128,128,5,padding=2),nn.ReLU(),
                                 nn.Conv1d(128,dim,3,padding=1))
        def forward(s,x):                          # x:[B,T,51]
            h=s.conv(x.transpose(1,2))             # [B,dim,T]
            e=h.mean(-1)                           # clip-level pool → view (phase-invariant by pooling)
            return e/(e.norm(dim=-1,keepdim=True)+1e-6)
    return View()

def crop(arr, frac=0.5, which=0):
    """Far-apart temporal crops: which=0 → first half, which=1 → second half (different phase, same view)."""
    n=len(arr); L=max(8,int(n*frac))
    return arr[:L] if which==0 else arr[n-L:]

def train(index, epochs, dim, outp):
    import torch
    items=load_with_groups(index)
    log(f"loaded {len(items)} windows from {len(set(i['group'] for i in items))} source groups")
    if len(items)<8: log("too few"); return 1
    dev="mps" if torch.backends.mps.is_available() else "cpu"
    model=build_view_model(dim).to(dev); opt=torch.optim.Adam(model.parameters(),lr=1e-3)
    N=len(items); groups=[it["group"] for it in items]
    tau=0.1
    for ep in range(epochs):
        # two views per item: first-half and second-half crops (same camera, different phase)
        a=torch.stack([torch.from_numpy(_pad(crop(items[i]["seq"],0.55,0),80)) for i in range(N)]).to(dev)
        b=torch.stack([torch.from_numpy(_pad(crop(items[i]["seq"],0.55,1),80)) for i in range(N)]).to(dev)
        ea=model(a); eb=model(b)                       # [N,dim]
        sim=ea@eb.t()/tau                              # [N,N]
        # mask same-source (non-self) as neither positive nor negative → -inf so they don't act as false negatives
        gmask=torch.tensor([[ (groups[i]==groups[j] and i!=j) for j in range(N)] for i in range(N)],device=dev)
        sim=sim.masked_fill(gmask, float('-inf'))
        target=torch.arange(N,device=dev)
        loss=(torch.nn.functional.cross_entropy(sim,target)+torch.nn.functional.cross_entropy(sim.t(),target))/2
        opt.zero_grad(); loss.backward(); opt.step()
        if ep%10==0 or ep==epochs-1: log(f"epoch {ep}: infonce {float(loss):.4f}")
    torch.save({"state":model.state_dict(),"dim":dim}, outp); log(f"saved {outp}")
    return 0

def _pad(arr, T_):
    if len(arr)>=T_: return T.subsample(arr,T_)
    pad=np.repeat(arr[-1:],T_-len(arr),axis=0); return np.concatenate([arr,pad],0).astype("float32")

def main():
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="cmd")
    t=sub.add_parser("train"); t.add_argument("--index",required=True); t.add_argument("--epochs",type=int,default=120)
    t.add_argument("--dim",type=int,default=24); t.add_argument("--out",default="tools/match/view.pt")
    a=ap.parse_args()
    if a.cmd=="train": return train(a.index,a.epochs,a.dim,a.out)
    ap.print_help(); return 1

if __name__=="__main__": raise SystemExit(main())

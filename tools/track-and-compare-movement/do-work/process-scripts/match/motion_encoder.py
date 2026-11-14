#!/usr/bin/env python3
# tools/match/motion_encoder.py
#
# PURPOSE: The MOTION-TYPE factor of the factorized correspondence primitive. cross-motion discrimination
# (forehand vs backhand vs serve) + CHIRALITY, learned self-supervised with ZERO domain labels.
#   - view_encoder : positives = far-apart temporal crops of same clip  → PHASE-invariant, VIEW-sensitive.
#   - motion_encoder: positives = same window under ROTATION only (camera ROLL) → ROLL-invariant, MOTION- AND
#     CHIRALITY-sensitive; the horizontal MIRROR of each window is an explicit HARD NEGATIVE.
#
# CHIRALITY ROOT FIX (gauntlet 2026-06-19, L055/L063): the prior objective made each window AND its mirror a
# POSITIVE pair (mirror-INVARIANCE). That single decision caused BOTH owner bugs: (1) a one-handed backhand is
# ~the mirror of a forehand, so mirror-invariance COLLAPSED forehand≈mirror(backhand)≈backhand → wrong-shot
# matches; (2) encode(x)≈encode(flip(x)) ERASED chirality → a lefty was never flipped to align with a righty.
# FIX: the mirror is a HARD NEGATIVE (push a motion AWAY from its mirror). Now forehand and backhand separate
# (a backhand is no longer pulled toward a mirrored forehand), and the direct-vs-reflected distance gap is real
# → correspondence.factor_dists.parity becomes a TRUE chirality signal the render trusts for the flip.
# Cross-handedness MATCHING still works: correspondence.py takes min-over-mirror at MATCH time, so a lefty's
# flipped motion still matches a righty's same stroke — but parity now reveals they were mirror-related.
# This is UNIVERSAL Physics (a motion ≠ its mirror, for ANY domain — no tennis, no labels). Negatives EXCLUDE
# same-source siblings; the own-mirror diagonal is KEPT as the key hard negative.
#
# HONEST SCOPE: in-plane rotation models camera ROLL, NOT azimuth/pitch (those are the VIEW factor's job).
# ZERO domain vocabulary. Output = one motion embedding per clip-window → a generic FACTOR in correspondence.py.
#
# USAGE: motion_encoder.py train --index DIR [--epochs N] [--dim 24] [--out motion.pt]

from __future__ import annotations
import argparse, glob, json, os, sys, math
from pathlib import Path
import numpy as np
HERE=Path(__file__).resolve().parent; sys.path.insert(0,str(HERE))
import tcc_encoder as T, view_encoder as V
# (iter61) removed `from eval_viewpoint import source_group, label_of` — both were DEAD imports here (zero
# call-sites; motion_encoder reuses V.load_with_groups for items). Kept eval_viewpoint out of the matcher's
# import closure so the LABEL-FREE invariant is structural (import-isolation lock §7), not just documented.
def log(m): print(f"[motion] {m}", file=sys.stderr, flush=True)

def rotate_flip(arr, theta, flip):
    """In-plane rotate (and optionally horizontal-flip) the normalized skeleton — DESTROYS absolute view,
    PRESERVES relative motion dynamics. cols per joint: (x,y,conf)."""
    a=arr.copy()
    c,s=math.cos(theta),math.sin(theta)
    x=a[:,0::3].copy(); y=a[:,1::3].copy()
    if flip: x=-x
    a[:,0::3]= c*x - s*y
    a[:,1::3]= s*x + c*y
    return a

def build_motion_model(dim):
    import torch, torch.nn as nn
    class Motion(nn.Module):
        def __init__(s):
            super().__init__()
            # velocity-aware: the conv stack sees the sequence; pooling makes it clip-level motion identity
            s.conv=nn.Sequential(nn.Conv1d(51,128,5,padding=2),nn.ReLU(),
                                 nn.Conv1d(128,128,5,padding=2),nn.ReLU(),
                                 nn.Conv1d(128,dim,3,padding=1))
        def forward(s,x):
            h=s.conv(x.transpose(1,2))
            e=h.mean(-1)
            return e/(e.norm(dim=-1,keepdim=True)+1e-6)
    return Motion()

def train(index, epochs, dim, outp):
    import torch
    items=V.load_with_groups(index)
    log(f"loaded {len(items)} windows from {len(set(i['group'] for i in items))} groups")
    if len(items)<8: log("too few"); return 1
    dev="mps" if torch.backends.mps.is_available() else "cpu"
    model=build_motion_model(dim).to(dev); opt=torch.optim.Adam(model.parameters(),lr=1e-3)
    N=len(items); groups=[it["group"] for it in items]; tau=0.1
    # deterministic per-epoch rotation angles (no RNG-seed dependence): vary by epoch+index.
    # RANGE = ±40° (camera ROLL variation), NOT ±180°. A serve rotated 180° in-plane puts the
    # serving arm DOWNWARD — that is a different motion, not the same one from another camera. Full
    # ±180° manufactured positives that look like genuinely different motions, so InfoNCE could not
    # converge (stalled at 2.35). ±40° models realistic camera tilt while preserving motion dynamics.
    AUG=40  # degrees, half-range — camera ROLL only. NO flip in the positives → chirality is PRESERVED.
    gmask=torch.tensor([[ (groups[i]==groups[j] and i!=j) for j in range(N)] for i in range(N)],device=dev)
    target=torch.arange(N,device=dev)
    CE=torch.nn.functional.cross_entropy
    for ep in range(epochs):
        th =[(((i*13+ep*29)%(2*AUG+1))-AUG)*math.pi/180 for i in range(N)]
        th2=[(((i*7 +ep*17)%(2*AUG+1))-AUG)*math.pi/180 for i in range(N)]
        # POSITIVES: two ROTATION-only views of each window (same chirality, different camera roll).
        a=torch.stack([torch.from_numpy(V._pad(rotate_flip(items[i]["seq"], th[i],  False),80)) for i in range(N)]).to(dev)
        b=torch.stack([torch.from_numpy(V._pad(rotate_flip(items[i]["seq"], th2[i], False),80)) for i in range(N)]).to(dev)
        # HARD NEGATIVE: the horizontal MIRROR of each window. Including em[i] (a window's OWN mirror) as a
        # negative is what forces the embedding to be CHIRALITY-SENSITIVE and to split forehand from
        # mirror(backhand) — the L055 root fix. (Same-source siblings stay masked; own-mirror diagonal i==i is
        # NOT masked by gmask, so it survives as the key hard negative.)
        m=torch.stack([torch.from_numpy(V._pad(rotate_flip(items[i]["seq"], th[i],  True ),80)) for i in range(N)]).to(dev)
        ea=model(a); eb=model(b); em=model(m)
        sim_pos=(ea@eb.t()/tau).masked_fill(gmask, float('-inf'))   # positive = diagonal; siblings masked
        sim_mir=(ea@em.t()/tau).masked_fill(gmask, float('-inf'))   # all mirrors are negatives (incl own-mirror)
        loss=CE(torch.cat([sim_pos, sim_mir], dim=1), target)       # [N,2N], positive at column i
        sim_pos_t=(eb@ea.t()/tau).masked_fill(gmask, float('-inf')) # symmetric anchor=b
        sim_mir_t=(eb@em.t()/tau).masked_fill(gmask, float('-inf'))
        loss=(loss+CE(torch.cat([sim_pos_t, sim_mir_t], dim=1), target))/2
        opt.zero_grad(); loss.backward(); opt.step()
        if ep%10==0 or ep==epochs-1: log(f"epoch {ep}: infonce {float(loss):.4f}")
    torch.save({"state":model.state_dict(),"dim":dim}, outp); log(f"saved {outp}")
    return 0

def main():
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="cmd")
    t=sub.add_parser("train"); t.add_argument("--index",required=True); t.add_argument("--epochs",type=int,default=150)
    t.add_argument("--dim",type=int,default=24); t.add_argument("--out",default="tools/match/motion.pt")
    a=ap.parse_args()
    if a.cmd=="train": return train(a.index,a.epochs,a.dim,a.out)
    ap.print_help(); return 1

if __name__=="__main__": raise SystemExit(main())

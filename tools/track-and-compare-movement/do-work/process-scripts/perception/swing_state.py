#!/usr/bin/env python3
# tools/match/swing_state.py
#
# THE MULTI-CHANNEL SWING STATE (gauntlet 2026-06-18, the person's full-correspondence spec). ONE representation
# of a motion as a set of BODY-INTRINSIC, phase-normalized CHANNELS — every requirement the user named is a
# PROJECTION of this single state (L069: build one primitive, not one matcher per requirement).
#
# ── iter66 ENUM DISSOLUTION (gauntlet "closed enums are never fine"; L063/L069/L076/L090) ──────────────────
# The channel set is now DATA, not code. Before iter66, state_for_window() hard-coded seven computation blocks
# (one `if` per channel) and DEFAULT_TOL/LABEL enumerated the seven names in Physics code — a closed enum: a
# new biomechanical channel meant editing this file (O(channels)). Now:
#
#   • A CHANNEL is a DATA row: {name, op, args, tol, label}.  Adding a channel = one row, zero core edits.
#   • An OPERATOR is a leaf capability in an INJECTED map (DEFAULT_OPERATORS): a pure geometric function
#     (ctx, **args) -> value. The generic core consumes the map; it does NOT own a hard-coded factory of
#     branches ("registry-in-name is not enough": the extensible list is a PARAMETER, the core never names a
#     channel, an op, or a joint). Adding an operator = one leaf function, zero edits to the dispatch loop.
#   • The seven tennis channels + five geometric operators below are the DEFAULT capability pack. A different
#     kinematic domain passes its own `channels=`/`operators=` (or just its own effector_joint) — byte-identical
#     for tennis (proven: tools/match/_si_harness.py over 61 real windows + 1600 pair-compares, iter66).
#
# The DEFAULT tennis channels (each a config of the generic operators):
#   contact_height  — where the ball is met (effector wrist height above ground, body-heights)  ["ball contact height"]
#   stance_width    — feet separation at contact (body-heights)                                  ["stance"]
#   knee_bend       — active-leg knee angle at contact (load/posture)                            ["stance"]
#   approach        — center-of-mass travel BEFORE contact (running to the ball)                 ["running to the ball"]
#   recovery        — center-of-mass travel AFTER the follow-through                             ["recovery afterward"]
#   swing_arc       — EFFECTOR path relative to torso over the whole motion                      ["the swing" + "after contact"]
#   leg_finish      — active-leg ankle path relative to torso, AFTER contact                     ["how the legs finish"]
#
# WHY BODY-NORMALIZED + COMPARED ONLY POST-HEADING-GATE: these channels are made cross-IDENTITY comparable by
# normalizing every length by body height (head→feet) and centering on the torso, and phase-normalized by
# resampling to a fixed number of points. They DO carry some camera-foreshortening, but the heading gate
# (body_orientation.py) has already constrained the pair to the SAME camera family (≤~75° azimuth), so the
# residual foreshortening is small and the comparison is valid. Camera AZIMUTH/ELEVATION are their own
# channels (heading + CLIP elevation); this module owns the body/biomechanics + situation channels.
#
# SCOPE HONESTY (iter66, Codex-converged D74): this is RANKING-only (NOT the certified safety gate), and the
# representation floor is the COCO-17 human body — genericizing the channel SET removes a closed enum from the
# codebase; it does NOT by itself reach "any non-body domain" (that is bounded by the pose estimator, S10-🟡).
#
# court_position ("where on the court") is NOT yet a channel — it needs court-line homography; compare()
# reports it as "not_measured" rather than silently passing (L116: never claim an unmeasured requirement).
#
# CONTRACT (public surface preserved across the iter66 refactor):
#   state_for_window(person, lo, hi, hand, fps, n=10, effector_joint=None, channels=None, operators=None)
#       -> {channel_name: value|None}  (None per-channel when its keypoints are absent; fail-closed)
#   compare(qa, qb, tol=None, channels=None)
#       -> {"channels": {name: {dist, pass|None, label}}, "met": k, "measured": m, "score": float}
#   channel_dist(name, a, b) -> float|None ;  DEFAULT_TOL / LABEL : derived {name: tol|label} maps
from __future__ import annotations
import math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))  # so `from pose_schema import` works when imported as a module
from pose_schema import COCO, JI  # canonical pose schema (SSOT, iter67) — was a local COCO/JI duplicate (my own iter66 leak)
MC=0.3

def _ok(kp, name): return kp[JI[name]][2] >= MC
def _p(kp, name): return (kp[JI[name]][0], kp[JI[name]][1])

def _body_h(kp):
    head=[kp[JI[n]][1] for n in ("nose","l_eye","r_eye","l_ear","r_ear") if _ok(kp,n)]
    feet=[kp[JI[n]][1] for n in ("l_ankle","r_ankle") if _ok(kp,n)]
    if not head or not feet: return None
    return max(1.0, max(feet)-min(head))

def _torso(kp):
    pts=[_p(kp,n) for n in ("l_shoulder","r_shoulder","l_hip","r_hip") if _ok(kp,n)]
    if len(pts)<2: return None
    return (sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts))

def _feet_y(kp):
    fy=[kp[JI[n]][1] for n in ("l_ankle","r_ankle") if _ok(kp,n)]
    return max(fy) if fy else None

def _angle(a,b,c):
    if not (a and b and c): return None
    v1=(a[0]-b[0],a[1]-b[1]); v2=(c[0]-b[0],c[1]-b[1])
    n1=math.hypot(*v1); n2=math.hypot(*v2)
    if n1<1e-6 or n2<1e-6: return None
    d=max(-1,min(1,(v1[0]*v2[0]+v1[1]*v2[1])/(n1*n2)))
    return math.degrees(math.acos(d))

def _contact_idx(frames, hand, effector_joint=None):
    """Peak EFFECTOR speed within the frames = contact. effector_joint = DATA (None=racket-wrist → byte-identical;
    a footwork domain passes its ankle so 'contact' = the ankle-strike, iter47)."""
    w=effector_joint or f"{'l' if hand=='l' else 'r'}_wrist"; wi=JI[w]
    best=0; bi=len(frames)//2
    for k in range(1,len(frames)):
        a=frames[k-1]["kp"][wi]; b=frames[k]["kp"][wi]
        if a[2]>=MC and b[2]>=MC:
            s=math.dist(a[:2],b[:2])
            if s>best: best=s; bi=k
    return bi

def _resample(seq, n):
    if not seq: return None
    if len(seq)==1: return [seq[0]]*n
    out=[]
    for i in range(n):
        f=i*(len(seq)-1)/(n-1); lo=int(f); hi=min(lo+1,len(seq)-1); t=f-lo
        out.append(tuple(seq[lo][d]*(1-t)+seq[hi][d]*t for d in range(len(seq[lo]))))
    return out

# ── THE OPERATOR PACK (leaf capabilities) ──────────────────────────────────────────────────────────────────
# Each operator is a pure geometric function over a window CONTEXT + DATA args. The generic state_for_window
# core never references any of these by name — it dispatches through the injected `operators` map. Role tokens
# ("effector"/"active_hip"/…) and temporal anchors ("start"/"contact"/"end") are the operator pack's OWN
# coordinate system (resolved by the context), NOT a Society vocabulary in the generic core: a single windowed
# motion event HAS a beginning, one salient peak, and an end — that temporal triple is Physics-closed (an
# algebraic state, like Option/Result), it is not extended by user preference.
class _Ctx:
    """Per-window precomputed geometry handed to every operator. Built once; holds the contact frame, the
    contact-frame body-height/torso/feet baseline, the resample count, and the role→COCO-joint map derived
    from (hand, effector_joint)."""
    __slots__=("frames","ci","ck","bh","tc","fy","n","_roles")
    def __init__(self, frames, hand, n, effector_joint):
        self.frames=frames; self.n=n
        self.ci=_contact_idx(frames, hand, effector_joint)
        self.ck=frames[self.ci]["kp"]
        self.bh=_body_h(self.ck); self.tc=_torso(self.ck); self.fy=_feet_y(self.ck)
        s='l' if hand=='l' else 'r'
        w=effector_joint or f"{s}_wrist"
        self._roles={"effector":w,"active_hip":f"{s}_hip","active_knee":f"{s}_knee","active_ankle":f"{s}_ankle"}
    def resolve(self, token):
        """Role token → concrete COCO joint; literal COCO names (e.g. 'l_ankle') fall straight through."""
        return self._roles.get(token, token)
    def anchor(self, a):
        """Temporal anchor → frame index within the window."""
        return {"start":0,"contact":self.ci,"end":len(self.frames)-1}[a]

def _op_joint_height(ctx, joint):
    """Vertical offset of a joint above the feet line, body-normalized (higher value = higher)."""
    j=ctx.resolve(joint); ck=ctx.ck
    if ctx.bh and _ok(ck,j) and ctx.fy is not None:
        return round((ctx.fy - ck[JI[j]][1])/ctx.bh, 4)
    return None

def _op_pair_separation_x(ctx, a, b):
    """Horizontal separation between two joints at contact, body-normalized."""
    ja=ctx.resolve(a); jb=ctx.resolve(b); ck=ctx.ck
    if ctx.bh and _ok(ck,ja) and _ok(ck,jb):
        return round(abs(ck[JI[ja]][0]-ck[JI[jb]][0])/ctx.bh, 4)
    return None

def _op_joint_angle(ctx, a, b, c):
    """Interior angle a-b-c at contact, normalized to [0,1] (÷180°)."""
    ja=ctx.resolve(a); jb=ctx.resolve(b); jc=ctx.resolve(c); ck=ctx.ck
    ang=_angle(_p(ck,ja) if _ok(ck,ja) else None,
               _p(ck,jb) if _ok(ck,jb) else None,
               _p(ck,jc) if _ok(ck,jc) else None)
    if ang is not None: return round(ang/180.0, 4)
    return None

def _op_com_travel(ctx, frm, to):
    """Center-of-mass (torso) travel across a phase [frm,to], normalized by mid-window body height."""
    frames=ctx.frames
    coms=[(i,_torso(f["kp"]),_body_h(f["kp"])) for i,f in enumerate(frames)]
    coms=[(i,c,b) for i,c,b in coms if c and b]
    if len(coms)<3: return None
    bref=coms[len(coms)//2][2]
    f0=ctx.anchor(frm); f1=ctx.anchor(to)
    seg=[c for i,c,b in coms if f0<=i<=f1]
    if len(seg)<2: return None
    return round(math.dist(seg[0],seg[-1])/bref, 4)

def _op_joint_trajectory(ctx, joint, frm, to):
    """A joint's path relative to the torso across a phase [frm,to], body-normalized, resampled to ctx.n points."""
    j=ctx.resolve(joint); frames=ctx.frames
    f0=ctx.anchor(frm); f1=ctx.anchor(to)
    traj=[]
    for idx in range(f0, f1+1):
        kp=frames[idx]["kp"]; b=_body_h(kp); t=_torso(kp)
        if b and t and _ok(kp,j):
            traj.append(((kp[JI[j]][0]-t[0])/b, (kp[JI[j]][1]-t[1])/b))
    if len(traj)<3: return None
    return [ [round(x,3),round(y,3)] for x,y in _resample(traj, ctx.n) ]

# DEFAULT OPERATOR PACK — leaf capabilities, injected into the generic core (overridable via operators=).
DEFAULT_OPERATORS={
    "joint_height":_op_joint_height,
    "pair_separation_x":_op_pair_separation_x,
    "joint_angle":_op_joint_angle,
    "com_travel":_op_com_travel,
    "joint_trajectory":_op_joint_trajectory,
}

# DEFAULT CHANNEL PACK — the seven tennis channels as DATA (ORDER is the scorecard order the user reads, and is
# preserved byte-identically from the pre-iter66 hard-coded dict). tol = pass distance (calibrated coarse;
# scalars in body-heights / normalized angle; trajectories = mean per-point Euclidean distance in body-heights).
# label = the human-readable requirement name for the scorecard.
DEFAULT_CHANNELS=[
    {"name":"contact_height","op":"joint_height",      "args":{"joint":"effector"},                              "tol":0.12,"label":"contact height"},
    {"name":"stance_width",  "op":"pair_separation_x", "args":{"a":"l_ankle","b":"r_ankle"},                     "tol":0.12,"label":"stance width"},
    {"name":"knee_bend",     "op":"joint_angle",       "args":{"a":"active_hip","b":"active_knee","c":"active_ankle"},"tol":0.08,"label":"knee bend/load"},
    {"name":"approach",      "op":"com_travel",        "args":{"frm":"start","to":"contact"},                    "tol":0.25,"label":"running to the ball"},
    {"name":"recovery",      "op":"com_travel",        "args":{"frm":"contact","to":"end"},                      "tol":0.25,"label":"recovery after"},
    {"name":"swing_arc",     "op":"joint_trajectory",  "args":{"joint":"effector","frm":"start","to":"end"},     "tol":0.16,"label":"swing path"},
    {"name":"leg_finish",    "op":"joint_trajectory",  "args":{"joint":"active_ankle","frm":"contact","to":"end"},"tol":0.18,"label":"legs finish"},
]
# Derived back-compat maps (external callers read SS.DEFAULT_TOL / SS.LABEL). Single source = DEFAULT_CHANNELS.
DEFAULT_TOL={c["name"]:c["tol"] for c in DEFAULT_CHANNELS}
LABEL={c["name"]:c["label"] for c in DEFAULT_CHANNELS}

def state_for_window(person, lo, hi, hand, fps, n=10, effector_joint=None, channels=None, operators=None):
    """Extract the body-intrinsic, phase-normalized channels for the motion window [lo,hi] by running the
    channel DATA through the operator pack. All lengths in body-heights, all positions relative to the torso
    center, trajectories resampled to n points. Each channel is None when its keypoints are absent (fail-closed:
    never fabricate). The EFFECTOR (whose contact/arc are measured) = DATA via effector_joint (None=racket-wrist
    → byte-identical); stance/knee/COM/leg channels are universal body geometry on the active side, so they apply
    to any kinematic domain (iter47). channels/operators default to the tennis-body pack and are overridable for
    another domain (iter66 enum dissolution)."""
    frames=person["frames"][lo:hi+1]
    if len(frames)<3: return None
    channels=channels if channels is not None else DEFAULT_CHANNELS
    operators=operators if operators is not None else DEFAULT_OPERATORS
    ctx=_Ctx(frames, hand, n, effector_joint)
    out={}
    for ch in channels:
        out[ch["name"]]=operators[ch["op"]](ctx, **ch.get("args",{}))
    return out

# ---- comparison + scorecard --------------------------------------------------------------------------
def _scalar_dist(a,b): return abs(float(a)-float(b))
def _traj_dist(a,b):
    n=min(len(a),len(b))
    if n==0: return None
    return sum(math.dist(a[i],b[i]) for i in range(n))/n

def channel_dist(name, a, b):
    if a is None or b is None: return None
    if isinstance(a,list): return _traj_dist(a,b)
    return _scalar_dist(a,b)

def compare(qa, qb, tol=None, channels=None):
    """Compare two swing-state dicts → per-channel distance + pass, plus a summary (met/measured/score).
    A channel only counts when BOTH clips have it (else 'not_measured'); never claims an unmeasured pass.
    Iterates the channel DATA (tol + label travel WITH the channel); an explicit tol dict overrides per name
    (back-compat: tol or DEFAULT_TOL, same as before iter66)."""
    channels=channels if channels is not None else DEFAULT_CHANNELS
    chans={}; met=0; measured=0; dsum=0.0; dn=0
    for ch in channels:
        name=ch["name"]; ct=tol[name] if tol else ch["tol"]   # tol travels WITH the channel DATA; explicit dict overrides
        d=channel_dist(name, (qa or {}).get(name), (qb or {}).get(name))
        if d is None:
            chans[name]={"dist":None,"pass":None,"label":ch["label"]}      # not measured for this pair
            continue
        measured+=1; ok=d<=ct; met+=int(ok)
        chans[name]={"dist":round(d,4),"pass":ok,"label":ch["label"]}
        dsum+=min(1.0, d/(2*ct)); dn+=1                                     # normalized closeness for total score
    score=round(dsum/dn,4) if dn else None                                 # 0=perfect, 1=poor (lower better)
    return {"channels":chans,"met":met,"measured":measured,"score":score}

#!/usr/bin/env python3
# tools/match/correspondence.py
#
# PURPOSE: The factorized correspondence MATCH (plan 2026-06-18-motion-correspondence-generative-primitive,
# Codex-converged). match(z_query, z_candidate | intent-weights) over SEPARABLE, LEARNED factors + calibrated null.
#
# THE THREE FACTORS (all skeleton-only input → identity/appearance dropped STRUCTURALLY, L063; all domain-agnostic):
#   - VIEW   (view.pt)   : camera-view embedding. positives = far-apart temporal crops of the SAME clip
#                          → phase-INVARIANT, view-SENSITIVE. Low dist = same camera angle. Beats the hand
#                          viewpoint_dist (group-aware LOO 0.489 > 0.39) — so the hand feature is RETIRED here.
#   - PHASE  (tcc.pt)    : per-frame TCC embedding. alignment residual = how well two motions correspond in
#                          TIME. Drives render-SYNC (align query frame ↔ partner frame) and "same part of motion".
#   - MOTION (motion.pt) : motion-type embedding. positives = same clip + ROTATION/FLIP aug (±40° camera roll)
#                          → ROLL-invariant (NOT proven full camera-view-invariant — roll ≠ azimuth), motion-
#                          SENSITIVE. Low dist = same stroke (serve vs forehand). Mirror handled via min-over-flip.
#
# match score = w_view·view_dist + w_phase·phase_cost + w_motion·motion_dist. WEIGHTS ARE DATA (per comparison
# intent), never hardcoded. For "same stroke, same camera angle, time-synced side-by-side" the intent supplies
# high w_motion + high w_view; phase ranks/sync. Returns ranked candidates OR an explicit null ("no reliable
# correspondence") when the best factor-distance exceeds a CALIBRATED threshold — never forced nearest-neighbour
# decoration (Codex: a matcher that can't say "no match" isn't solving correspondence).
#
# DOMAIN-GENERIC RUNTIME: the factor composition in rank()/factor_dists() dispatches on NO domain vocabulary
# — no "tennis"/"forehand"/"side" string ever selects a code path; factors are generic, adding a domain = new
# corpus + new intent weights (DATA). (HONEST per Codex audit 2026-06-18: comments below DO name the tennis use
# case for readability, and the EVAL/label helpers parse view labels from filenames — but those are eval-only,
# never in the production match path.) This is the L069 primitive; the side-by-side is one projection.
#
# USAGE: importable.
#   corr = Correspondence()                       # loads view.pt + tcc.pt + motion.pt if present
#   q   = corr.window(kp_path, t0, t1)            # → factor bundle (cached)
#   pool= [corr.window(kp, a, b) for ...]
#   ranked, null = corr.rank(q, pool, weights={"view":1,"motion":1,"phase":0.5}, max_dist=...)
#   sync = corr.phase_align(q, ranked[0]["item"]) # per-frame query→partner index map for render time-sync

from __future__ import annotations
import json, sys, math
from pathlib import Path
import numpy as np
HERE=Path(__file__).resolve().parent; sys.path.insert(0, str(HERE))
import tcc_encoder as T
import view_encoder as V
from pose_schema import canonicalize_pose_track  # #198.6: keypoint reads canonicalize per-keypoint (Codex #9)
import motion_encoder as Mo

DEFAULT_MODELS={"view":"tools/match/view.pt","phase":"tools/match/tcc.pt","motion":"tools/match/motion.pt"}

class Correspondence:
    def __init__(self, models=None, root=None):
        import torch
        self.torch=torch
        self.root=Path(root) if root else HERE.parent.parent     # repo root (tools/match → ../../)
        m=dict(DEFAULT_MODELS)
        if models: m.update(models)
        self.factor={}                                            # name → (kind, model) ; kind in {clip,frame}
        self._load(m,"view",  V.build_view_model,  "clip")
        self._load(m,"motion",Mo.build_motion_model,"clip")
        self._load(m,"phase", T.build_model,       "frame")
        self._wcache={}                                           # (kp,t0,t1) → bundle

    def _load(self, m, name, builder, kind):
        p=Path(m[name])
        if not p.is_absolute():
            p=self.root/p
            # LAYOUT-AGNOSTIC fallback (L089): when the weight is not at the repo-relative path — e.g. this
            # module is running from a FLAT deployment bundle (the motion-comparison match process-job) instead
            # of the tools/match/ source tree — look for it CO-LOCATED with this module. The source-repo layout
            # resolves self.root/p first, so this is BYTE-IDENTICAL there (the fallback never fires); it only
            # activates where the repo path is absent (the bundle), making the deployment self-contained (the
            # .pt weights ship as bundle siblings) with NO env var and NO caller change.
            if not p.exists(): p=HERE/Path(m[name]).name
        if not p.exists(): return                                 # factor simply absent → its weight is ignored
        ck=self.torch.load(p, map_location="cpu")
        mod=builder(ck["dim"]); mod.load_state_dict(ck["state"]); mod.eval()
        self.factor[name]=(kind, mod)

    # ---- shared input pipeline: window → normalized, subsampled [T,51] skeleton array ----
    def _arr(self, kp_path, t0, t1, min_len=4):
        try: kp=canonicalize_pose_track(json.loads(Path(kp_path).read_text()))  # #198.6: keypoint waist (NaN kp → conf-0, never poisons the [T,51] array)
        except Exception: return None
        person=T.main_person(kp)
        if not person: return None
        frames=person["frames"]; tmap=[f["t"] for f in frames]
        lo=min(range(len(tmap)), key=lambda i: abs(tmap[i]-t0))
        hi=min(range(len(tmap)), key=lambda i: abs(tmap[i]-t1))
        if hi-lo < min_len: return None
        return T.subsample(T.normalize_frames(frames[lo:hi+1]), 80)

    @staticmethod
    def _flip_x(arr):
        """Horizontal mirror of a normalized skeleton: negate every joint's x (cols 0::3). Mirror is a
        CANDIDATE TRANSFORM (a left-handed player filmed from one side == a right-handed player filmed from
        the other, once one clip is flipped at render) — handled as min-over-flip at match, NEVER abs-folded."""
        a=arr.copy(); a[:,0::3]=-a[:,0::3]; return a

    def window(self, kp_path, t0, t1):
        """Compute (and cache) the full factor bundle for one motion window — the atom the solver compares.
        For the CLIP factors (view, motion) we also embed the horizontally-FLIPPED skeleton so the match can
        take min-over-mirror (the documented mirror-equivariance). PHASE is a temporal alignment — mirror does
        not change phase ordering — so it gets no flip variant."""
        key=(str(kp_path), round(float(t0),2), round(float(t1),2))
        if key in self._wcache: return self._wcache[key]
        arr=self._arr(kp_path, t0, t1)
        bundle={"key":key, "kp_path":str(kp_path), "t0":t0, "t1":t1,
                "view":None, "motion":None, "phase":None, "view_flip":None, "motion_flip":None}
        if arr is not None and len(arr)>=4:
            x=self.torch.from_numpy(arr).unsqueeze(0)
            xf=self.torch.from_numpy(self._flip_x(arr)).unsqueeze(0)
            with self.torch.no_grad():
                for name,(kind,mod) in self.factor.items():
                    bundle[name]=mod(x)[0].numpy()                # clip→[dim], frame→[T,dim]
                    if kind=="clip":                              # mirror variant for min-over-flip
                        bundle[name+"_flip"]=mod(xf)[0].numpy()
        self._wcache[key]=bundle; return bundle

    # ---- factor distances ----
    @staticmethod
    def _clip_dist(a,b):
        if a is None or b is None: return None
        return float(((a-b)**2).sum())                            # both L2-normalized → squared euclidean ∈[0,4]

    @staticmethod
    def _phase_cost(ea,eb):
        if ea is None or eb is None: return None
        d=((ea[:,None,:]-eb[None,:,:])**2).sum(-1)                # [Tq,Tc]
        return float(d.min(1).mean())                             # mean soft-NN residual query→candidate

    def _clip_dist_mirror(self, q, c, name):
        """min over the query's direct AND horizontally-flipped embedding vs the candidate (mirror = candidate
        transform; never abs-fold). Falls back to direct-only if no flip variant was computed."""
        d,_,_=self._clip_dist_mirror_p(q, c, name); return d

    def _clip_dist_mirror_p(self, q, c, name):
        """Like _clip_dist_mirror but ALSO returns the chirality PARITY — DERIVED from the motion, never a
        per-person handedness constant (the L063 instance-solving fix). Returns (dist_min, dist_direct, parity)
        where parity ∈ {'direct','reflected', None}:
          - 'direct'    : the un-flipped query aligns best → query and candidate are the SAME chirality.
          - 'reflected' : the horizontally-flipped query aligns best → OPPOSITE chirality (e.g. a left-mover vs
                          a right-mover). The render uses this to decide whether to mirror ONE clip so the two
                          motions travel the same way — a fact COMPUTED from the footage, not declared.
          - None        : no flip variant available → chirality undetermined (render must NOT mirror; fail-closed
                          to truthful, un-mirrored footage).
        dist_min is the robust matching distance (min over mirror, so opposite-chirality motions still MATCH);
        dist_direct is the same-chirality-only distance (for callers that must require identical chirality)."""
        direct=self._clip_dist(q.get(name), c.get(name))
        flipped=self._clip_dist(q.get(name+"_flip"), c.get(name))
        if direct is None and flipped is None: return None, None, None
        if flipped is None: return direct, direct, None          # no mirror variant → chirality undetermined
        if direct is None: return flipped, None, "reflected"
        parity="direct" if direct<=flipped else "reflected"
        return min(direct, flipped), direct, parity

    def factor_dists(self, q, c):
        # MOTION carries the primary chirality signal (the body's movement pattern); VIEW's parity agrees when
        # both are confident but MOTION is the one the render trusts for the mirror decision.
        mmin, mdir, mpar = self._clip_dist_mirror_p(q, c, "motion")
        return {"view":  self._clip_dist_mirror(q, c, "view"),
                "motion":mmin,
                "motion_direct":mdir,            # same-chirality-only motion distance
                "parity":mpar,                   # 'direct' | 'reflected' | None — DERIVED chirality, never declared
                "phase": self._phase_cost(q.get("phase"), c.get("phase"))}

    def rank(self, query, pool, weights=None, max_dist=None, top=5):
        """weights: dict factor→w (DATA per intent). Missing/None factor contributes 0. Returns (ranked, null)."""
        weights=weights or {"view":1.0,"motion":1.0,"phase":0.0}
        # capstone-9 #8 (HIGH): a NaN/Inf weight passes the dict but DEFEATS the null gate — `if w<=0: continue` is
        # False for NaN (the factor is NOT skipped), so tot becomes NaN and `scored[0]["dist"] > max_dist` is False →
        # null=False → a FABRICATED ranked match where calibrate_null/benchmark_xident (the S1 0-wrong CALIBRATION
        # path) expect a null. Validate weights (finite non-bool >=0, >=1 positive) + a finite max_dist BEFORE ranking.
        if not isinstance(weights, dict) or not weights:
            raise ValueError(f"Correspondence.rank weights must be a non-empty dict, got {weights!r}")
        _npos=0
        for _wn,_wv in weights.items():
            if isinstance(_wv,bool) or not isinstance(_wv,(int,float)) or not math.isfinite(_wv) or _wv<0:
                raise ValueError(f"Correspondence.rank weight {_wn!r} must be a finite number >= 0, got {_wv!r} "
                                 f"(NaN/Inf defeats the `w<=0` skip and poisons the null gate).")
            if _wv>0: _npos+=1
        if _npos==0:
            raise ValueError("Correspondence.rank needs at least one positive weight (all-zero ranks nothing).")
        if max_dist is not None and (isinstance(max_dist,bool) or not isinstance(max_dist,(int,float)) or not math.isfinite(max_dist)):
            raise ValueError(f"Correspondence.rank max_dist must be None or a finite number, got {max_dist!r} "
                             f"(NaN defeats the `dist > max_dist` null gate).")
        # capstone-10 #9: `top=0` returns an empty ranked list with `null=False` (looks like "matches exist but none
        # returned"); a negative top slices off an arbitrary tail. A result count must be a positive int.
        if isinstance(top,bool) or not isinstance(top,int) or top<=0:
            raise ValueError(f"Correspondence.rank top must be a positive int, got {type(top).__name__} {top!r}.")
        scored=[]
        for c in pool:
            d=self.factor_dists(query,c); tot=0.0; used=False; parts={}
            for name,w in weights.items():
                if w<=0: continue
                dv=d.get(name)
                # capstone-10 #8: a NaN/Inf factor DISTANCE (a poisoned descriptor) makes tot NaN, and the null gate
                # `scored[0]['dist'] > max_dist` is False for NaN → a fabricated ranked match where a null was expected.
                # capstone-9 #8 guarded the WEIGHTS; this guards the DISTANCES. A non-finite factor = unavailable → skip.
                if dv is None or not isinstance(dv,(int,float)) or isinstance(dv,bool) or not math.isfinite(dv): continue
                tot+=w*dv; used=True; parts[name]=round(dv,4)
            if not used: continue
            scored.append({"item":c, "dist":round(tot,4), "parts":parts})
        scored.sort(key=lambda x:x["dist"])
        null=(max_dist is not None and (not scored or scored[0]["dist"]>max_dist))
        return scored[:top], null

    # ---- render time-sync: per-query-frame nearest partner frame (TCC alignment) ----
    def phase_align(self, q, c):
        """Each query frame index → best-matching partner frame index (for side-by-side sync), plus
        monotonic_frac (how cleanly the alignment advances — a correspondence-quality signal). None if no phase."""
        ea=q.get("phase"); eb=c.get("phase")
        if ea is None or eb is None: return None
        if not (np.all(np.isfinite(ea)) and np.all(np.isfinite(eb))): return None  # F4 (capstone-15): a poisoned .pt phase model can emit NaN embeddings → argmin over a NaN distance matrix returns index 0 + monotonic_frac=1.0 (a FABRICATED perfect sync). Non-finite embedding = no usable phase → None (same as absent).
        d=((ea[:,None,:]-eb[None,:,:])**2).sum(-1)                # [Tq,Tc]
        nn=d.argmin(1)
        mono=float(np.mean(np.diff(nn)>=0)) if len(nn)>1 else 1.0
        return {"map":[int(x) for x in nn], "monotonic_frac":round(mono,3)}

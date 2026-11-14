#!/usr/bin/env python3
# tools/match/motion_certify.py
# THE CERTIFIED CORRESPONDENCE PRIMITIVE (gauntlet derivation 2026-06-20, LL 29/55/63/69/76/88/90/97/99/100/101).
# Generic, domain-free, label-free. Two motions CORRESPOND iff EVERY reliable observable channel agrees — not
# iff a weighted AVERAGE is low (averaging hides the one decisive divergence: the L055 root of wrong matches).
#
# Representation (L097 — use ALL observable info, not a hand-picked lossy few): the full normalized skeleton
# trajectory — ALL 17 keypoints over time, torso-centered + torso-scaled (identity-invariant), CHIRALITY-PRESERVED
# (no per-clip reflection — a motion and its mirror stay distinct; handedness is resolved per-pair as parity),
# contact-centered span (kills bloated-window mush, keeps the takeback), + per-keypoint confidence (observability).
#
# Certification (L063 category fix): align two trajectories by DTW on the confident skeleton, then for EACH
# keypoint channel compute the robust aligned divergence; CERTIFIED iff the WORST reliable channel ≤ ε AND enough
# channels are reliable. A backhand vs forehand diverges on the racket-arm channels → worst-channel large →
# cannot certify → no_match (never a confident wrong match: S1). Two genuinely-same motions agree on every
# channel → certify. When the discriminating channel is unobservable (foreshortened/occluded → low confidence)
# it is EXCLUDED; if too few channels remain reliable → no_match for lack of evidence (L099 observability gate).
#
# dist(a,b) returns (score, parity): score = worst reliable-channel divergence (lower = more same); parity from
# the chirality (mirror) test for the render mirror. Handedness MATCHING uses min over the direct/mirrored
# skeleton (so a lefty still matches a righty) — but the WORST-CHANNEL rule on the chosen orientation still
# vetoes a cross-motion pair, because mirror(forehand) ≠ backhand on the arm-shape channels.
from __future__ import annotations
import json, sys
from pathlib import Path
import numpy as np

# Canonical pose schema (SSOT, iter67 — Codex-converged): COCO names + index, the certified comparison
# channels (MOVE_KP) + mirror map, and the ComparisonSpec DATA type live in pose_schema — imported, not
# re-declared here (kills the 8-file COCO duplication; makes the comparison representation injectable DATA).
from pose_schema import COCO, JI, MOVE_KP, MIRROR, ComparisonSpec, DEFAULT_COMPARISON_SPEC, DEFAULT_EFFECTOR, canonicalize_pose_track  # noqa: F401  (#198.2 keypoint canonicalizer)
MC = 0.3
N = 24
CONTACT_BACK_S = 1.4
CONTACT_FWD_S = 1.0
# EPSILON (cert bar) + MIN_RELIABLE (observability gate) moved into ComparisonSpec (iter68): calibration is DATA
# per comparison-spec (defaults 0.55 / 8 → byte-identical). Read via spec.epsilon / spec.min_reliable, not here.

# ── SELF-DESCRIBING DESCRIPTOR (iter74, L090 — Codex capstone #2) ───────────────────────────────────────────
# A descriptor's mirror/channel meaning is DEFINED by the ComparisonSpec it was built under. Before iter73 the
# live path was all-default so a raw array was safe; once select() threads CUSTOM specs (iter73), a descriptor
# built under spec A could be dist()'d under spec B → mirror_idx indexes the wrong channels → silent mis-mirror
# (a WRONG certified parity). The fix is L090: the descriptor CARRIES its spec, and dist()/certified() RECONCILE
# — refusing (fail-loud) to compare two descriptors built under different specs, or to apply a spec that disagrees
# with the descriptors. The carrier is an ndarray SUBCLASS so .tobytes()/np.array_equal are byte-identical (the
# frozen S1 eval is unperturbed); the spec rides as an attribute, dropped on serialization (descriptors are always
# recomputed from kp files, never persisted).
# HONEST SCOPE (iter78, Codex #4/#5, L120): this is a STRONG live-path safeguard + fail-loud, NOT absolute structural
# impossibility. iter78 wraps at the _skel BIRTH point so EVERY descriptor is born self-describing (closing the
# _skel-direct bypass). But a strippable ndarray attribute can't be a mathematical guarantee: np.asarray() drops it,
# and the PRIVATE _mirror/_worst_channel helpers default spec=None without reconcile. The LIVE matcher (select →
# dist; check_video re-cert) takes neither bypass — every live descriptor flows as a CertifiedDescriptor through the
# public dist()/certified() reconcile boundary. The earlier iter74 "structurally impossible" wording was an overclaim.
class CertifiedDescriptor(np.ndarray):
    def __new__(cls, arr, spec):
        obj = np.asarray(arr, float).view(cls)
        obj.spec = spec
        return obj
    def __array_finalize__(self, obj):
        if obj is None: return
        self.spec = getattr(obj, "spec", None)

def _spec_fp(spec):
    """Content fingerprint of a comparison spec (None → DEFAULT). Two specs are interchangeable iff fingerprints
    match — covers channels, mirror wiring, observability gate, and cert bar (everything dist/certified rely on)."""
    spec = spec or DEFAULT_COMPARISON_SPEC
    return (tuple(spec.channels), tuple(spec.mirror_idx), spec.min_reliable, spec.epsilon)

def _reconcile(a, b, spec):
    """L090 safety boundary for the comparison entry points. Descriptors self-describe their spec; this REFUSES
    (ValueError) to compare descriptors built under different specs, or to apply a `spec` that disagrees with the
    descriptors — so a mis-mirror is structurally impossible, not merely avoided by convention. Returns the spec to
    use: the explicit one if given, else the descriptors' own (self-describing → no spec arg needed), else DEFAULT."""
    sa = getattr(a, "spec", None); sb = getattr(b, "spec", None)
    if sa is not None and sb is not None and _spec_fp(sa) != _spec_fp(sb):
        raise ValueError("motion_certify: descriptors built under DIFFERENT comparison specs — mis-mirror hazard "
                         "(L090). Rebuild both under one spec before dist()/certified().")
    carried = sa if sa is not None else sb
    if spec is not None and carried is not None and _spec_fp(spec) != _spec_fp(carried):
        raise ValueError("motion_certify: passed spec != the spec the descriptor(s) were built under — mis-mirror "
                         "hazard (L090). Pass the SAME spec used to build the descriptors, or omit it.")
    return spec or carried or DEFAULT_COMPARISON_SPEC

def _torso(kp):
    pts = {n: kp[JI[n]] for n in ("l_shoulder","r_shoulder","l_hip","r_hip")}
    conf = [p for p in pts.values() if p[2] >= MC]
    if len(conf) < 3: return None
    cx = sum(p[0] for p in conf)/len(conf); cy = sum(p[1] for p in conf)/len(conf)
    sh_y = np.mean([pts[n][1] for n in ("l_shoulder","r_shoulder") if pts[n][2] >= MC] or [cy])
    hip_y = np.mean([pts[n][1] for n in ("l_hip","r_hip") if pts[n][2] >= MC] or [cy])
    return cx, cy, max(abs(sh_y-hip_y), 1.0)

def _fps(person):
    fr = person["frames"]
    if len(fr) < 2: return 30.0
    dts = [fr[k]["t"]-fr[k-1]["t"] for k in range(1,len(fr)) if fr[k]["t"]>fr[k-1]["t"]]
    med = float(np.median(dts)) if dts else 1/30.0
    return 1.0/med if med > 1e-6 else 30.0

def _contact_clamp(person, lo, hi, salience_keypoints=None):
    # The contact CENTER (used only to CROP a bloated window down to its salient 2.4s span) is the peak of the
    # SALIENT-JOINT speed. WHICH joints are salient is DATA: salience_keypoints — None = the tennis wrist pair
    # (byte-identical with the original behaviour); ANY domain supplies its own via SalienceConfig.salience_keypoints
    # (e.g. ankles for footwork). SCOPE NOTE (iter46, Codex): this selects only the CROP CENTER; the certified
    # COMPARISON always runs over the full MOVE_KP limb+trunk skeleton (face/head EXCLUDED), so a domain whose
    # motion lives outside the limbs (e.g. a talking head) needs a different comparison-channel set, not just a
    # salience swap. Unknown joint names FAIL-CLOSED (raise) — no silent wrist fallback (a typo must not pass).
    names = tuple(salience_keypoints) if salience_keypoints else DEFAULT_EFFECTOR  # None = the universal hands default (pose_schema SSOT; iter92)
    bad = [n for n in names if n not in JI]
    if bad: raise ValueError(f"_contact_clamp: unknown salience keypoints {bad} (valid: {sorted(JI)})")
    sj = [JI[n] for n in names]
    fr = person["frames"]; lo = max(0,lo); hi = min(hi,len(fr))
    spd = []
    for k in range(lo,hi):
        kp = fr[k]["kp"]; t = _torso(kp)
        if t is None or k == lo: spd.append(0.0); continue
        pkp = fr[k-1]["kp"]; _,_,s = t
        def v(a,b): return np.hypot(a[0]-b[0],a[1]-b[1])/s if a[2]>=MC and b[2]>=MC else 0.0
        spd.append(max((v(kp[j], pkp[j]) for j in sj), default=0.0))
    if not spd or max(spd) <= 0: return lo, hi
    c = lo + int(np.argmax(spd)); fps = _fps(person)
    return max(lo, c-int(CONTACT_BACK_S*fps)), min(hi, c+int(CONTACT_FWD_S*fps)+1)

def _skel(person, lo, hi, salience_keypoints=None, spec=None):
    """(N, K, 3) torso-normalized (x,y,conf) per the comparison spec's channels, contact-centered + resampled.
    None if too sparse. salience_keypoints selects which joints center the contact clamp (DATA, None = wrists →
    byte-identical). spec = the comparison-channel representation (DATA, None = DEFAULT_COMPARISON_SPEC = COCO
    limb+trunk → byte-identical)."""
    spec = spec or DEFAULT_COMPARISON_SPEC; chans = spec.channels
    lo, hi = _contact_clamp(person, lo, hi, salience_keypoints)
    rows = []
    for k in range(max(0,lo), min(hi, len(person["frames"]))):
        kp = person["frames"][k]["kp"]; t = _torso(kp)
        if t is None: continue
        cx, cy, s = t
        frame = []
        for n in chans:
            p = kp[JI[n]]
            frame.append([(p[0]-cx)/s, (p[1]-cy)/s, p[2]])
        rows.append(frame)
    if len(rows) < 4: return None
    arr = np.asarray(rows, float)               # (T,K,3)
    idx = np.linspace(0, len(arr)-1, N)
    out = np.zeros((N, len(chans), 3))
    for ki in range(len(chans)):
        for c in range(3):
            out[:, ki, c] = np.interp(idx, np.arange(len(arr)), arr[:, ki, c])
    return CertifiedDescriptor(out, spec)       # iter78 (#4): wrap at the BIRTH point so EVERY descriptor self-describes
    #                                             (closes the _skel-direct bypass; spec already defaulted above)

def _mirror(skel, spec=None):
    """Horizontal flip: negate x, swap left/right channels. Chirality transform (parity test). spec = the
    comparison representation (DATA, None = default); spec.mirror_idx[i] is byte-identical to the old
    MOVE_KP.index(MIRROR[name]) target."""
    spec = spec or DEFAULT_COMPARISON_SPEC
    m = skel.copy(); m[:,:,0] = -m[:,:,0]
    out = m.copy()
    for i, ti in enumerate(spec.mirror_idx):
        out[:, ti, :] = m[:, i, :]
    return out

def _frame_cost(fa, fb):
    """Confidence-weighted skeleton distance between two frames (for DTW alignment)."""
    w = np.minimum(fa[:,2], fb[:,2])
    d = np.hypot(fa[:,0]-fb[:,0], fa[:,1]-fb[:,1])
    return float(np.sum(w*d)/(np.sum(w)+1e-9))

def _dtw_path(a, b, band=6):
    na, nb = len(a), len(b); INF = 1e18
    D = np.full((na+1, nb+1), INF); D[0,0] = 0.0
    bp = {}
    for i in range(1, na+1):
        for j in range(max(1,i-band), min(nb,i+band)+1):
            c = _frame_cost(a[i-1], b[j-1])
            best = min((D[i-1,j],(i-1,j)), (D[i,j-1],(i,j-1)), (D[i-1,j-1],(i-1,j-1)), key=lambda x:x[0])
            D[i,j] = c + best[0]; bp[(i,j)] = best[1]
    path = []; i, j = na, nb
    while (i,j) != (0,0):
        path.append((i-1,j-1)); i,j = bp.get((i,j),(0,0))
        if i == 0 and j == 0: break
    return path[::-1]

def _channel_motion(s):
    """Per-channel body-normalized path length (how much each keypoint MOVES), confidence-gated. A channel that
    does not move cannot discriminate two motions (it agrees trivially), so it must not drive certification."""
    K = s.shape[1]; mot = np.zeros(K)
    for ki in range(K):
        for t in range(1, len(s)):
            if s[t,ki,2] >= MC and s[t-1,ki,2] >= MC:
                mot[ki] += np.hypot(s[t,ki,0]-s[t-1,ki,0], s[t,ki,1]-s[t-1,ki,1])
    return mot

def _worst_channel(a, b, spec=None):
    """Align a,b by DTW; certify on the MOVING channels (C2): the parts that actually move must be OBSERVED in
    both and AGREE. A channel that moves a lot in either clip is DISCRIMINATING; if a discriminating channel is
    unobserved, we cannot certify the motion (→ None = no_match). worst = max divergence over discriminating
    observed channels. Static channels (trivially agree) are excluded so they cannot dilute the signal.
    spec = comparison representation (DATA, None = default); spec.min_reliable is the observability gate."""
    spec = spec or DEFAULT_COMPARISON_SPEC
    path = _dtw_path(a, b)
    if not path: return None
    K = a.shape[1]
    mot = np.maximum(_channel_motion(a), _channel_motion(b))
    if mot.max() <= 1e-6: return None
    discriminating = mot >= 0.30 * mot.max()         # the channels that carry the motion (data threshold)
    ch_div = np.full(K, np.nan); ch_rel = np.zeros(K, bool)
    for ki in range(K):
        ds = []
        for (i,j) in path:
            if min(a[i,ki,2], b[j,ki,2]) < MC: continue
            ds.append(np.hypot(a[i,ki,0]-b[j,ki,0], a[i,ki,1]-b[j,ki,1]))
        if len(ds) >= max(4, len(path)//3):
            ch_div[ki] = float(np.mean(np.sort(ds)[:max(1,int(len(ds)*0.8))]))  # robust: drop worst 20% (noise)
            ch_rel[ki] = True
    # OBSERVABILITY GATE: every DISCRIMINATING (moving) channel must be observed, else we cannot certify.
    disc_idx = np.where(discriminating)[0]
    if any(not ch_rel[ki] for ki in disc_idx): return None
    if ch_rel.sum() < spec.min_reliable: return None
    disc_div = ch_div[disc_idx]                        # certify on the moving channels
    return float(np.max(disc_div)), int(len(disc_idx)), float(np.mean(disc_div))

def dist(a, b, mode="worst", spec=None):
    """Correspondence score + parity. Lower = more same. mode='worst' (certified) | 'mean' (for comparison).
    spec = comparison representation for the mirror/parity test (DATA, None = default → byte-identical)."""
    if a is None or b is None: return None, None
    # capstone-16 #1 (SP9 defense-in-depth on the S1 crown jewel): the certified core SELF-DEFENDS — a poisoned
    # descriptor with ANY non-finite coord yields NO certification (never a fabricated score, never a crash). An
    # Inf coord is especially dangerous: the robust-channel trim `np.sort(ds)[:80%]` would DISCARD a small fraction
    # of Inf distances, leaving a finite low divergence that could certify a WRONG match — and an Inf upstream also
    # crashes the `mot` magnitude (zero-size reduction). The LIVE path is already Inf/NaN-free (every descriptor is
    # built via descriptor_at -> canonicalize_pose_track, kp3 zeros non-finite to conf-0); this makes the core not
    # RELY on every caller canonicalizing — convergence of capstone-15 (my independent pass: live path safe) +
    # capstone-16 (Codex: the core itself must not trust its inputs). Byte-identical for canonicalized descriptors.
    if not (np.all(np.isfinite(a)) and np.all(np.isfinite(b))):
        return None, None
    spec = _reconcile(a, b, spec)   # L090: descriptors self-describe their spec; fail-loud on a mismatch (iter74)
    direct = _worst_channel(a, b, spec)
    refl   = _worst_channel(a, _mirror(b, spec), spec)
    cand = []
    if direct: cand.append((direct, "direct"))
    if refl:   cand.append((refl, "reflected"))
    if not cand: return None, None
    # handedness: choose orientation with the lower MEAN (overall best alignment), then the WORST channel of
    # THAT orientation is the certification score (worst-channel veto survives the handedness choice).
    (best, parity) = min(cand, key=lambda x: x[0][2])
    score = best[0] if mode == "worst" else best[2]
    return score, parity

def certified(a, b, spec=None):
    s, par = dist(a, b, mode="worst", spec=spec)   # dist reconciles + fail-louds on a spec mismatch (iter74)
    # epsilon comes from the EFFECTIVE spec: explicit > the descriptors' self-described spec > DEFAULT (byte-identical)
    eff = spec or getattr(a, "spec", None) or getattr(b, "spec", None) or DEFAULT_COMPARISON_SPEC
    return (s is not None and s <= eff.epsilon), par, s

# ---- cached plug-in for scoreboard/selector ----
_PERSON = {}; _DESC = {}
def _load(kp_path):
    if kp_path not in _PERSON:
        sys.path.insert(0, str(Path(__file__).resolve().parent)); import describe_clip as DC
        d = canonicalize_pose_track(json.loads(Path(kp_path).read_text())); _PERSON[kp_path] = DC.main_track(d)  # #198.2 SAFETY (capstone-11 #7): a NaN keypoint -> absent BEFORE _skel builds the certified descriptor
    return _PERSON[kp_path]
def descriptor_at(kp_path, t0, t1, salience_keypoints=None, spec=None):
    names = tuple(salience_keypoints) if salience_keypoints else DEFAULT_EFFECTOR  # None = the universal hands default (pose_schema SSOT; iter92, was a wrist literal — byte-identical)
    spec_key = () if spec is None else (_spec_fp(spec),)             # iter78 (#3): FULL spec fp (channels+mirror+min_reliable
    #   +epsilon), not just channels — else same-channels/different-calibration specs COLLIDE and the cached descriptor
    #   carries the WRONG .spec. spec=None → () unchanged → frozen cache byte-identical (the tennis default path).
    key = (str(kp_path), round(float(t0),2), round(float(t1),2), names) + spec_key
    if key not in _DESC:
        p = _load(str(kp_path))
        if not p or not p.get("frames"): _DESC[key] = None; return None
        ts = [f["t"] for f in p["frames"]]
        lo = min(range(len(ts)), key=lambda i: abs(ts[i]-float(t0)))
        hi = min(range(len(ts)), key=lambda i: abs(ts[i]-float(t1)))
        # L090: _skel now wraps its output as a self-describing CertifiedDescriptor at the birth point (iter78 #4),
        # so descriptor_at just stores it (None stays None). dist()/certified() reconcile on .spec + fail-loud.
        _DESC[key] = _skel(p, lo, max(lo+2, hi), salience_keypoints, spec)
    return _DESC[key]

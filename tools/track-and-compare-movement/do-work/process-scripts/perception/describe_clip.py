#!/usr/bin/env python3
# tools/match/describe_clip.py
#
# PURPOSE: Emit the self-describing MotionClipDescriptor (motion-clip-descriptor.v1) for ANY clip,
# computed PURELY from pose — no folders, no tags, no enums. This is the L069 generative primitive:
# every clip becomes queryable from its pixels. Gauntlet-derived (plan 2026-06-18); converged with
# Codex. The descriptor is a FACT keyed by source content fingerprint (CAS/append-log doctrine,
# patterns #63/#68) — compute once, cache forever.
#
# WINDOWED (Codex refinement): a clip is segmented into MOTION WINDOWS (activity bursts) — a single
# swing = 1 window, a point-play clip = many. Each window is described independently; the motion
# EVENT, not the file, is the atom.
#
# CONTINUOUS, NEVER ENUMERATED:
#   - viewpoint: a continuous vector of pose foreshortening ratios + a confidence (replaces the
#     {front,side,back} classifier). Two clips "match angle" iff their viewpoint vectors are close.
#   - phase: the per-window normalized motion SIGNATURE (joint-angle + speed time series) aligned
#     downstream by DTW (replaces enumerated phases + single-point contact sync).
#   - handedness: a continuous SIGN computed from limb-motion asymmetry (replaces data/handedness.json).
#   - framing: the body bbox trajectory (drives normalization/crop generically; kills sliver/over-crop).
# Embedding refs are OPTIONAL fields (visual/motion/identity) the index layer fills in later — the
# schema is multimodal-ready without requiring those models now.
#
# USAGE: describe_clip.py --kp pose.json --source CLIP.mp4 --out descriptor.json
#   (pose.json = output of tools/motion/pose_estimate.py)

from __future__ import annotations
import argparse, hashlib, json, math, statistics, sys
from dataclasses import dataclass
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))  # so `import orientation` works when imported as a module

from pose_schema import COCO, JI, LIMB_CHAINS, DEFAULT_EFFECTOR, canonicalize_pose_track  # canonical pose schema SSOT (iter67 COCO/JI, iter70 LIMB_CHAINS, iter92 DEFAULT_EFFECTOR; #198.2 keypoint canonicalizer)
import finite_json as FJ  # #198.1 serialization waist — the descriptor producer fails LOUD on a non-finite value (no NaN ever persisted)
MC=0.3
def log(m): print(f"[describe] {m}", file=sys.stderr, flush=True)
def d(a,b): return math.dist(a,b)
def _smooth(xs,w=5):
    if len(xs)<w: return list(xs)
    half=w//2; out=[]
    for i in range(len(xs)):
        seg=xs[max(0,i-half):min(len(xs),i+half+1)]; out.append(sum(seg)/len(seg))
    return out

def main_track(kp):
    best=None; bs=-1
    for p in kp.get("persons",[]):
        hs=[]
        for f in p["frames"]:
            ys=[k[1] for k in f["kp"] if k[2]>=MC]
            if len(ys)>=6: hs.append(max(ys)-min(ys))
        if hs:
            sc=len(hs)*statistics.median(hs)
            if sc>bs: bs=sc; best=p
    return best

def player_size_frac(kp_path) -> float | None:
    """CANONICAL (SSOT) reliability signal: median player bbox height as a fraction of frame height, from the
    FULL (uncropped) pose track. Wide establishing shots make the player tiny → pose too unreliable to read the
    motion (a forehand 2D-overlaps a serve/standing on such footage — gate-tuning can't separate them). Returns
    the fraction, or None when it cannot be computed (no track / empty / unreadable); each caller maps None to
    its own FAIL-CLOSED sentinel. Was duplicated in produce_batch.player_size_frac AND check_video._player_size
    (the latter literally "mirrors" it) → unified here (the bedrock that owns main_track+MC), 2026-06-20."""
    try:
        kp = canonicalize_pose_track(json.loads(Path(kp_path).read_text())); p = main_track(kp)  # #198.2: NaN keypoint -> absent (conf 0)
        if not p: return None
        H = kp.get("video", {}).get("height") or 1080
        hs = []
        for f in p["frames"]:
            ys = [k[1] for k in f["kp"] if k[2] >= MC]
            if ys: hs.append(max(ys) - min(ys))
        return (statistics.median(hs) / H) if hs else None
    except Exception:
        return None

def angle(a,b,c):
    """interior angle at b (deg) from 2D points a-b-c."""
    ba=(a[0]-b[0],a[1]-b[1]); bc=(c[0]-b[0],c[1]-b[1])
    na=math.hypot(*ba); nc=math.hypot(*bc)
    if na<1e-6 or nc<1e-6: return 0.0
    cos=max(-1.0,min(1.0,(ba[0]*bc[0]+ba[1]*bc[1])/(na*nc)))
    return math.degrees(math.acos(cos))

def kp_at(person,i):
    return person["frames"][i]["kp"]

def speed_series(person, name):
    fr=person["frames"]; idx=JI[name]; sp=[0.0]
    for k in range(1,len(fr)):
        a=fr[k-1]["kp"][idx]; b=fr[k]["kp"][idx]
        sp.append(d(a[:2],b[:2]) if (a[2]>=MC and b[2]>=MC) else 0.0)
    return sp

def body_h_at(k):
    ys=[p[1] for p in k if p[2]>=MC]
    return (max(ys)-min(ys)) if len(ys)>=6 else 1.0

# ── GENERIC SALIENCE WINDOWER CONFIG (S3 / L069 / L083) ─────────────────────────────────────────────
# detect_windows is a DOMAIN-AGNOSTIC salience segmenter: it finds local PEAKS in a per-frame "salience"
# signal and brackets each peak out to the surrounding rest-lull. NOTHING about it is tennis — the only
# domain knowledge is the DATA in SalienceConfig: WHICH keypoints' motion is salient, HOW to combine them,
# and the timing/threshold constants. The DEFAULT config reproduces the original tennis behaviour
# BYTE-IDENTICALLY (max wrist speed ÷ body height, smooth 5, the 9 tuned constants), so the frozen S1 eval
# and every existing caller are unchanged. A reading clip would pass salience_keypoints=("l_wrist","r_wrist",
# "nose"), a footwork drill ("l_ankle","r_ankle"), etc. — DATA, zero code change. (L083: the default is the
# maximally-capable real behaviour, not a stub; L069: one windower, N domains are configurations of it.)
_REDUCERS = {                                    # owner-extensible capability pack (L090: data-selected, not branched)
    "max":  max,
    "mean": lambda xs: sum(xs) / len(xs) if xs else 0.0,
    "sum":  sum,
}

@dataclass(frozen=True)
class SalienceConfig:
    salience_keypoints: tuple = DEFAULT_EFFECTOR  # whose per-frame speed feeds the salience signal (pose_schema SSOT; iter92, was a wrist literal — order irrelevant: salience_series reduces by max)
    salience_reduce: str = "max"                        # how to combine those keypoints' speeds (key in _REDUCERS)
    normalize_by_body_height: bool = True               # divide by body height → identity/scale-invariant
    smooth_w: int = 5                                   # moving-average window on the salience signal
    peak_frac: float = 0.50                             # a peak must reach peak_frac × max salience …
    mean_sd_k: float = 1.0                              # … AND mean + mean_sd_k × sd (whichever is higher)
    min_sep_s: float = 1.3                              # peaks closer than this = ONE event (keep the stronger)
    rest_frac: float = 0.20                             # "at rest" salience level = rest_frac × peak
    sustain_s: float = 0.20                             # rest must persist this long to be a true boundary
    back_cap_s: float = 2.2                             # max lead-in bracketed before a peak
    fwd_cap_s: float = 1.4                              # max follow-through bracketed after a peak
    ready_pad_s: float = 0.25                           # extra lead-in shown before motion resumes
    # PHYSICAL RULES (Nov 20 2026, real Aug 28 / Sep 10 footage). 0 = off, so the defaults stay byte-identical.
    lost_body_frac: float = 0.0                          # a frame whose body height is under this x the median is lost; it and lost_pad_frames around it move nothing
    lost_pad_frames: int = 6                             # frames each side of a lost frame that are zeroed with it
    max_body_heights_per_frame: float = 0.0              # faster than this (body heights a frame) is a tracker jump, not a body: set to 0
    cap_percentile: float = 0.0                          # cap the signal at this percentile so one freak moment cannot set the bar

DEFAULT_SALIENCE_CONFIG = SalienceConfig()
_AT_MOST_ONE = {"lost_body_frac", "cap_percentile"}

def salience_fingerprint(salience_json: str = None) -> str:
    """A stable fingerprint of the salience config that produced a descriptor. None/empty → 'default' (the tennis
    wrist default). The descriptor's WINDOWS depend on WHICH joints are salient, so a cache keyed only on the clip
    bytes (ingest_corpus) would silently reuse OLD-effector descriptors when a domain rebuilds the index with
    different salient joints (iter124/Codex iter122 F3). Stamping this into the descriptor + validating it on cache
    hit makes the cache content-addressed over (clip, salience) — a salience change forces a fresh describe.
    Canonicalized (sorted keys) so equivalent configs map to one fingerprint."""
    if not salience_json:
        return "default"
    try:
        canon = json.dumps(json.loads(salience_json), sort_keys=True, separators=(",", ":"))
    except Exception:
        canon = salience_json
    return hashlib.md5(canon.encode()).hexdigest()[:16]

def salience_config_from_dict(d):
    """Build a SalienceConfig from a JSON-origin override dict (e.g. ProductionConfig.salience). None/empty →
    the tennis default (byte-identical). Unknown keys FAIL-CLOSED (a typo must not silently use the default);
    salience_keypoints (a JSON list) is coerced to tuple. This is the DATA→config seam (S3/D27/iter46) that
    lets any motion domain pick its salient joints without a code change."""
    from dataclasses import replace, fields as _fields
    if not d: return DEFAULT_SALIENCE_CONFIG
    valid = {f.name for f in _fields(SalienceConfig)}
    unknown = set(d) - valid
    if unknown: raise ValueError(f"SalienceConfig: unknown keys {sorted(unknown)} (valid: {sorted(valid)})")
    # FAIL-CLOSED on VALUE TYPES (iter134 / Codex iter132 F2, the iter90 bool-string category): rejecting unknown KEYS
    # is not enough — a present key with a malformed VALUE silently corrupts the config. The worst is
    # normalize_by_body_height:"false", consumed by truthiness (bool("false")==True) → body-norm ON when the config said
    # OFF. Validate every provided value against the dataclass field's type (generic — driven off the default's type, no
    # per-field enum): bool must be bool; numeric must be int/float (never bool); salience_reduce a registered reducer;
    # salience_keypoints a non-empty list of non-empty joint-name strings. A malformed value RAISES, never falls through.
    coerced = {}
    for k, v in d.items():
        default = getattr(DEFAULT_SALIENCE_CONFIG, k)
        if k == "salience_keypoints":
            if not isinstance(v, (list, tuple)) or not v or not all(isinstance(j, str) and j for j in v):
                raise ValueError(f"SalienceConfig.salience_keypoints must be a non-empty list of joint-name strings, got {v!r}")
            coerced[k] = tuple(v)
        elif k == "salience_reduce":
            if v not in _REDUCERS:
                raise ValueError(f"SalienceConfig.salience_reduce must be one of {sorted(_REDUCERS)}, got {v!r}")
            coerced[k] = v
        elif isinstance(default, bool):
            if not isinstance(v, bool):
                raise ValueError(f"SalienceConfig.{k} must be a boolean, got {type(v).__name__} {v!r} (a JSON string like \"false\" is truthy — fails closed)")
            coerced[k] = v
        elif isinstance(default, (int, float)):
            # Codex capstone-6 MED #7: type-only (int|float, non-bool) was not enough — a finite/range/integer check
            # was missing. smooth_w=-1 -> _smooth half=-1 -> empty slice -> sum([])/len([]) ZeroDivisionError (verified);
            # smooth_w=inf silently skips smoothing; smooth_w=2.5 crashes the // and slice. Generic (driven off the
            # default's type, no per-field enum): every salience knob is a non-negative finite number, and an int field
            # indexes/slices so it must stay an int. The iter133/134 fail-closed-value category, completed for range.
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError(f"SalienceConfig.{k} must be a number, got {type(v).__name__} {v!r}")
            if not math.isfinite(v):
                raise ValueError(f"SalienceConfig.{k} must be finite, got {v!r} (NaN/inf silently disables/crashes the consumer)")
            if v < 0:
                raise ValueError(f"SalienceConfig.{k} must be >= 0, got {v!r} (a salience window/fraction/seconds/multiplier is non-negative; a negative smooth_w div-by-zeros _smooth)")
            if k in _AT_MOST_ONE and v > 1:
                raise ValueError(f"SalienceConfig.{k} must be <= 1, got {v!r} (it is a fraction)")
            if isinstance(default, int) and not isinstance(v, int):
                raise ValueError(f"SalienceConfig.{k} must be an int (it indexes/slices the signal), got {type(v).__name__} {v!r} (a float window crashes _smooth's // and slicing)")
            coerced[k] = v
        else:
            coerced[k] = v
    return replace(DEFAULT_SALIENCE_CONFIG, **coerced)

def salience_series(person, cfg=DEFAULT_SALIENCE_CONFIG):
    """Per-frame salience signal = (reduced speed of cfg.salience_keypoints) [÷ body height], smoothed.
    Generic: the keypoints + reducer are DATA. Default = max wrist speed ÷ body height (original behaviour)."""
    fr = person["frames"]; n = len(fr)
    series = [speed_series(person, name) for name in cfg.salience_keypoints]
    reduce = _REDUCERS[cfg.salience_reduce]
    raw = [reduce([s[k] for s in series]) for k in range(n)]
    if cfg.normalize_by_body_height:
        raw = [raw[k] / max(body_h_at(fr[k]["kp"]), 1.0) for k in range(n)]
    return _physical(_smooth(raw, cfg.smooth_w), fr, cfg)

def _physical(sm, fr, cfg):
    """The physical rules on the smoothed signal: lost-body frames, impossible speed, and a percentile cap.
    Each rule is off at 0, so the default config returns sm unchanged."""
    if cfg.lost_body_frac > 0 and sm:
        h = [body_h_at(f["kp"]) for f in fr]
        med = statistics.median(h)
        lost = [x < cfg.lost_body_frac * med for x in h]
        p = cfg.lost_pad_frames
        sm = [0.0 if any(lost[max(0, k - p):k + p + 1]) else v for k, v in enumerate(sm)]
    if cfg.max_body_heights_per_frame > 0:
        sm = [0.0 if v > cfg.max_body_heights_per_frame else v for v in sm]
    if cfg.cap_percentile > 0 and sm:
        cap = sorted(sm)[int(cfg.cap_percentile * (len(sm) - 1))]
        sm = [min(v, cap) for v in sm]
    return sm

def detect_windows(person, fps, cfg=DEFAULT_SALIENCE_CONFIG):
    """Segment into INDIVIDUAL salient EVENTS (a tennis SWING, by default). Each event = a local PEAK in the
    cfg-defined salience signal (default = body-normalized dominant-wrist speed, the contact spike),
    bracketed into a [lead-in .. follow-through] window. Peak-based (NOT a single threshold span — that
    merged a whole point-play rally into one 10.8s 'swing') so a multi-event clip yields ONE window PER
    EVENT: the basis for footage VARIETY and for per-event labelling. A low-motion clip with no prominent
    peak -> []. DOMAIN-AGNOSTIC: all tennis specifics live in `cfg` (DEFAULT reproduces the original
    behaviour byte-for-byte); any motion domain passes a different SalienceConfig as DATA, no code change."""
    fr=person["frames"]; n=len(fr)
    if n<3: return []                            # FAIL-CLOSED (Codex): too short to hold an event -> NO window
    sm=salience_series(person, cfg)              # generic salience signal (default = max wrist speed ÷ body height)
    peak=max(sm) or 1.0; mean=sum(sm)/len(sm); sd=statistics.pstdev(sm) if len(sm)>1 else 0.0
    thr=max(cfg.peak_frac*peak, mean+cfg.mean_sd_k*sd)  # CONTACT spike ONLY — high enough to ignore the smaller
                                                 # takeback speed bump, which is part of the SAME event, not its own
    minsep=max(1,int(cfg.min_sep_s*fps))         # peaks <min_sep_s apart = ONE event (merge takeback-bump + contact,
                                                 # keeping the stronger=contact); real events sit further apart
    # FULL-STROKE bracket (2026-06-19 fix): a stroke = ready → takeback → contact(speed peak) → follow-through. We
    # bracket the contact peak OUT to the SUSTAINED rest-lull on each side, so the window holds the WHOLE stroke
    # INCLUDING the takeback — the most shot-DISCRIMINATING phase (a backhand takes the racket over the OPPOSITE
    # shoulder; a forehand back same-side). The prior fixed [peak-0.7s,peak+0.9s] cut the takeback off → both the
    # partial-stroke render the owner saw AND backhand/forehand stubs that embed alike (the wrong-shot match that
    # slipped the gate). "Sustained" (>=sustain frames < rest_thr) is required so the brief LOAD-DIP between
    # takeback and contact is NOT mistaken for the stroke boundary; caps + an adjacent-peak midpoint guard stop the
    # walk bleeding into a neighbouring stroke.
    rest_thr=cfg.rest_frac*peak                  # "at rest / ready" speed level (a moving takeback sits above it)
    sustain=max(2,int(cfg.sustain_s*fps))        # rest must persist ~sustain_s (skips brief mid-event load dips)
    back_cap=int(cfg.back_cap_s*fps); fwd_cap=int(cfg.fwd_cap_s*fps)  # max lead-in / follow-through (safety caps)
    ready_pad=int(cfg.ready_pad_s*fps)            # show a beat of the ready stance before the motion resumes
    peaks=[]
    for k in range(1,n-1):
        if sm[k]>=thr and sm[k]>=sm[k-1] and sm[k]>=sm[k+1]:
            if peaks and k-peaks[-1]<minsep:
                if sm[k]>sm[peaks[-1]]: peaks[-1]=k     # keep the stronger of two close peaks (contact > takeback)
            else: peaks.append(k)
    # FAIL-CLOSED (Codex Q4): no contact spike => NO swing here. Return [] — never a whole-clip fallback
    # that fabricates a "swing" out of walking/warmup. Downstream rejects an empty admissible set.
    if not peaks: return []
    def _back_to_rest(pk, floor):
        """Walk back from contact to where the wrist was SUSTAINED at rest (the ready stance before the takeback),
        skipping the brief load-dip between takeback and contact. Returns the takeback-start frame."""
        run=0; j=pk-1
        while j>=floor:
            if sm[j]<rest_thr:
                run+=1
                if run>=sustain: return j+run          # takeback motion resumes just after this rest run
            else: run=0
            j-=1
        return floor
    def _fwd_to_rest(pk, ceil):
        """Walk forward from contact to the sustained rest after the follow-through. Returns the follow-through-end frame."""
        run=0; j=pk+1
        while j<ceil:
            if sm[j]<rest_thr:
                run+=1
                if run>=sustain: return j-run+1        # follow-through ended just before this rest run
            else: run=0
            j+=1
        return ceil
    wins=[]
    for idx,pk in enumerate(peaks):
        lo_floor=max(0, pk-back_cap)
        if idx>0: lo_floor=max(lo_floor, (peaks[idx-1]+pk)//2)              # never cross into the previous stroke
        hi_ceil=min(n, pk+fwd_cap)
        if idx<len(peaks)-1: hi_ceil=min(hi_ceil, (pk+peaks[idx+1])//2)     # never cross into the next stroke
        lo=max(lo_floor, _back_to_rest(pk, lo_floor)-ready_pad)
        hi=_fwd_to_rest(pk, hi_ceil)
        if wins and lo<=wins[-1][1]: wins[-1]=(wins[-1][0],hi)             # overlap -> merge
        else: wins.append((lo,hi))
    return wins

def viewpoint_vec(person, lo, hi):
    """Continuous camera-viewpoint descriptor (motion-clip-descriptor.v1, viewpoint layout v2).

    DEEPEST-ROOT FIX (gauntlet 2026-06-18, empirical eval_viewpoint.py): v1 features (shoulder_spread,
    hip_spread, twist) were body-HEIGHT-normalized -> near-constant across viewpoints (washed out the
    foreshortening), and ear_asym (the one real cue) was abs()-folded in the distance, destroying it.
    All weight configs scored precision@5 = 0.000 for picking side-view matches.

    v2 uses identity-invariant BODY-PART RATIOS (not height-normalized) so foreshortening survives, and
    keeps the left/right cue SIGNED (mirror handled in the distance by min-over-mirror, NOT magnitude):
      [0] sideness    = shoulder_width / torso_vertical   (front/back=WIDE/high, side=NARROW/low)
      [1] face_vis    = mean conf(nose,eyes)              (front=high, back=low)
      [2] leg_torso   = leg_vertical / torso_vertical     (eye-level=tall, birdseye=foreshortened/low)
      [3] ear_sign    = conf(l_ear) - conf(r_ear)         (SIGNED left/right azimuth — chiral)
    Each is a ratio of two measurements ON THE SAME BODY, so it is invariant to subject size/identity."""
    side=[]; face=[]; legtor=[]; earsign=[]
    for fk in person["frames"][lo:hi]:
        k=fk["kp"]
        def c(n): return k[JI[n]][2]
        def P(n): return k[JI[n]]
        def ok(n): return c(n)>=MC
        # face_vis RELATIVE to the clip's overall keypoint confidence (Codex: absolute conf is
        # detector/identity-contaminated — a crisp high-res clip reads high face_vis at ANY angle).
        # Dividing by body-wide mean confidence cancels that per-clip/per-subject bias.
        bodyconf=sum(p[2] for p in k)/len(k)
        facec=sum(c(n) for n in ("nose","l_eye","r_eye"))/3.0
        face.append(facec/bodyconf if bodyconf>1e-3 else 0.0)
        earsign.append(c("l_ear")-c("r_ear"))
        if ok("l_shoulder") and ok("r_shoulder") and ok("l_hip") and ok("r_hip"):
            sw=abs(P("l_shoulder")[0]-P("r_shoulder")[0])
            shmid_y=(P("l_shoulder")[1]+P("r_shoulder")[1])/2.0
            hipmid_y=(P("l_hip")[1]+P("r_hip")[1])/2.0
            tv=abs(shmid_y-hipmid_y)
            if tv>1.0:
                side.append(min(3.0, sw/tv))
                anks=[P(n)[1] for n in ("l_ankle","r_ankle") if ok(n)]
                if anks:
                    legtor.append(min(4.0, abs(max(anks)-hipmid_y)/tv))
    def avg(x): return round(sum(x)/len(x),4) if x else 0.0
    vec=[avg(side),avg(face),avg(legtor),avg(earsign)]
    conf=round(min(1.0,len(side)/max(1,hi-lo)),3) if hi>lo else 0.0
    return vec, conf

# ── GENERIC EFFECTOR (which moving joint carries the motion event) — DATA via the salience pair (iter47) ──
# The feature pack (active_side/peak_time/swing_quality/intensity/signature/state) describes the motion of the
# SALIENT EFFECTOR. WHICH joint that is comes from SalienceConfig.salience_keypoints (iter46), NOT a hardcoded
# wrist. None = the tennis wrist pair → BYTE-IDENTICAL. A domain (footwork) passes its salient pair (ankles) and
# the SAME feature pack tracks the ankle. The kinematic CHAIN to the effector (for conf/angle channels) is the
# universal COCO limb skeleton (NOT tennis Society): wrist→arm, ankle→leg — sourced from the pose_schema SSOT
# (LIMB_CHAINS), not a local copy (iter70 enum dissolution).

def _effector_joint(side, salience_keypoints=None):
    """Salient effector joint name on `side` ('l'|'r'). None salience → '{side}_wrist' (byte-identical tennis)."""
    sk = salience_keypoints or DEFAULT_EFFECTOR   # None = the universal hands default (pose_schema SSOT; iter92)
    for n in sk:
        if n.startswith(side+"_"): return n
    return sk[0] if sk else side+"_wrist"

def _limb_chain(effector_joint):
    """Proximal→distal COCO limb chain ending at the effector (universal skeleton, for conf/angle channels).
    'r_wrist'→('r_shoulder','r_elbow','r_wrist'); 'l_ankle'→('l_hip','l_knee','l_ankle'). A non-sided / non-limb
    effector (e.g. a midline 'nose') has NO bilateral limb chain → it is its own chain (its own conf), NEVER a
    malformed '{joint}_' that would KeyError downstream (iter47/Codex #4 — degrade sanely, fail-closed not crash)."""
    side, sep, limb = effector_joint.partition("_")
    if sep and limb in LIMB_CHAINS:
        return tuple(f"{side}_{j}" for j in LIMB_CHAINS[limb])
    return (effector_joint,)

def signature(person, lo, hi, hand, salience_keypoints=None):
    """Per-window normalized motion signature for DTW phase alignment. Rows over time of:
    elbow angle, shoulder angle, knee angle, trunk lean, EFFECTOR speed — for the active side. The speed channel
    tracks the salient effector (DATA, None=wrist → byte-identical); the limb-angle channels are the active
    side's universal biomechanics (degrade gracefully for non-arm effectors)."""
    s=("l" if hand=="l" else "r")
    rows=[]
    sp=speed_series(person,_effector_joint(hand,salience_keypoints))
    for k in range(lo,hi):
        kk=person["frames"][k]["kp"]; bh=body_h_at(kk)
        def P(n): return kk[JI[n]][:2]
        def okk(*ns): return all(kk[JI[n]][2]>=MC for n in ns)
        elbow = angle(P(f"{s}_shoulder"),P(f"{s}_elbow"),P(f"{s}_wrist")) if okk(f"{s}_shoulder",f"{s}_elbow",f"{s}_wrist") else 0.0
        shoulder = angle(P(f"{s}_elbow"),P(f"{s}_shoulder"),P(f"{s}_hip")) if okk(f"{s}_elbow",f"{s}_shoulder",f"{s}_hip") else 0.0
        knee = angle(P(f"{s}_hip"),P(f"{s}_knee"),P(f"{s}_ankle")) if okk(f"{s}_hip",f"{s}_knee",f"{s}_ankle") else 0.0
        trunk=0.0
        if okk(f"{s}_shoulder",f"{s}_hip"):
            dx=P(f"{s}_shoulder")[0]-P(f"{s}_hip")[0]; dy=P(f"{s}_shoulder")[1]-P(f"{s}_hip")[1]
            trunk=math.degrees(math.atan2(dx,-dy if dy!=0 else -1e-6))
        rows.append([round(elbow/180,4),round(shoulder/180,4),round(knee/180,4),
                     round((trunk+180)/360,4),round(min(1.0,sp[k]/max(bh,1.0)/0.5),4)])
    return rows

def active_side(person, lo, hi, salience_keypoints=None):
    """The wrist carrying THIS window's motion event ('l'|'r'), derived FROM the motion itself: the side with
    the higher wrist speed at the contact frame (peak speed over BOTH wrists). This is a per-window geometric
    FACT (L090) used only to extract this window's active-arm features (signature/quality/phase) — it is NOT a
    per-person handedness/identity constant and NOT a forehand/backhand label (both deleted — L063 enum
    dissolution). Because it picks the genuinely-moving arm per window, it is chirality-free and handles
    two-handed / either-side strokes. Chirality (lefty vs righty) is resolved per-PAIR by the motion match's
    parity (direct/reflected), and the render derives the same contact side independently from pixels — nothing
    keys off a stored handedness. salience_keypoints selects the effector pair (None=wrists, byte-identical)."""
    rs=speed_series(person,_effector_joint("r",salience_keypoints)); ls=speed_series(person,_effector_joint("l",salience_keypoints)); n=len(person["frames"])
    lo=max(0,lo); hi=min(hi,n)
    rng=list(range(lo,hi)) or list(range(n))
    ci=max(rng, key=lambda k: max(rs[k] if k<len(rs) else 0.0, ls[k] if k<len(ls) else 0.0), default=lo)
    rv=rs[ci] if ci<len(rs) else 0.0; lv=ls[ci] if ci<len(ls) else 0.0
    return "r" if rv>=lv else "l"

def framing(person, lo, hi):
    track=[]
    for fk in person["frames"][lo:hi]:
        xs=[p[0] for p in fk["kp"] if p[2]>=MC]; ys=[p[1] for p in fk["kp"] if p[2]>=MC]
        if xs and ys: track.append([round(min(xs),1),round(min(ys),1),round(max(xs)-min(xs),1),round(max(ys)-min(ys),1)])
    return track

def peak_time(person, lo, hi, hand, fps, salience_keypoints=None):
    sp=speed_series(person,_effector_joint(hand,salience_keypoints))[lo:hi]
    pk=lo+(max(range(len(sp)),key=lambda i:sp[i]) if sp else 0)
    return round(person["frames"][pk]["t"],3)

def swing_quality(person, lo, hi, hand, salience_keypoints=None):
    """Is this window a REAL motion EVENT (a salient-effector spike), vs a walk / warmup / no-ball / pan?
    Score 0..1 from peak prominence (an event SPIKES; walking is flat), body-normalized speed magnitude,
    effector-limb keypoint confidence, and a sane duration. The autonomy gate rejects low scores so a
    garbage clip is NEVER silently rendered (the structural property that kills the no-ball-warmup bug). The
    effector + its conf chain are DATA (None=wrist+arm, byte-identical) — a footwork upload spikes on its
    ANKLE, so this gate admits it (without the effector thread, the wrist gate would wrongly reject it)."""
    fr=person["frames"]; eff=_effector_joint(hand,salience_keypoints); chain=_limb_chain(eff); raw=speed_series(person,eff)
    sp=[raw[k]/max(body_h_at(fr[k]["kp"]),1.0) for k in range(lo,hi)]
    if len(sp)<3: return 0.0
    peak=max(sp); med=statistics.median(sp) or 1e-6
    prominence=min(1.0,(peak/(med+1e-6))/8.0)        # event peak >> median; walking ratio ~1
    magnitude=min(1.0,peak/0.5)                       # body-normalized peak; ~0.5 = strong event
    cfs=[fr[k]["kp"][JI[n]][2] for k in range(lo,hi) for n in chain]
    conf=min(1.0,(sum(cfs)/len(cfs))/0.6) if cfs else 0.0
    dur=fr[min(hi,len(fr)-1)]["t"]-fr[lo]["t"]
    dur_ok=1.0 if 0.4<=dur<=4.0 else max(0.0,1.0-abs(dur-2.0)/4.0)
    # SINGLE CLEAN SWING: ONE dominant speed peak. A serve point / standing-recovery / multi-stroke window
    # has MANY comparable peaks (measured: a leaked serve-point window had 5). A clean groundstroke spikes
    # once. This is the structural catch that rejects non-clean-swing windows on noisy wide footage (L063).
    npk=sum(1 for x in sp if x>0.6*peak)
    cleanness=1.0 if npk<=2 else max(0.0,1.0-(npk-2)*0.22)
    return round(0.3*prominence+0.25*magnitude+0.15*conf+0.1*dur_ok+0.2*cleanness,3)

def _elevation(source, t0, t1, peak_t=None):
    """Camera ELEVATION (pitch) — the 2nd camera-on-sphere axis (birdseye vs eye-level) that pose+facing
    can't supply. Read the SAME query-robust way as facing: CLIP text-projection on player crops
    (overhead−eyelevel axis). Replaces the framing-fragile monocular-3D (mediapipe/camera_sphere) read —
    measured AUC(birdseye>ground)=1.000 and a degraded wide query still reads ground. Guarded: missing
    video / no CLIP / no person → None (fail-closed). Matcher treats None as factor-unavailable."""
    try:
        import perception_backend
        return perception_backend.orientation_module().elevation_for_window(source, t0, t1, frames=8)
    except Exception as e:
        log(f"elevation unavailable ({type(e).__name__}: {str(e)[:80]})"); return None

def _heading(source, t0, t1):
    """Camera-on-sphere AZIMUTH: per-frame BODY HEADING in degrees over the window (body_orientation.py,
    JointBDOE). ~180=chest/front, ~0=back, ~90/270=side. Replaces the CLIP `facing` scalar which PROVABLY
    could not resolve front/back in profile (measured: scalar/multi-prompt/learned-probe all failed
    cross-identity). A swing is a ROTATION, so the matcher compares the phase-aligned heading TRAJECTORY
    (validated: same-camera ~14deg vs reversed ~139deg). Guarded → None (fail-closed: absent signal, never
    a guess); the heading gate then REJECTS the pair (orientation is a hard invariant, not optional)."""
    try:
        import perception_backend
        return perception_backend.heading_module().heading_for_window(source, t0, t1, frames=16)
    except Exception as e:
        log(f"heading unavailable ({type(e).__name__}: {str(e)[:80]})"); return None

def _state(person, lo, hi, hand, fps, salience_keypoints=None):
    """Multi-channel body-intrinsic swing state (swing_state.py): the projections of the full swing that the
    user's requirements map onto — contact height, stance, knee load, approach (running to the ball),
    recovery, swing arc (incl. follow-through), legs finish. Pose-derived (no model), so fast. The EFFECTOR
    (whose contact/arc are measured) = DATA via the salient pair (None=wrist → byte-identical); the stance/
    leg/COM channels are universal body geometry. Guarded → None (any missing channel is 'not_measured')."""
    try:
        import swing_state
        return swing_state.state_for_window(person, lo, hi, hand, fps, effector_joint=_effector_joint(hand, salience_keypoints))
    except Exception as e:
        log(f"state unavailable ({type(e).__name__}: {str(e)[:80]})"); return None

def describe(kp, source, salience_cfg=DEFAULT_SALIENCE_CONFIG):
    person=main_track(kp)
    if not person: return None
    fps=kp.get("video",{}).get("fps",30.0) or 30.0
    frames=person["frames"]
    clip_t0=round(frames[0]["t"],3); clip_t1=round(frames[-1]["t"],3)   # clip time bounds (truncation test)
    wins=detect_windows(person,fps,salience_cfg)   # salience (which joints = the motion event) is DATA (None default = wrists, byte-identical; iter46)
    sk=salience_cfg.salience_keypoints             # the effector pair the whole feature pack tracks (iter47; default wrists = byte-identical)
    out_wins=[]
    for lo,hi in wins:
        hand=active_side(person,lo,hi,sk)        # per-window moving side of the EFFECTOR pair (motion fact), NOT identity/stroke
        vec,conf=viewpoint_vec(person,lo,hi)
        t0=round(person["frames"][lo]["t"],3)
        t1=round(person["frames"][min(hi,len(person["frames"])-1)]["t"],3)
        out_wins.append({
            "t0":t0,
            "t1":t1,
            # FULL SWING: did the [backswing..follow] bracket fit INSIDE the clip without clamping at a
            # boundary? detect_windows brackets [peak-0.7s .. peak+0.9s] then clamps to [0,n]; a swing near a
            # clip edge gets clamped → its backswing (start-clamped) or follow-through (end-clamped) is CUT.
            # Rendering a truncated swing shows only PART of the stroke (the "only the finish" bug). This is a
            # self-describing FACT (L090); the autonomy gate rejects truncated swings fail-closed so a partial
            # swing is NEVER rendered.
            "full_swing": bool(t0 > clip_t0 + 0.05 and t1 < clip_t1 - 0.05),
            "peak_t":peak_time(person,lo,hi,hand,fps,sk),
            "viewpoint":{"vec":vec,"confidence":conf},
            "heading":_heading(source,t0,t1),             # camera-on-sphere AZIMUTH: body heading deg trajectory (JointBDOE)
            "elevation":_elevation(source,t0,t1),  # camera-on-sphere ELEVATION (birdseye) from pixels (orientation.py CLIP axis)
            "signature":signature(person,lo,hi,hand,sk),
            "state":_state(person,lo,hi,hand,fps,sk),    # multi-channel biomechanics+situation (effector contact/arc + universal stance/legs/COM); effector = DATA (iter47)
            "quality":swing_quality(person,lo,hi,hand,sk),  # is this a real motion EVENT (effector spike)? (rejects warmup/walk; effector=DATA so footwork admits on ankle)
            "framing":{"bbox_track":framing(person,lo,hi)},
            "intensity":round(sum(speed_series(person,_effector_joint(hand,sk))[lo:hi]),2),
            # multimodal slots the index layer fills later (Codex: pose isn't universal):
            "visual_embedding_ref":None,"motion_embedding_ref":None,"identity_ref":None
        })
    fp=hashlib.md5(Path(source).read_bytes()).hexdigest() if Path(source).exists() else hashlib.md5(source.encode()).hexdigest()
    return {"schema":"motion-clip-descriptor.v1","source":{"path":str(source),"fingerprint":fp},
            "fps":round(fps,3),"frames":len(person["frames"]),
            "clip_t0":clip_t0,"clip_t1":clip_t1,                # clip time bounds — consumers verify truncation
            "windows":out_wins}

def main()->int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--kp",required=True); ap.add_argument("--source",required=True); ap.add_argument("--out",required=True)
    ap.add_argument("--salience-config",default=None,help="JSON SalienceConfig override (which joints define the motion event, e.g. '{\"salience_keypoints\":[\"r_ankle\",\"l_ankle\"]}'); omitted = tennis wrist default (byte-identical). The DATA seam that lets any motion domain segment on its own salient joints, zero code change (S3/D27/iter46).")
    a=ap.parse_args()
    kp=canonicalize_pose_track(json.loads(Path(a.kp).read_text()))   # #198.2: canonicalize keypoints at ingestion — a NaN coord -> absent (conf 0), never reaches the descriptor math
    scfg=salience_config_from_dict(json.loads(a.salience_config)) if a.salience_config else DEFAULT_SALIENCE_CONFIG
    desc=describe(kp,a.source,scfg)
    if not desc: log("no athlete track"); return 1
    desc["salience_fp"]=salience_fingerprint(a.salience_config)   # iter124/F3: self-describe the effector so a cache can detect an effector change (None→"default", byte-identical tennis)
    Path(a.out).parent.mkdir(parents=True,exist_ok=True)
    # #198.1 (Codex #8/#4): the descriptor is a DERIVED summary — a non-finite field is a real producer bug,
    # not legitimate data. Fail LOUD at the exact site that tried to persist it (allow_nan=False) so no NaN/Inf
    # can ever reach select_partner's gates from disk. The describe-step caller already fails CLOSED on a non-zero
    # rc (iter123/125), so a refused write safely quarantines an unmatchable clip rather than shipping poison.
    try:
        Path(a.out).write_text(FJ.dumps(desc))
    except FJ.NonFiniteJSON as e:
        log(f"REFUSED to persist non-finite descriptor for {Path(a.source).name}: {e}"); return 1
    log(f"{Path(a.source).name}: {len(desc['windows'])} motion window(s)")
    return 0

if __name__=="__main__": raise SystemExit(main())

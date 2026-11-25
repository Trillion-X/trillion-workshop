#!/usr/bin/env python3
# tools/match/select_partner.py
#
# PURPOSE: The selection seam that REPLACES folder-based clip picking (L101). Given a target clip
# (e.g. a Person One swing) + its pose + a descriptor INDEX (the projection), return the best CREDIBLE partner
# — matched by the CERTIFIED correspondence primitive (motion_certify), NOT folders/names and NOT the
# hand viewpoint feature. Returns no_match (never fabricates) when nothing clears the calibrated bar.
# Domain-agnostic: the index can be Reference Player, a student, a basketball player — meaning is COMPUTED, and the
# ranking weights are supplied as DATA (select() kwargs), never hardcoded.
#
# THE MATCH — two STRICTLY SEPARATE stages (the L069/L097 separation; see motion_certify.py):
#   (1) ADMISSION = CORRECTNESS. A candidate is admitted ONLY if it clears the camera-comparability gates
#       (view-family + heading + elevation + salience + full-swing) AND the CERTIFIED worst-reliable-channel
#       primitive MC.dist ≤ cert_admit AND survives the ambiguity gate. A WRONG-motion match is structurally
#       impossible HERE for a CALIBRATED+VALIDATED spec — not via any weight (D90/iter80: the bar is channel-set-
#       calibrated; the default 12-channel tennis spec is validated 0-wrong, but a CUSTOM channel set must re-calibrate
#       cert_admit IN its ComparisonSpec + re-validate 0-wrong on its own confusables via index_confusion_certified
#       --spec — a per-spec DATA gate, parallel to recall/D12). This stage has NO closed enum and NO `if view==/stroke==` branch.
#   (2) RANKING = ORDER ONLY (post-admission). score = w_geom·geom_dist + heading_dist/head_scale
#       + w_body·body_term + w_view·view_dist. ALL FOUR are select() kwargs (DATA); byte-identical defaults
#       w_geom=1.5, head_scale=90, w_body=0.6, w_view=0.5. Because the pool is ALREADY same-motion certified,
#       these weights only ORDER correct candidates — they can NEVER override stroke-correctness, so the L055
#       "averaging hides the decisive divergence" risk does not exist at this stage (admission already ran on
#       the WORST channel, never an average).
# Society constraints stay DATA: `used` (no-reuse penalty) and `recency` (freshness bonus) apply AFTER the
# score, never baked into the matcher. NOTE (L120 honesty): the legacy `weights` (view/motion/phase) positional
# arg is the pre-certified-primitive factor surface; it is NO LONGER consumed by the live ranking (superseded by
# the certified primitive), but is retained in the signature/CLI to preserve the eval-baseline + caller call-shape (L094).
#
# USAGE: select_partner.py --target-desc T.desc.json[:W] --target-kp T.kp.json --index DIR
#        [--w-geom 1.5 --head-scale 90 --w-body 0.6 --w-view 0.5] [--max-dist 0.6] [--used used.json] [--recency recency.json]
#   -> JSON {partner_clip, partner_kp, partner_window, target_window, dist, parts, sync, no_match}

from __future__ import annotations
import argparse, json, sys, math
from pathlib import Path
HERE=Path(__file__).resolve().parent; sys.path.insert(0,str(HERE))
def _maybe_correspondence():
    """The learned TCC/view/motion correspondence is an OPTIONAL render-phase-sync accelerator (needs torch +
    the .pt weights). It is NOT the matcher: ranking + the zero-wrong admission gate are the CERTIFIED numpy
    path (motion_certify), and the render's DEFAULT time-sync is the certified DTW (render_side_by_side_v2
    --warp-mode dtw — see this module's `sync` field). On a torch-less deployment (the Fly host) this
    capability is simply ABSENT → the emitted `sync` is None and the render falls back to its certified-DTW
    substrate. (L112 required-substrate-vs-removable: the certified DTW sync is the always-present substrate,
    the learned TCC sync is the removable accelerator; L069 capability with a default provider; L089 one code
    path — torch presence is a PHYSICS fact of the host, not a Society branch.) `from correspondence import
    Correspondence` is itself torch-free here (the encoders import torch lazily inside their model builders);
    only `Correspondence()` instantiation imports torch. Returns a Correspondence, or None when unavailable."""
    try:
        from correspondence import Correspondence
        return Correspondence()
    except Exception as e:
        print(f"[select_partner] learned phase-sync unavailable ({type(e).__name__}: {e}); "
              f"emitting sync=None — render uses the certified-DTW substrate", file=sys.stderr)
        return None
import finite_json as FJ  # #198.1 serialization waist — descriptor reads fail CLOSED on a non-finite token (no NaN can defeat a gate from disk)
import swing_state
import motion_certify as MC   # THE CERTIFIED CORRESPONDENCE PRIMITIVE + LABEL-FREE AMBIGUITY GATE (D8/D13/iter4) — admission
from gate_thresholds import HEADING_ADMIT as _HEADING_ADMIT, HEADING_MET as _HEADING_MET, MAX_PAIRS, REFERENCE_MIN_QUALITY   # iter86: gate-threshold CSSOT (same source as check_video egress + produce_batch); iter101: MAX_PAIRS too — select's `top` default IS the variety cap (was a magic 6, sibling of the iter97 SSOT); iter125: REFERENCE_MIN_QUALITY (was a magic 0.45 — the reference-pool swing-quality bar, intentionally looser than the query-side MIN_QUALITY=0.5)

def log(m): print(f"[select] {m}", file=sys.stderr, flush=True)

def parse_weights(s):
    """'view=1,motion=1,phase=0.5' -> {'view':1.0,'motion':1.0,'phase':0.5}. DATA, not policy."""
    out={}
    for tok in s.split(","):
        tok=tok.strip()
        if not tok: continue
        k,_,v=tok.partition("="); out[k.strip()]=float(v) if v else 1.0
    return out or {"view":1.0,"motion":1.0,"phase":0.0}

def _full_swing(w, dd):
    """True iff this window's [backswing..follow] bracket fit INSIDE the clip without edge-clamping — i.e. a
    COMPLETE swing, not one whose backswing or follow-through was cut at a clip boundary. Reads the
    self-describing flag (describe_clip emits it); falls back to computing from the window vs the clip bounds
    for descriptors that predate the flag. Truncated swings render only PART of the stroke ("only the finish")
    → REJECTED fail-closed."""
    fs = w.get("full_swing")
    if fs is not None:
        if isinstance(fs, bool): return fs    # present + well-formed → the self-describing flag is authoritative
        return False                          # present but NON-bool (corrupt, e.g. the string "false") → FAIL CLOSED:
        #                                       a malformed completeness flag is never trusted (no bool("false")==True; iter91/B2).
        #                                       absent (fs is None) still falls through to the authoritative bounds check below.
    t0, t1, c0, c1 = w.get("t0"), w.get("t1"), dd.get("clip_t0"), dd.get("clip_t1")
    if None in (t0, t1, c0, c1): return False      # cannot prove completeness (pre-bounds descriptor) → REJECT
                                                   # (fail-closed; a stale --config sibling index must not slip a
                                                   # truncated/finish-only window through unverified — re-enrich it)
    return (t0 > c0 + 0.05) and (t1 < c1 - 0.05)

def full_swing_admissible(w) -> bool:
    """COARSE full-swing prefilter truthiness for the batch/upload candidate scan (produce_batch + match_one), which
    runs BEFORE the authoritative _full_swing bounds check in select(). Present well-formed flag → that bool; present
    NON-bool (corrupt) → False (FAIL CLOSED — never let a string like "false" read truthy; iter91/B2); ABSENT → True
    (coarse: a descriptor predating the flag is admitted here and rigorously re-gated by _full_swing in select, which
    uses the clip-bounds fallback). SSOT for the prefilter truthiness so the two drivers don't each re-implement (and
    independently re-break) the bool coercion. NOT a substitute for _full_swing — it is the looser pre-pass."""
    fs = w.get("full_swing", True)
    return fs if isinstance(fs, bool) else False

def _corr(a, b):
    """Pearson correlation of two equal-length sequences; None if either is flat (no direction signal)."""
    n=min(len(a),len(b))
    if n<2: return None
    a=a[:n]; b=b[:n]; ma=sum(a)/n; mb=sum(b)/n
    cov=sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    va=sum((a[i]-ma)**2 for i in range(n)); vb=sum((b[i]-mb)**2 for i in range(n))
    if va<=1e-9 or vb<=1e-9: return None
    return cov/(va*vb)**0.5

def _circ_dist(a, b):
    """Circular absolute distance in degrees, [0,180]. 180 = exact reversal (chest vs back)."""
    d = abs(float(a) - float(b)) % 360.0
    return min(d, 360.0 - d)

def _resample(seq, n=10):
    """Phase-normalize a swing-scoped trajectory to n points (windows are takeback→follow from peak detect)."""
    if not seq: return None
    return [seq[min(len(seq) - 1, int(i * len(seq) / n))] for i in range(n)]

def _heading_dist(qh, ch):
    """Median per-phase circular |Δheading| (deg) — the CAMERA-AZIMUTH correspondence. A swing is a rotation,
    so compare the phase-aligned heading TRAJECTORY (validated: same-camera ~14deg, reversed ~139deg), not a
    scalar. None if either heading is unavailable. Replaces the CLIP `facing` distance which provably could
    not resolve front/back."""
    if not isinstance(qh, dict) or not isinstance(ch, dict): return None
    qt = _resample(qh.get("traj")); ct = _resample(ch.get("traj"))
    if not qt or not ct: return None
    # capstone-10 #2 (SAFETY): a NaN heading SAMPLE makes the median |Δheading| NaN, and `nan > tol_deg` is False →
    # _heading_blocks does NOT block → the camera-azimuth reversal veto silently fails OPEN (a forehand-from-front
    # paired with one-from-back). The heading gate is a HARD fail-CLOSED invariant, so a non-finite trajectory is
    # UNVERIFIABLE → return None → _heading_blocks fails closed (rejects the pair). Validate the VALUES, not just conf.
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in qt) \
       or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in ct):
        return None
    ds = sorted(_circ_dist(a, b) for a, b in zip(qt, ct))
    return ds[len(ds) // 2]

def _heading_conf_ok(h, min_conf, min_frames):
    if not isinstance(h, dict): return False
    confs = h.get("conf") or []
    if h.get("n", 0) < min_frames or not confs: return False
    return (sum(confs) / len(confs)) >= min_conf

def _heading_blocks(qh, ch, tol_deg, min_conf, min_frames):
    """Camera-AZIMUTH gate — the real reversal fix (JointBDOE heading trajectory). FAIL-CLOSED: orientation
    is a HARD invariant (a forehand seen from the front must NOT be paired with one seen from the back), so
    if either clip's heading is missing or low-confidence we REJECT (cannot verify same-camera ⇒ do not
    pair) — never fail-open to a guess (Codex finding #1). Otherwise reject when the phase-aligned median
    |Δheading| exceeds tol_deg (validated boundary ~75: same/side camera ≤57deg, reversed/back ≥63deg).
    Returns True to BLOCK."""
    if not _heading_conf_ok(qh, min_conf, min_frames) or not _heading_conf_ok(ch, min_conf, min_frames):
        return True   # fail-closed: cannot verify orientation → do not pair
    d = _heading_dist(qh, ch)
    return d is None or d > tol_deg

def _elev_blocks(qe, ce, birdseye_t, min_conf):
    """ELEVATION axis of the camera-on-sphere primitive (camera pitch, orientation.py CLIP axis — the
    birdseye signal pose+facing cannot supply). The CLIP elevation projection carries a cross-IDENTITY
    offset (different footage/cameras shift the absolute value), so absolute |Δ| is unreliable — but the
    BIRDSEYE REGION is robust: measured birdseye ∈ [+0.014,+0.029] (always positive), all eye/ground level
    < 0, and a framing-degraded ground query still reads strongly negative. So the gate rejects a pair that
    STRADDLES the birdseye boundary (one overhead, one ground) — exactly the iter5 failure — which the sign
    captures offset-free, the same way facing uses its front/back boundary at 0. Fires only when BOTH clips
    have confident elevation; else defer (fail-open, since elevation is one axis among several). True=BLOCK.
    REVIEWED 2026-06-20 (Codex-converged, #38): KEEP this fail-open — fail-closing on low-conf would reject
    uncertain-but-GROUND clips the certified motion gate can safely decide (the rare low-conf reading measured
    was a ground clip, not a birdseye straddle). The elevation low-conf case is the SAME S1 2D-observability
    bedrock (safe-XOR-useful), not a separately-fixable wrong-camera hole; the certified motion gate is the
    admission authority and elevation is a cheap CONFIDENT region-straddle veto, never a hard-required signal."""
    if not isinstance(qe,dict) or not isinstance(ce,dict): return False
    if qe.get("conf",0)<min_conf or ce.get("conf",0)<min_conf: return False
    # capstone-10 #3: this veto is fail-OPEN by design (defer to the certified motion gate when it can't confidently
    # decide). A non-finite elevation VALUE is exactly that "can't decide" case — make it EXPLICIT (return False=defer)
    # rather than rely on the accident that `nan > t` is False for both sides. Never silently trust a NaN/Inf reading.
    qv, cv = qe.get("value"), ce.get("value")
    if not isinstance(qv,(int,float)) or isinstance(qv,bool) or not math.isfinite(qv) \
       or not isinstance(cv,(int,float)) or isinstance(cv,bool) or not math.isfinite(cv):
        return False
    return (float(qv)>birdseye_t) != (float(cv)>birdseye_t)

def select(target_desc_path, target_kp, win, index_dir, weights=None, max_dist=1.0,   # iter97: `weights` = DEAD legacy positional (real ranking = w_geom/w_body/w_view kwargs below; L26/L120) → now OPTIONAL so live drivers stop passing a dead dict; frozen eval + select CLI still pass it positionally (ignored → byte-identical, L094). calibrate_null.py: p95 0.74, mean+3σ 1.01
           cert_admit=MC.DEFAULT_COMPARISON_SPEC.cert_admit,  # CERTIFIED admission ε (=0.22). iter81 SSOT: the
                              # no-spec default is SOURCED FROM the canonical default ComparisonSpec, not a 2nd literal
                              # — so the bar ALWAYS comes from a spec (the provided one via the override at the top of
                              # the body, or the default one here). Change pose_schema.DEFAULT_COMPARISON_SPEC and this
                              # follows automatically (CSSOT). MANDATE-COMPLIANT zero-wrong point (iter5 broad labeled
                              # sweep: 0.22→0 wrong, 0.30→1.7%, 0.45→3.5%; 0.45 was an OVERCLAIM, 10 wrong/286). COST:
                              # cross-person recall near-0 (correct cross-person ~0.30 > 0.22) — the 2D FH/BH bound (D12)
                              # forces safe-XOR-useful; usefulness needs temporal-3D lift (NOT MediaPipe-3D/D1) or dense
                              # same-view refs (ML059). D90: this bar is CHANNEL-SET-CALIBRATED — a non-default spec MUST
                              # re-calibrate it (carried in ComparisonSpec.cert_admit) + re-validate 0-wrong.
           cert_same=MC.DEFAULT_COMPARISON_SPEC.cert_same,    # ε_same (=0.30): two REFERENCES self-certify (same
                              # motion) below this — defines "different motion" for the ambiguity gate. SSOT from the spec.
           ambig_margin=MC.DEFAULT_COMPARISON_SPEC.ambig_margin,  # AMBIGUITY GATE (=0.05): refuse (no_match) if a
                              # DIFFERENT-motion candidate is within this of the best — the structural fail-closed that
                              # makes a confident WRONG match impossible (D13). SSOT from the spec (pass None to ablate).
           used=None, recency=None, used_penalty=0.25, recency_bonus=0.02,
           min_quality=REFERENCE_MIN_QUALITY, view_max=0.60, top=MAX_PAIRS, heading_tol=_HEADING_ADMIT, heading_met_tol=_HEADING_MET,  # iter86: CSSOT (was 75.0/40.0 literals); iter101: top=MAX_PAIRS (was 6); iter125: min_quality=REFERENCE_MIN_QUALITY (was magic 0.45)
           heading_min_conf=0.45, heading_min_frames=6, elev_birdseye=0.007, elev_min_conf=0.4,
           w_geom=1.5, head_scale=90.0, w_body=0.6, w_view=0.5,   # RANKING weights = DATA (byte-identical
           # defaults). POST-ADMISSION ordering ONLY — correctness is the certified gate above, never these weights.
           salience_keypoints=None,    # which joints center the certified CROP (motion_certify._contact_clamp). DATA:
           # None = the tennis wrist pair (byte-identical); a domain (footwork=ankles) passes its own so query+candidate
           # crop on the SAME salient joints the segmenter used (iter46 — the salience seam reaches the live matcher).
           comparison_spec=None,
           labels=None, want=None, class_margin=None):
           # LABELLED MODE (Nov 25 2026). labels = {reference key: class} from a human-labelled library (its folders),
           # want = the class a partner must have, class_margin = how much closer the target must be to `want` than to
           # any other labelled class. None = off: label-free, byte-identical. Why: the label-free gates are
           # calibrated on ONE person's library; across people (a student against a pro) a correct pair sits at
           # ~0.30-0.5 > cert_admit, and the label-free ambiguity gate fires on spread WITHIN one class (two pro
           # forehands from different azimuths do not self-certify). With labels, "which motion is this?" is
           # answered by the nearest labelled class with a margin; cert_admit (passed by the caller) only bounds
           # "too different to be a useful comparison". Contrast windows count before the heading/elevation gates,
           # so more contrast only ever refuses more.      # the CERTIFIED comparison representation (pose_schema.ComparisonSpec): which
           # body channels are compared + their mirror/observability/cert calibration. DATA: None = the default COCO
           # limb+trunk (byte-identical tennis); a domain passes its own so the live matcher compares its channels
           # WITHOUT editing this file (iter73 — the comparison seam reaches the live matcher; Codex capstone #1/D82).
           # Every MC.descriptor_at/MC.dist below threads THIS spec, so query+candidate+ambiguity all use ONE spec.
    """FAIL-CLOSED partner selection. Returns an ADMISSIBLE SET of CAMERA-CORRECT partners (view-family +
    azimuth + elevation + salience gates) RANKED by the learned MOTION+VIEW+PHASE correspondence, with a
    calibrated NULL: if nothing clears the motion-match bar, no_match. NO stroke label anywhere — which motion
    a window is (forehand, two-handed backhand, serve, anything) is an emergent cluster in the learned motion
    space, never an enum the engine names (L063). NEVER a forced nearest-neighbour; an empty or over-threshold
    set -> no_match (the factory then skips — it never fabricates a wrong comparison)."""
    # iter81 (L069 completeness — D90): the live admission calibration TRAVELS WITH the channels it calibrates.
    # D90 proved cert_admit/cert_same/ambig_margin are channel-set-CALIBRATED (a FIXED 0.22 admits 0 wrong at 12
    # channels but 2 at 10 and 10 at 8 — the worst-channel veto's max shrinks as channels drop). So the bars ALWAYS
    # come from a ComparisonSpec: a PROVIDED spec's bars win here (a domain re-calibrates by editing its spec, never
    # a separate arg); NO spec → the signature defaults already source the DEFAULT spec's bars (CSSOT, byte-identical
    # tennis 0.22/0.30/0.05). Exception: an EXPLICIT no-spec arg (e.g. the ablation test's ambig_margin=None, or
    # cert_same=0.99) is left intact — only a provided spec overrides. This consumes the iter81 ComparisonSpec
    # bars that iter68 forgot to move here alongside min_reliable+epsilon.
    if comparison_spec is not None:
        cert_admit = comparison_spec.cert_admit
        cert_same = comparison_spec.cert_same
        ambig_margin = comparison_spec.ambig_margin
    # capstone-9 #2/#3 (SAFETY/HIGH): a selector threshold that is NaN/Inf passes float() but DEFEATS its gate —
    # `quality < min_quality` is False for min_quality=NaN (the salient-motion gate goes OFF, a walk/pan admits),
    # and `_heading_blocks(...heading_tol)` never blocks for heading_tol=NaN (the azimuth front/back-reversal gate
    # goes OFF → reversed footage becomes a confident WRONG match). Validate every admission threshold FINITE
    # BEFORE any gate comparison (fail-closed: a degenerate bar raises, never silently opens the gate).
    for _tn, _tv in (("min_quality", min_quality), ("view_max", view_max), ("heading_tol", heading_tol),
                     ("heading_met_tol", heading_met_tol), ("heading_min_conf", heading_min_conf),
                     ("elev_birdseye", elev_birdseye), ("elev_min_conf", elev_min_conf)):
        if isinstance(_tv, bool) or not isinstance(_tv, (int, float)) or not math.isfinite(_tv):
            raise ValueError(f"select_partner.{_tn} must be a FINITE number (NaN/Inf silently disables its admission "
                             f"gate — admit-anything), got {type(_tv).__name__} {_tv!r}")
    # capstone-10 #4: `heading_min_frames` is a COUNT (capstone-9 excluded it as "a count") but a negative/NaN value
    # disables the min-frame azimuth evidence gate (`n < heading_min_frames` is False for min_frames=-1) → a single
    # spurious high-conf heading frame passes. Validate it as a non-bool int >= 0 (0 = "no minimum", the only valid relaxation).
    if isinstance(heading_min_frames, bool) or not isinstance(heading_min_frames, int) or heading_min_frames < 0:
        raise ValueError(f"select_partner.heading_min_frames must be a non-negative int, got "
                         f"{type(heading_min_frames).__name__} {heading_min_frames!r} (a negative value disables the evidence gate).")
    # capstone-10 #5 (MED): POST-admission ranking scalars are unvalidated — `head_scale=0` → ZeroDivisionError, a NaN
    # weight → dist=NaN ordering on a real-looking match. Ranking is ordering-only (the certified gate is the safety
    # authority), but a degenerate knob must not crash or emit a NaN score. Validate finite; head_scale strictly > 0.
    for _rn, _rv in (("w_geom", w_geom), ("w_body", w_body), ("w_view", w_view),
                     ("used_penalty", used_penalty), ("recency_bonus", recency_bonus)):
        if isinstance(_rv, bool) or not isinstance(_rv, (int, float)) or not math.isfinite(_rv):
            raise ValueError(f"select_partner.{_rn} must be a FINITE number, got {type(_rv).__name__} {_rv!r}.")
    if isinstance(head_scale, bool) or not isinstance(head_scale, (int, float)) or not math.isfinite(head_scale) or head_scale <= 0:
        raise ValueError(f"select_partner.head_scale must be a FINITE number > 0 (it divides the camera-azimuth term), "
                         f"got {type(head_scale).__name__} {head_scale!r}.")
    if labels is not None:
        if not isinstance(want, str) or not want:
            raise ValueError(f"select_partner.want must name the class a partner must have, got {want!r}")
        for _ln, _lv in (("class_margin", class_margin), ("cert_admit", cert_admit)):
            if isinstance(_lv, bool) or not isinstance(_lv, (int, float)) or not math.isfinite(_lv) or _lv < 0:
                raise ValueError(f"select_partner.{_ln} must be a finite number >= 0 in labelled mode, got {_lv!r}")
        if want not in set(labels.values()):
            raise ValueError(f"select_partner.want {want!r} is not a class of any labelled reference")
    from match_clips import viewpoint_dist
    # #198.1 (Codex #8/#1): read the QUERY descriptor through the serialization waist — a cached/legacy/poisoned
    # `.desc.json` carrying a NaN/Inf token (which `nan<x` would silently sail through, defeating quality/heading/
    # elevation gates downstream) is REJECTED here and the query fails CLOSED to no_match, never matches on poison.
    try:
        td=FJ.load_text(target_desc_path)
    except FJ.NonFiniteJSON as _e:
        return {"no_match":True,"pool_windows":0,"reason":f"query_descriptor_nonfinite:{_e}"}
    if not td.get("windows"): return {"no_match":True,"pool_windows":0,"reason":"query_no_window"}  # generic (was "query_no_swing" — domain word in output, S2/L039; 0 consumers, siblings already generic)
    # capstone-10 #1: `win=min(win,len-1)` SILENTLY clamped an out-of-range index → an oversized `win` (or `win=-1`,
    # which `min` leaves at -1 → `windows[-1]`) compared the WRONG motion event under the guise of a real match.
    # A window index outside [0,len-1] is bad query addressing → fail CLOSED (no_match), never silently retarget.
    if isinstance(win,bool) or not isinstance(win,int) or win<0 or win>=len(td["windows"]):
        return {"no_match":True,"pool_windows":0,"reason":f"query_bad_window_index:{win!r}"}
    tw=td["windows"][win]
    # QUERY GATE: the target window must be a REAL motion event (salient, not a walk/pan) AND a FULL
    # (untruncated) motion. NO stroke label — we match the student's motion AS-IS, whatever it is (forehand,
    # two-handed backhand, both-sides, switch — the engine never names it). Stroke "type" is an emergent
    # cluster in the learned MOTION space, never a gate (the L063 instance-solving fix, 2026-06-19).
    if FJ.finite_float(tw.get("quality",0), float("-inf"))<min_quality:  # F2 (capstone-15): a string "NaN"/non-finite quality is the WORST → refuse, never float('nan')<bar==False fail-open
        return {"no_match":True,"pool_windows":0,"reason":f"query_not_salient:{tw.get('quality')}"}
    if not _full_swing(tw, td):
        return {"no_match":True,"pool_windows":0,"reason":"query_truncated_motion"}
    qview=(tw.get("viewpoint") or {}).get("vec")
    qheading=tw.get("heading")
    qelev=tw.get("elevation")
    qstate=tw.get("state")
    corr=_maybe_correspondence()                                 # OPTIONAL torch accelerator; None on a torch-less host → certified-DTW sync substrate
    q=corr.window(target_kp, tw.get("t0",0), tw.get("t1",0)) if corr is not None else None   # learned window — kept ONLY for render phase-sync
    qc=MC.descriptor_at(target_kp, tw.get("t0",0), tw.get("t1",0), salience_keypoints=salience_keypoints, spec=comparison_spec)  # CERTIFIED descriptor — the admission matcher (iter4); crop salience = DATA (iter46); comparison channels = DATA (iter73)
    if qc is None:
        return {"no_match":True,"pool_windows":0,"reason":"query_descriptor_unavailable"}

    # S7 — EXACT SUBLINEAR VIEW-FAMILY RETRIEVAL (P7 / L099). The view-family hard gate used to be an O(total)
    # linear scan over EVERY index window; now a BallTree over viewpoint_embed (match_clips, SSOT) returns
    # EXACTLY the windows within view_max in ~O(log n + k) — viewpoint_dist == L2 of the embeds, so the radius
    # query yields the identical set (proven byte-identical). The expensive certified-DTW + the heading/elev
    # gates then run ONLY on the in-family candidates: the admitted pool is IDENTICAL to the old full scan
    # (every other gate ANDs with the view gate; AND is commutative), the out-of-family windows are just never
    # touched. Within-view motion pruning (avoiding DTW on every in-family candidate) remains the open residual.
    from viewpoint_index import get_index
    vindex=get_index(index_dir)
    tgt=Path(target_desc_path).resolve()
    tgt_fp=(td.get("source") or {}).get("fingerprint")           # CONTENT identity of the query clip (CAS fingerprint, SSOT)
    cand=vindex.query(qview, view_max)                            # [(key, window_idx, desc_path)] inside the view family, sublinearly
    seen=vindex.total_windows                                     # diagnostics: total windows in the index
    gated_view=max(0, seen-len(cand))                             # windows outside the view family (the gate the index applied)
    pool=[]; gated_q=0; gated_heading=0; gated_elev=0; gated_trunc=0; gated_motion=0; gated_self=0
    others=[]; gated_unlabelled=0                                 # labelled mode: contrast-class distances; unlabelled refs
    _reccache={}                                                  # load each candidate's desc/kp file ONCE
    for key,i,f in cand:
        if Path(f).resolve()==tgt: continue                      # exclude the query's own clip by PATH (leave-one-clip-out)
        cached=_reccache.get(f)
        if cached is None:
            key0=Path(f).stem.replace(".desc","")
            kp0=Path(index_dir)/"_work"/f"{key0}.kp.json"
            try: rec0=FJ.load_text(f)                                  # #198.1: a non-finite candidate descriptor is rejected here…
            except Exception: rec0=None                               # …and the existing fail-closed path skips it (never a poisoned match)
            src0=(rec0.get("source") or {}) if rec0 is not None else {}
            cached=_reccache[f]=((rec0, kp0, src0.get("path"), src0.get("fingerprint")) if (rec0 is not None and kp0.exists()) else False)
        if cached is False: continue
        rec,kp,src,sfp=cached
        # Exclude the query's own clip by CONTENT identity too, not just path: a duplicate descriptor of the SAME
        # underlying clip under a different path (mixed/self index) shares source.fingerprint (CAS, SSOT). The path
        # check above catches same-path; this closes the rest so a clip can never match itself (Codex round-2 #7).
        if tgt_fp and sfp==tgt_fp: gated_self+=1; continue
        ws=rec.get("windows",[])
        if i>=len(ws): continue
        w=ws[i]
        # Same gates as the old full scan — only the VIEW gate moved into the index. WHICH motion a window is
        # stays an emergent cluster decided by the certified MOTION distance, never a closed enum (L063).
        if FJ.finite_float(w.get("quality",0), float("-inf"))<min_quality: gated_q+=1; continue   # SALIENCE gate (real motion event); F2: non-finite quality = WORST → gated
        if not _full_swing(w, rec): gated_trunc+=1; continue                          # FULL-MOTION gate (no truncated/finish-only)
        vd=viewpoint_dist(qview, (w.get("viewpoint") or {}).get("vec"))               # EXACT view-family gate is the AUTHORITY
        if vd is None or vd>view_max: gated_view+=1; continue                         # (index is a fast sound retriever; re-check trims
        #                                                                              # any float-boundary false-add or stale-cache add — Codex)
        if labels is not None:                                                        # LABELLED MODE: class from the human label
            lab=labels.get(Path(f).stem.replace(".desc",""))
            if lab is None: gated_unlabelled+=1; continue                             # an unlabelled reference is never a partner
            if lab!=want:                                                             # CONTRAST: its distance only ever refuses
                oc=MC.descriptor_at(str(kp), w.get("t0",0), w.get("t1",0), salience_keypoints=salience_keypoints, spec=comparison_spec)
                od,_=MC.dist(qc, oc, mode="worst", spec=comparison_spec)
                if od is not None: others.append((od, lab))
                continue
        # CHEAP HARD GATES BEFORE THE EXPENSIVE CERTIFIED DTW (heading/elev depend only on precomputed vectors).
        if _heading_blocks(qheading, w.get("heading"), heading_tol, heading_min_conf, heading_min_frames):  # AZIMUTH (front/back reversal) gate,
            gated_heading+=1; continue                                                      # FAIL-CLOSED — heading needed (geom can't see front/back, ML048)
        if _elev_blocks(qelev, w.get("elevation"), elev_birdseye, elev_min_conf):           # ELEVATION (birdseye) gate
            gated_elev+=1; continue
        bc=MC.descriptor_at(str(kp), w.get("t0",0), w.get("t1",0), salience_keypoints=salience_keypoints, spec=comparison_spec)  # CERTIFIED descriptor (iter4); crop salience = DATA (iter46); comparison channels = DATA (iter73)
        cs,gpar=MC.dist(qc, bc, mode="worst", spec=comparison_spec)                           # CERTIFIED same-motion admission: worst reliable (SAME spec as the descriptors — iter73)
        if cs is None or cs>cert_admit:                                                      # channel must agree + observability fail-closed.
            gated_motion+=1; continue                                                       # REPLACES the unsafe geom τ gate (L101, D13).
        gd=cs                                                                                # certified score IS the ranking distance now
        hd=_heading_dist(qheading, w.get("heading"))                                        # camera-azimuth correspondence (deg) for ranking + scorecard
        b=corr.window(str(kp), w.get("t0",0), w.get("t1",0)) if corr is not None else {"kp_path":str(kp),"t0":w.get("t0",0),"t1":w.get("t1",0)}  # learned window — render phase-sync only; torch-less → plain carrier (kp_path/t0/t1 are the only bundle fields read downstream)
        b=dict(b); b["src"]=src; b["clip_cas"]=sfp; b["window_idx"]=i; b["desc"]=f; b["key"]=key; b["view_dist"]=round(vd,4)  # clip_cas = source.fingerprint (CAS SSOT) carried onto the winner so the render/diagnosis consumer mounts the winning reference VIDEO by content address — never by reversing the lossy safe_key (L098: the matcher owns index internals and hands back a finished address)
        b["heading_dist"]=round(hd,1) if hd is not None else None
        b["geom_dist"]=round(gd,4); b["geom_parity"]=gpar                                    # CERTIFIED correspondence distance + render parity
        b["motion_dist"]=round(gd,4)                                                         # back-compat field name = certified distance
        b["_cdesc"]=bc                                                                       # certified descriptor — for the ambiguity gate (not serialized)
        b["state"]=w.get("state")                                                            # biomechanics+situation channels for the scorecard
        pool.append(b)
    diag={"pool_windows":len(pool),"seen":seen,"gated_view":gated_view,"gated_quality":gated_q,"gated_heading":gated_heading,"gated_elev":gated_elev,"gated_truncated":gated_trunc,"gated_motion":gated_motion,"gated_self":gated_self}
    if labels is not None:
        near=min(others) if others else None
        diag["gated_unlabelled"]=gated_unlabelled
        diag["class_check"]={"want":want,"same":(round(min(it["geom_dist"] for it in pool),4) if pool else None),
                             "other":(round(near[0],4) if near else None),"other_class":(near[1] if near else None),
                             "contrast_windows":len(others),"margin":class_margin,"admit":cert_admit}
    if not pool: return {"no_match":True,**diag,"reason":"no_admissible_motion_in_view_family"}
    if labels is not None:
        if near is None:                                          # no labelled contrast in this view family: the class
            for p in pool: p.pop("_cdesc",None)                   # cannot be checked → fail closed
            return {"no_match":True,**diag,"reason":"no_contrast_class_in_view_family"}
        pool=[it for it in pool if near[0]-it["geom_dist"]>=class_margin]   # every partner, not only the best, clears the margin
        if not pool:
            return {"no_match":True,**diag,"reason":"not_clearly_the_wanted_class"}

    # AMBIGUITY GATE (D13, iter4) — DEFENSE-IN-DEPTH against a confident WRONG match (iter59/D65 corrected its role).
    # The PRIMARY zero-wrong guarantor is the certified admission gate (worst reliable channel ≤ cert_admit): the
    # iter59 ablation (ambiguity_ablation.py) proved the 0.22 cert threshold ALONE admits 0 wrong-class matches across
    # all 368 clean Reference Player windows — so this gate is a redundant SECOND layer here, not the sole structural fail-closed
    # the comment once claimed. It still earns its place: it guards the FORESHORTENED-AMBIGUITY regime the cert
    # threshold could miss on denser data — a query can 2D-project comparably close to TWO DIFFERENT motions (a
    # backhand near both a backhand AND a forehand from a back view — the c6377 bug). So: REFUSE (no_match) when a
    # DIFFERENT-motion candidate is within `ambig_margin` of the best. "Different motion" is LABEL-FREE: two candidates
    # are different iff they do NOT self-certify (MC.dist > cert_same). Recall is correctly sacrificed under genuine
    # ambiguity; we never lie (L083). (Kept despite a tiny recall cost — 1 sacrificed-correct, 0 wrong-prevented on
    # THIS corpus — because trading a structural safety layer for ~0.3% recall on a known-hard regime is wrong, L075.)
    if labels is None and cert_admit is not None and ambig_margin is not None:   # labelled mode: the class margin above replaces it
        best=min(pool, key=lambda it: it["geom_dist"]); bd=best["geom_dist"]
        for it in pool:
            if it is best or it["geom_dist"]-bd>ambig_margin: continue   # only candidates comparably close to best
            s2,_=MC.dist(best["_cdesc"], it["_cdesc"], mode="worst", spec=comparison_spec)      # do best & this candidate self-certify (same motion)? SAME spec as their descriptors (iter73)
            if s2 is None or s2>cert_same:                               # NO → a DIFFERENT motion is comparably close → ambiguous
                for p in pool: p.pop("_cdesc",None)
                return {"no_match":True,**diag,"reason":"ambiguous_two_motions_comparably_close",
                        "ambiguity":{"best_dist":round(bd,4),"other_dist":round(it["geom_dist"],4),
                                     "cross_self_certify":(None if s2 is None else round(s2,4)),"cert_same":cert_same}}
    for p in pool: p.pop("_cdesc",None)                                   # strip non-serializable descriptors before ranking/return

    # Pool is now CAMERA-CORRECT (view/heading/elev) + certified SAME-MOTION + UNAMBIGUOUS. An empty pool already
    # returned the fail-closed null above. Within this safe pool we RANK by certified closeness + camera azimuth +
    # biomechanics + view. NO stroke label anywhere — which motion a window is stays an emergent cluster (L063).
    used=used or set(); recency=recency or {}
    scored=[]
    for it in pool:
        gd=float(it.get("geom_dist") or 2.0)                     # GENERIC same-motion correspondence (PRIMARY)
        hd=it.get("heading_dist")
        head_term=(float(hd)/head_scale) if hd is not None else 0.5  # camera azimuth: 0deg->0, 75deg->0.83 (head_scale=DATA)
        sc=swing_state.compare(qstate, it.get("state"))          # biomechanics+situation channels
        # Fold the CAMERA channel into the SAME scorecard the user reads — but be HONEST (L116): the
        # ADMISSIBILITY gate (heading_tol, 75deg) only proves "not reversed / not wrong-side", NOT "same camera
        # angle" (a 75deg pair is a quarter-turn apart). So "met" uses a TIGHTER honest threshold
        # (heading_met_tol, ~40deg = clearly the same camera position). 40-75deg ⇒ measured but NOT met.
        if hd is not None:
            ok=hd<=heading_met_tol; sc["channels"]["camera_angle"]={"dist":round(hd,1),"pass":ok,"label":"camera angle"}
            sc["measured"]+=1; sc["met"]+=int(ok)
        body_term=sc["score"] if sc["score"] is not None else 0.5  # biomechanics+situation closeness (0=perfect)
        score=w_geom*gd+head_term+w_body*body_term+w_view*float(it.get("view_dist",0))  # geometry LEADS; camera+body+view refine (weights=DATA)
        if it.get("src") in used: score+=used_penalty
        score-=recency_bonus*float(recency.get(it.get("src"),0.0))
        # RANK to MAXIMIZE requirements MET (the user's "find the MOST matching"); break ties by closeness. Safe
        # because the pool is already same-motion (τ_geom), so "most met" never overrides stroke-correctness.
        scored.append(((-sc["met"], round(score,4)), gd, it, {}, sc))
    scored.sort(key=lambda x:x[0])
    pairs=[]
    for sortkey,gd,bi,parts,sc in scored:
        score=sortkey[1]
        pairs.append({
            "partner_clip":bi.get("src"), "partner_clip_cas":bi.get("clip_cas"), "partner_kp":bi["kp_path"], "partner_window":bi["window_idx"],
            "target_window":win,
            "target_t":[round(float(tw.get("t0",0)),3), round(float(tw.get("t1",0)),3)],
            "partner_t":[round(float(bi.get("t0",0)),3), round(float(bi.get("t1",0)),3)],
            "dist":round(score,4), "corr_dist":round(gd,4), "view_dist":bi.get("view_dist"),
            "heading_dist":bi.get("heading_dist"), "scorecard":sc, "parts":parts,
            "sync":(corr.phase_align(q, bi) if corr is not None else None),   # learned TCC time-sync = OPTIONAL; None on a torch-less host → render uses certified-DTW (its default)
            # chirality from the GEOMETRY canonical flips (mover-shoulder orientation) — 'reflected' ⇒ query &
            # partner are opposite-handed ⇒ render mirrors ONE cell; 'direct' ⇒ same-handed, no mirror (ML046).
            "parity":bi.get("geom_parity"),
            "motion_dist":bi.get("geom_dist")})
        if len(pairs)>=top: break
    if not pairs:
        return {"no_match":True,**diag,"reason":"no_pairs_after_rank"}
    best=pairs[0]
    return {"no_match":False, **best, "pairs":pairs, **diag}   # top-level best (back-compat) + full admissible set

def main()->int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--target-desc",required=True); ap.add_argument("--target-kp",required=True)
    ap.add_argument("--index",required=True)
    # VIEW is a HARD pre-rank gate (hand viewpoint feature), so the learned-factor weights RANK within the
    # admitted same-view family; the MOTION weight + calibrated null decide which motion is a credible match.
    ap.add_argument("--weights",default="view=0.3,motion=1,phase=0.5")
    ap.add_argument("--max-dist",type=float,default=1.0)   # calibrate_null.py-derived (p95 0.74, mean+3σ 1.01)
    ap.add_argument("--view-max",type=float,default=0.60,help="hard camera-family gate on hand viewpoint_dist")
    ap.add_argument("--min-quality",type=float,default=REFERENCE_MIN_QUALITY,help="reference swing-quality gate (CSSOT: gate_thresholds.REFERENCE_MIN_QUALITY, intentionally looser than the query-side MIN_QUALITY)")
    ap.add_argument("--heading-tol",type=float,default=_HEADING_ADMIT,help="camera-azimuth ADMISSIBILITY gate: reject when median per-phase |Δheading| (deg) exceeds this (catches reversal; validated boundary ~75). Default = gate_thresholds CSSOT.")
    ap.add_argument("--heading-met-tol",type=float,default=_HEADING_MET,help="HONEST 'same camera angle' threshold for the scorecard: camera_angle counts as MET only when |Δheading| ≤ this (40-75deg is admissible but reported NOT met). Default = gate_thresholds CSSOT.")
    ap.add_argument("--heading-min-conf",type=float,default=0.45,help="min mean JointBDOE conf to trust a clip's heading (else FAIL-CLOSED reject)")
    ap.add_argument("--heading-min-frames",type=int,default=6,help="min detected heading frames to trust a clip (else FAIL-CLOSED reject)")
    ap.add_argument("--elev-birdseye",type=float,default=0.007,help="camera-on-sphere ELEVATION boundary: CLIP-elev above this = birdseye; block pairs straddling it")
    ap.add_argument("--elev-min-conf",type=float,default=0.4,help="only apply the elevation guard when both clips' elevation conf ≥ this")
    ap.add_argument("--top",type=int,default=MAX_PAIRS,help="size of the admissible set returned for variety")   # iter101: SSOT (was a magic 6)
    # RANKING weights = DATA (post-admission ORDER only; correctness is the certified gate, not these). Defaults byte-identical to the prior hardcoded formula.
    ap.add_argument("--w-geom",type=float,default=1.5,help="RANKING weight on certified geom_dist")
    ap.add_argument("--head-scale",type=float,default=90.0,help="RANKING heading-dist normalization scale (deg)")
    ap.add_argument("--w-body",type=float,default=0.6,help="RANKING weight on biomechanics/state body_term")
    ap.add_argument("--w-view",type=float,default=0.5,help="RANKING weight on view_dist")
    ap.add_argument("--used",default=None); ap.add_argument("--recency",default=None)
    # DOMAIN salient effector pair for the certified crop (motion_certify._contact_clamp) — DATA, the SAME seam
    # the live drivers pass (iter46/iter50). JSON bare-list, e.g. '["r_ankle","l_ankle"]'; omitted = tennis wrist
    # default (None) → byte-identical. So the standalone select CLI serves ANY domain, not just tennis (S2/S3).
    ap.add_argument("--salience-keypoints",default=None,help='JSON bare-list of the domain salient joint pair for the certified crop, e.g. \'["r_ankle","l_ankle"]\' (None=tennis wrist default → byte-identical)')
    # DOMAIN certified COMPARISON spec for the admission matcher (motion_certify) — DATA, the SAME seam the live drivers
    # pass (iter73/iter78). JSON dict {"channels":[...],"mirror":{...},"min_reliable":N,"epsilon":E}; omitted = default
    # COCO limb+trunk (None) → byte-identical. So the standalone select CLI serves ANY domain's channels (Codex iter77 #2).
    ap.add_argument("--labels",default=None,help='LABELLED MODE: a JSON file {reference key: class} from a human-labelled library; needs --want, --class-margin and --class-admit')
    ap.add_argument("--want",default=None,help="labelled mode: the class a partner must have")
    ap.add_argument("--class-margin",type=float,default=None,help="labelled mode: the target must be at least this much closer to --want than to any other class")
    ap.add_argument("--class-admit",type=float,default=None,help="labelled mode: the certified distance bound of a useful comparison (replaces cert_admit)")
    ap.add_argument("--comparison-spec",default=None,help='JSON dict of the domain certified comparison spec, e.g. \'{"channels":["l_ankle",...],"mirror":{...},"epsilon":0.3}\' (None=default COCO limb+trunk → byte-identical)')
    a=ap.parse_args()
    tp,_,wi=a.target_desc.partition(":"); wi=int(wi) if wi else 0
    used=set(FJ.load_text(a.used).get("used",[])) if a.used and Path(a.used).exists() else set()  # #198.6: via finite waist
    recency=FJ.load_text(a.recency) if a.recency and Path(a.recency).exists() else {}  # #198.6: recency weights (floats) via finite waist
    sk=tuple(json.loads(a.salience_keypoints)) if a.salience_keypoints else None   # bad joints fail-loud downstream in motion_certify._contact_clamp (iter46 #2b)
    cspec=None
    if a.comparison_spec:                                # build the ComparisonSpec from DATA (fail-loud on a bad spec: ComparisonSpec raises)
        from pose_schema import ComparisonSpec
        cspec=ComparisonSpec.from_dict(json.loads(a.comparison_spec))   # iter82: ONE dict→spec parser; constructor
        #                              owns every default (incl. iter81 bars) — CSSOT, no duplicated default literals
    labelled={}
    if a.labels:
        labelled={"labels":FJ.load_text(a.labels),"want":a.want,"class_margin":a.class_margin,"cert_admit":a.class_admit}
    r=select(tp,a.target_kp,wi,a.index,parse_weights(a.weights),a.max_dist,**labelled,
             used=used,recency=recency,salience_keypoints=sk,comparison_spec=cspec,
             min_quality=a.min_quality,view_max=a.view_max,top=a.top,
             heading_tol=a.heading_tol,heading_met_tol=a.heading_met_tol,heading_min_conf=a.heading_min_conf,heading_min_frames=a.heading_min_frames,
             elev_birdseye=a.elev_birdseye,elev_min_conf=a.elev_min_conf,
             w_geom=a.w_geom,head_scale=a.head_scale,w_body=a.w_body,w_view=a.w_view)
    print(json.dumps(r,indent=2))
    if r and r.get("no_match"): log(f"NO credible partner in {r.get('pool_windows',0)} windows (best_dist {r.get('best_dist')})")
    elif r: log(f"partner: {Path(r['partner_clip']).name if r.get('partner_clip') else '?'} (dist {r['dist']}, {r['parts']})")
    return 0

if __name__=="__main__": raise SystemExit(main())

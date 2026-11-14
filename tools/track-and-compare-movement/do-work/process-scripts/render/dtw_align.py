#!/usr/bin/env python3
# tools/motion/dtw_align.py
#
# PURPOSE: Frame-accurate SYNC for the side-by-side. Given two pose tracks (reference + subject) over their
#          matched windows, compute a Dynamic Time Warp (DTW) alignment of the FULL normalized pose
#          trajectories, then resample it to N output frames → for each output frame k, the SOURCE timestamps
#          (ts_ref[k], ts_subj[k]) that show CORRESPONDING stroke phases. The two motions then stay in sync at
#          EVERY phase (takeback → contact → follow-through), not just at a single contact anchor: a slow
#          ~10 mph student and an ~80 mph pro get sped-up / slowed-down PER PHASE so each output frame matches.
#          This is exactly Person One's directive (2026-06-23): "slow down or speed up the players at different
#          times… always be in sync at the correct part of the strokes… each frame matched to the pose."
#
# WHY DTW (not the 3-anchor piecewise warp it replaces): 3 anchors (takeback/contact/follow-end) force only
# those 3 points to coincide; BETWEEN them each clip plays at its own constant rate, so mid-phase the bodies
# drift, and a single mis-detected contact frame desyncs the whole strike. DTW aligns the ENTIRE trajectory,
# so it is robust to one ambiguous frame AND keeps every sub-phase aligned (L055 deepest-root fix for the
# "I get to the ball quicker than he does" desync).
#
# GENERIC / DOMAIN-AGNOSTIC (S2/S3): operates on COCO pose only — no stroke labels, no tennis vocabulary. The
# salient EFFECTOR pair (DATA; None → wrists) is weighted higher in the frame distance so the strike aligns
# tightly, but the WHOLE body drives the warp. PARITY-aware: a 'reflected' subject is mirrored (x-negate +
# L/R-joint swap) BEFORE the comparison — exactly how the renderer mirrors that cell — so the aligned poses
# are the SHOWN poses.
#
# NO new gate surface: this only changes WHICH source frame each cell shows WHEN (render timing). The plan,
# keypoints, windows, parity, and comparison spec are untouched, so check_video C1-C12 are unaffected.
#
# API: dtw_frame_map(person_ref, person_subj, window_ref, window_subj, parity, effector, n_out, mc=0.3)
#        -> (ts_ref[n_out], ts_subj[n_out])   # monotene-nondecreasing SOURCE timestamps (clip seconds)
#      Operates on already-extracted main_track person dicts (no kp I/O, no main_track) so the renderer that
#      already loaded them just hands them in — zero import cycle with render_side_by_side_v2.

from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "match"))  # shared canonical pose schema (SSOT)
from pose_schema import JI, COCO, DEFAULT_EFFECTOR

# Body joints that carry swing PHASE (arms = the swing arc, legs = the stance/rotation). Head is excluded as a
# phase signal (it barely moves through a swing); it is used only for SIZE normalization below.
# DERIVED from the pose_schema COCO SSOT (iter75/L063) — COCO is ordered head(0..4) then body(5..16), so the head
# split is exactly COCO[:5] and the phase-feature body set is exactly COCO[5:]. Re-listing them here would be an
# SSOT duplicate that silently diverges if COCO's ordering ever changes; deriving keeps one source of truth.
_HEAD  = COCO[:5]    # nose, eyes, ears — SIZE normalization only (byte-identical to the prior explicit list)
_FEAT  = COCO[5:]    # shoulders→ankles — the swing-phase body joints (byte-identical to the prior explicit list)
_ANK   = ["l_ankle", "r_ankle"]
_TORSO = ["l_shoulder", "r_shoulder", "l_hip", "r_hip"]


def _swap(name: str) -> str:
    """The mirror-partner joint (a hflip swaps left↔right body sides)."""
    if name.startswith("l_"): return "r_" + name[2:]
    if name.startswith("r_"): return "l_" + name[2:]
    return name


def _win_frames(person, window):
    """The person's frames restricted to the matched window (t0,t1); None / too-few → whole clip. Same rule the
    renderer + describe use, so DTW aligns the SAME motion the matcher certified."""
    fr = person["frames"]
    if window:
        t0, t1 = window
        w = [f for f in fr if t0 <= f.get("t", 0) <= t1]
        if len(w) >= 3:
            return w
    return fr


def _norm_params(kp, mc):
    """(cx, cy, scale) to make a frame's pose translation- and size-invariant: center on the torso (median of
    confident shoulders+hips), scale by body height (head-top → feet) so a near vs far body compares equally.
    Falls back to the confident-point centroid / bbox span when torso or head/feet are not both visible."""
    conf = [(k[0], k[1]) for k in kp if k[2] >= mc]
    if len(conf) < 2:
        return None
    tor = [(kp[JI[n]][0], kp[JI[n]][1]) for n in _TORSO if kp[JI[n]][2] >= mc]
    if tor:
        cx = sum(p[0] for p in tor) / len(tor); cy = sum(p[1] for p in tor) / len(tor)
    else:
        cx = sum(p[0] for p in conf) / len(conf); cy = sum(p[1] for p in conf) / len(conf)
    head = [kp[JI[n]][1] for n in _HEAD if kp[JI[n]][2] >= mc]
    ank  = [kp[JI[n]][1] for n in _ANK if kp[JI[n]][2] >= mc]
    if head and ank:
        scale = max(1.0, max(ank) - min(head))
    else:
        ys = [p[1] for p in conf]; xs = [p[0] for p in conf]
        scale = max(1.0, max(max(ys) - min(ys), max(xs) - min(xs)))
    return cx, cy, scale


def _feat(frame, mirror, mc):
    """Normalized per-joint feature dict {name:(x,y)} + confidence dict. `mirror`=True (reflected subject):
    read the SWAP joint and negate x — identical to the renderer's hflip of that cell — so the compared pose is
    the SHOWN pose. Returns ({}, {}) for an unreadable frame (DTW routes around it via the fallback distance)."""
    kp = frame["kp"]; npar = _norm_params(kp, mc)
    if npar is None:
        return {}, {}
    cx, cy, scale = npar
    vec = {}; conf = {}
    for name in _FEAT:
        src = _swap(name) if mirror else name
        p = kp[JI[src]]
        if p[2] >= mc:
            x = (p[0] - cx) / scale; y = (p[1] - cy) / scale
            if mirror:
                x = -x
            vec[name] = (x, y); conf[name] = True
        else:
            conf[name] = False
    return vec, conf


def _weights(effector):
    """Per-joint weight in the frame distance. The salient EFFECTOR pair (DATA; None → wrists) dominates so the
    STRIKE aligns tightly; the elbow chain gets a small boost; everything else is baseline. Generic: a footwork
    domain passing ankle effectors weights the FOOT strike, with zero code change."""
    eff = set(effector) if effector else set(DEFAULT_EFFECTOR)
    w = {}
    for name in _FEAT:
        if name in eff:
            w[name] = 3.0
        elif name in ("l_elbow", "r_elbow"):
            w[name] = 1.5
        else:
            w[name] = 1.0
    return w


_NOSHARE = 5.0   # finite, large per-joint-scale distance when two frames share NO confident feature joint


def _fdist(fa, ca, fb, cb, w):
    """Weighted mean Euclidean distance over joints confident in BOTH frames (normalized pose units). No shared
    joint → a large finite cost so DTW prefers routes through observable frames without ever hitting infinity."""
    num = 0.0; den = 0.0
    for name in _FEAT:
        if ca.get(name) and cb.get(name):
            ax, ay = fa[name]; bx, by = fb[name]
            num += w[name] * ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
            den += w[name]
    return _NOSHARE if den <= 0 else num / den


def _dtw_path(A, B, w, band_frac=0.34, gap_pen=0.0):
    """Classic DTW DP with a Sakoe-Chiba band (|j - i·nb/na| ≤ r). The band keeps the warp from collapsing many
    frames of one clip onto a single frame of the other (a degenerate alignment) while still allowing the real
    per-phase speed differences a swing-vs-swing match needs. Returns the monotone path [(iA,iB), …].

    gap_pen: ANTI-STALL penalty added to every non-diagonal (hold) step. A pure-min DTW, where one clip's takeback
    is ~2× the other's, pays nothing to park the faster clip on ONE frame while the slower clip runs (a dead
    FREEZE — measured 28 output frames). gap_pen makes each hold cost a little, so the path still SLOWS the faster
    clip (matching poses, what we want) but keeps it creeping forward instead of stalling. 0.0 = classic DTW."""
    na, nb = len(A), len(B)
    if na == 0 or nb == 0:
        return [(0, 0)]
    INF = float("inf")
    r = max(abs(na - nb) + 1, int(band_frac * max(na, nb)) + 1)
    D = [[INF] * (nb + 1) for _ in range(na + 1)]
    D[0][0] = 0.0
    for i in range(1, na + 1):
        center = (i * nb) // na                     # diagonal at row i (center=nb at i=na → corner reachable)
        jlo = max(1, center - r); jhi = min(nb, center + r)
        Ai0, Ai1 = A[i - 1]
        for j in range(jlo, jhi + 1):
            c = _fdist(Ai0, Ai1, B[j - 1][0], B[j - 1][1], w)
            D[i][j] = c + min(D[i - 1][j - 1], D[i - 1][j] + gap_pen, D[i][j - 1] + gap_pen)
    i, j = na, nb; path = []
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        d, u, l = D[i - 1][j - 1], D[i - 1][j] + gap_pen, D[i][j - 1] + gap_pen
        m = min(d, u, l)
        if m == INF:                                # outside the band (defensive) → step diagonally
            i -= 1; j -= 1
        elif m == d:
            i -= 1; j -= 1
        elif m == u:
            i -= 1
        else:
            j -= 1
    path.reverse()
    return path or [(0, 0)]


def _hext(frame, mc):
    """HORIZONTAL extension of the swinging arm in one frame = max over wrists of |wrist_x − hip-center_x| /
    body-height (size-normalized). This is the CONTACT landmark for a side-view swing: at ball-strike the racket
    arm is extended OUT toward the ball (large horizontal reach, moderate height). It deliberately ignores the
    VERTICAL component — the iter168 bug was using TOTAL (Euclidean) reach, which peaks at the OVERHEAD
    follow-through (large vertical, e.g. the subject's wrist 208px above the hip) and pinned that to the pro's
    contact (Person One's "I'm already at contact while Reference Player has time to go"). Returns None when hips/wrist are
    unobservable. (Side-view is the matcher-gated case; horizontal == the hitting direction there.)"""
    kp = frame["kp"]
    hips = [kp[JI[n]] for n in ("l_hip", "r_hip") if kp[JI[n]][2] >= mc]
    if not hips:
        return None
    cx = sum(h[0] for h in hips) / len(hips)
    head = [kp[JI[n]][1] for n in _HEAD if kp[JI[n]][2] >= mc]
    ank = [kp[JI[n]][1] for n in _ANK if kp[JI[n]][2] >= mc]
    bh = max(1.0, max(ank) - min(head)) if head and ank else 1.0
    best = None
    for wname in ("l_wrist", "r_wrist"):
        p = kp[JI[wname]]
        if p[2] >= mc:
            best = max(best if best is not None else 0.0, abs(p[0] - cx) / bh)
    return best


def _contact_idx(frames, mc):
    """Index of CONTACT (ball-strike) within `frames`: the frame of MAX horizontal arm extension (_hext = arm
    out toward the ball). NO speed gate — a speed gate is the trap: a slow student accelerates INTO the overhead
    follow-through (wrist fastest at the top of the whip, NOT at contact), so gating on speed re-locks onto the
    overhead finish (measured: 30%-speed-gate put the subject at 75% = overhead, vs ungated 54% = the strike).
    Pure horizontal extension already excludes BOTH static traps geometrically: the overhead finish has the arm
    VERTICAL (small |dx|), and the coiled backswing is the other extreme (also smaller |dx| than the full
    forward strike for the swings seen). Falls back to the midpoint if pose is unobservable throughout.
    Validated: Reference Player 35% of window (17px above hip), subject 54% (122px) — both arm-out strikes, not the
    86px/208px overhead finishes the iter168 total-reach detector locked onto."""
    n = len(frames)
    if n == 0:
        return 0
    he = [_hext(f, mc) for f in frames]
    cand = [i for i in range(n) if he[i] is not None] or [n // 2]
    return max(cand, key=lambda i: he[i] if he[i] is not None else -1.0)


def _resample(path, idxA, idxB, tA, tB, n):
    """Resample a DTW `path` (index pairs into idxA/idxB) to `n` output steps → list of (t_ref, t_subj)."""
    L = len(path); out = []
    for k in range(n):
        pos = 0 if n <= 1 else round(k * (L - 1) / (n - 1))
        i, j = path[pos]
        out.append((tA[idxA[i]], tB[idxB[j]]))
    return out

def _smooth_holds(times, eps=1e-4):
    """FREEZE → GLIDE. A monotone non-decreasing source-time list (one cell's warp over a segment) often REPEATS a
    value across several output frames — a HOLD: the same source frame shown repeatedly = a visible FREEZE. This
    happens whenever the faster clip has fewer frames than the slower one over the same anchored span (the surplus
    output frames must show *something*, so DTW repeats). Replace each interior run of (near-)equal values with a
    linear ramp between its bounding distinct neighbors, so the clip CREEPS forward fractionally instead. Rendered
    with motion-interpolated in-between frames (renderer interp), the creep becomes genuine slow-motion. The FIRST
    and LAST entries are LOCKED — callers pass exactly one inter-anchor segment, so its endpoints are swing-event
    anchors (split / drop / contact) that must stay frame-exact; smoothing per-segment keeps EVERY anchor exact.
    Monotonic and bounded by the neighbors → zero effect on which poses correspond, only freeze→glide."""
    t = list(times); n = len(t)
    if n < 3:
        return t
    i = 0
    while i < n:
        j = i
        while j + 1 < n and abs(t[j + 1] - t[i]) <= eps:     # maximal run [i..j], all ≈ t[i]
            j += 1
        if j > i:
            # Ramp the run's NON-LOCKED members linearly between its bounding distinct values, using the run's own
            # value as the bound on whichever side has no distinct neighbor (start/end). This dissolves a hold —
            # including one that runs INTO the locked last anchor (the contact freeze: a tail of equal contact-time
            # frames). lo→hi is taken over the full extent [left_idx..right_idx] so interior frames creep strictly
            # between the neighbors and the locked endpoints (index 0, n-1) never move.
            lo = t[i - 1] if i > 0 else t[i]
            hi = t[j + 1] if j + 1 < n else t[j]
            left_idx = i - 1 if i > 0 else i
            right_idx = j + 1 if j + 1 < n else j
            a = i if i > 0 else 1
            b = j if j < n - 1 else n - 2
            if right_idx > left_idx and hi > lo:
                for k in range(a, b + 1):
                    t[k] = lo + (hi - lo) * (k - left_idx) / (right_idx - left_idx)
        i = j + 1
    return t


def _half_map(fr, fs, tA, tB, ia0, ia1, ib0, ib1, mirror, w, n, gap_pen=0.0):
    """DTW-align ONE swing segment (ref frames [ia0..ia1], subj frames [ib0..ib1]) and resample to `n` output
    steps → list of (t_ref, t_subj). Real frame-by-frame pose correspondence (not linear): the slow/fast parts
    of EACH player's segment are sped up / slowed down so the SAME pose shows at the SAME output frame. Endpoints
    are pinned (path starts (0,0), ends at the segment's last index pair) so the segment boundary — i.e. CONTACT —
    is exact in both cells. gap_pen forwards the anti-stall penalty so a 2×-tempo segment slows but never freezes."""
    idxA = list(range(ia0, ia1 + 1)); idxB = list(range(ib0, ib1 + 1))
    A = [_feat(fr[i], False, mc=0.3) for i in idxA]
    B = [_feat(fs[j], mirror, mc=0.3) for j in idxB]
    covA = sum(1 for v, _ in A if v) / max(1, len(A))
    covB = sum(1 for v, _ in B if v) / max(1, len(B))
    if min(covA, covB) < 0.75:
        # POSE GAP in this segment (e.g. a motion-blurred follow-through finish the tracker lost): DTW would
        # stall on the last observable frame and the gap's video would never play (the finish gets cut). Fall
        # back to PROPORTIONAL time so both clips play smoothly THROUGH the gap and reach the segment end (the
        # finish) together. Endpoints are real anchors, so this only affects the untrackable interior.
        return [(tA[idxA[0]] + (tA[idxA[-1]] - tA[idxA[0]]) * (0.0 if n <= 1 else k / (n - 1)),
                 tB[idxB[0]] + (tB[idxB[-1]] - tB[idxB[0]]) * (0.0 if n <= 1 else k / (n - 1))) for k in range(n)]
    path = _dtw_path(A, B, w, gap_pen=gap_pen)
    return _resample(path, idxA, idxB, tA, tB, n)


def dtw_frame_map(person_ref, person_subj, window_ref, window_subj, parity, effector, n_out, mc=0.3,
                  contact_frac=None, contact_ref_t=None, contact_subj_t=None,
                  anchors_ref=None, anchors_subj=None, gap_pen=0.06, smooth_slowmo=False):
    """CONTACT-ANCHORED DTW (frame-by-frame within each half). Returns (ts_ref, ts_subj): two length-`n_out`
    lists of SOURCE timestamps (clip seconds), monotone non-decreasing, such that output frame k shows
    person_ref at ts_ref[k] and person_subj at ts_subj[k] — CORRESPONDING stroke phases. CONTACT is forced to
    coincide (lands at the same output frame in both cells, killing "I get to the ball quicker than he does"),
    and DTW aligns the FULL pose trajectory WITHIN the takeback half AND the follow-through half so EVERY frame —
    approach and finish — matches by pose, not just the contact instant. The subject is mirrored iff
    parity == 'reflected' (the renderer hflips that cell), so the alignment is on the SHOWN pose.

    contact_ref_t / contact_subj_t (clip seconds): the VERIFIED ball-strike instant of each clip. Reference Player's is
    ball-detected (YOLO sports-ball trajectory reversal); the subject's phone clip rarely yields a usable ball,
    so it is pose-transferred (the subject frame whose pose matches the reference's ball-verified contact) and
    eye-confirmed. When None, fall back to _contact_idx (horizontal-arm-extension landmark) — generic default
    for domains/clips without a verified contact. NOTE (iter170): _contact_idx (max horizontal arm extension)
    was measured to land ~3 frames (0.1s) BEFORE the true ball-strike on Reference Player — the hand reaches its
    most-forward point, then the racket head whips THROUGH and strikes the ball a few frames later. The verified
    contact overrides this; do not anchor sync on arm-extension alone for the watched moment.

    contact_frac: output fraction at which contact lands. When None, computed from the REAL swing proportion
    (mean pre-contact span / mean total span) so playback tempo tracks the actual stroke — caller should pass
    windows whose pre/post spans already match (trim the longer clip's follow-through to the shorter clip's
    tracked span) so the follow halves DTW comparable poses end-to-end instead of mapping a full finish onto a
    chopped one.

    WHY anchored, not pure full-window DTW: pure DTW minimizes TOTAL pose distance (dominated by torso/legs/
    stance) and SMEARS the brief arm-extension instant (measured 21-frame contact desync). Splitting at the
    verified contact and DTW-ing each half makes contact exact AND keeps every sub-phase frame-aligned."""
    fr = _win_frames(person_ref, window_ref)
    fs = _win_frames(person_subj, window_subj)
    tA = [float(f.get("t", i / 30.0)) for i, f in enumerate(fr)]
    tB = [float(f.get("t", i / 30.0)) for i, f in enumerate(fs)]
    # INTERIOR anchor times (clip seconds), forced to coincide in the output. A multi-anchor list (e.g.
    # [takeback-onset, contact]) takes precedence — every named swing event lands on the same output frame in
    # both cells, so the WHOLE stroke (not just contact) is locked and DTW only earns smoothness BETWEEN events.
    # This kills the "your cell starts later / freezes during his takeback then catches up at contact" artifact:
    # with contact the sole anchor, the unequal ready-hold + takeback tempo was absorbed as a degenerate
    # many-to-one hold in the low-motion lead-in. Falls back to the single contact anchor, then _contact_idx.
    if anchors_ref and anchors_subj and len(anchors_ref) == len(anchors_subj):
        arr = list(anchors_ref); ars = list(anchors_subj); multi = True
    else:
        arr = [contact_ref_t if contact_ref_t is not None else tA[_contact_idx(fr, mc)]]
        ars = [contact_subj_t if contact_subj_t is not None else tB[_contact_idx(fs, mc)]]
        multi = False
    ia = [0] + [min(range(len(tA)), key=lambda i: abs(tA[i] - t)) for t in arr] + [len(fr) - 1]
    ib = [0] + [min(range(len(tB)), key=lambda j: abs(tB[j] - t)) for t in ars] + [len(fs) - 1]
    segs = len(ia) - 1
    if segs == 2 and not multi and contact_frac is not None:  # single-anchor back-compat: contact at contact_frac
        bounds = [0, max(1, min(n_out - 1, round(contact_frac * n_out))), n_out]
    else:                                                     # output frames per segment ∝ its mean real span
        spans = [max(1e-6, ((tA[ia[s + 1]] - tA[ia[s]]) + (tB[ib[s + 1]] - tB[ib[s]])) / 2.0) for s in range(segs)]
        total = sum(spans); bounds = [0]; acc = 0.0
        for s in range(segs):
            acc += spans[s]
            bounds.append(max(bounds[-1] + 1, min(n_out, round(acc / total * n_out))))
        bounds[-1] = n_out
    w = _weights(effector); mirror = (parity == "reflected")
    # LITERAL boundary times (sub-frame anchor precision). The DTW correspondence is computed on discrete pose
    # frames (ia/ib are nearest-frame indices), but in smooth-slowmo the boundary output time is forced to the
    # caller's EXACT anchor value — which may fall BETWEEN pose frames. Combined with motion-interpolated render
    # frames (renderer interp), this lands contact (and every swing-event anchor) at a true sub-frame instant the
    # 30fps grid can't represent — needed when a player's real contact is, e.g., 3.908s (between 3.900 and 3.933).
    bt_ref = [tA[0]] + list(arr) + [tA[-1]]
    bt_subj = [tB[0]] + list(ars) + [tB[-1]]
    ts_ref = []; ts_subj = []
    for s in range(segs):                                     # anchors land on bounds[]; within each segment, DTW
        # pose-matches frame-by-frame (slows/speeds each clip so the SAME body position shows at the SAME output
        # frame — what "make each frame match" means). gap_pen lets a 2×-tempo segment SLOW without a dead freeze.
        m = bounds[s + 1] - bounds[s] + 1
        seg = _half_map(fr, fs, tA, tB, ia[s], ia[s + 1], ib[s], ib[s + 1], mirror, w, m, gap_pen=gap_pen)
        if smooth_slowmo:                                     # freeze→glide PER SEGMENT, endpoints = LITERAL anchor
            sr = [t for t, _ in seg]; ss = [t for _, t in seg] # times (sub-frame), so every anchor is frame-exact
            if m >= 2:                                        # to the caller's value; interior frames creep (slow-mo)
                sr[0], sr[-1] = bt_ref[s], bt_ref[s + 1]
                ss[0], ss[-1] = bt_subj[s], bt_subj[s + 1]
            seg = list(zip(_smooth_holds(sr), _smooth_holds(ss)))
        chunk = seg if s == 0 else seg[1:]                    # drop duplicated boundary frame (shared anchor)
        ts_ref += [t for t, _ in chunk]; ts_subj += [t for _, t in chunk]
    return ts_ref[:n_out], ts_subj[:n_out]

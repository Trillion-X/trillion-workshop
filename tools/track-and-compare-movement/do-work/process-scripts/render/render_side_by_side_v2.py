#!/usr/bin/env python3
# tools/motion/render_side_by_side_v2.py
#
# PURPOSE: Geometry-CORRECT side-by-side (Person One's v1 feedback). Uses pose keypoints to put
#          BOTH bodies at the same size + position — top-of-head same Y, body centered same X,
#          feet same Y — and mirrors the STUDENT cell ONLY when the motion-match parity is
#          'reflected' (chirality DERIVED from the footage, never a handedness label — L063).
#          NO skeleton overlay (pose is behind-the-scenes). Synced at the contact keyframe
#          (peak speed over BOTH wrists — side-agnostic, can't pick the idle hand). All ffmpeg.
#
# METHOD per clip: from the main track's keypoints in a window around contact, measure
#   head_top_y (min of nose/eyes/ears), feet_y (max of ankles), center_x (median of
#   shoulder/hip midpoint). Scale so body fills a fixed share of the cell; overlay onto a
#   black cell so head_top->TOP and center_x->cell center. hflip the student cell iff parity='reflected'.
#
# USAGE: render_side_by_side_v2.py --a-video A --a-kp a.json --b-video B --b-kp b.json
#        --out OUT.mp4 [--parity direct|reflected]
#        [--label-a "Person One"] [--label-b "Reference Player"] [--preroll 1.0] [--duration 2.4]
#        [--cell-w 960] [--cell-h 1080] [--font PATH]

from __future__ import annotations
import argparse, json, math, os, shutil, statistics, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "match"))  # shared canonical pose schema (SSOT)
from pose_schema import COCO, JI, DEFAULT_EFFECTOR, canonicalize_pose_track  # SSOT (iter67 COCO/JI; iter92 DEFAULT_EFFECTOR); #198.5 keypoint canonicalizer
HEAD=["nose","l_eye","r_eye","l_ear","r_ear"]; ANK=["l_ankle","r_ankle"]
TORSO=["l_shoulder","r_shoulder","l_hip","r_hip"]
def log(m): print(f"[sbs2] {m}", file=sys.stderr, flush=True)

def _run(cmd):
    """ffmpeg/subprocess wrapper that RAISES on failure (so a failed DTW frame-dump can never silently produce a
    wrong remap). Mirrors build_ig_video.run — fail-closed."""
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"cmd failed: {' '.join(map(str, cmd))[:160]}\n{r.stderr[-300:]}")
    return r.stdout

def _dump_and_reindex(video, t0, t1, fps, want_times, work, tag, interp=1):
    """DTW frame REMAP for one clip. Dump [t0,t1] of `video` to PNGs, then SYMLINK them into a NEW sequence so
    output frame k is the source PNG nearest want_times[k] — i.e. apply the DTW timestamp map exactly, frame by
    frame. Returns the reindexed '<tag>_%05d.png' pattern for ffmpeg. (An arbitrary per-output-frame source map
    cannot be expressed as a single setpts expression — a frame remap is the exact, generic way to retime.)

    interp>1 (SMOOTH SLOW-MO): dump at fps*interp using ffmpeg `minterpolate` motion-compensated interpolation
    (mci/aobmc/bidir), so the source grid has `interp`× real in-between frames. Combined with fractional
    want_times (see _smooth_holds), this turns frame-HOLDS (a faster clip's frame repeated to fill a slower
    clip's span = a visible freeze) into genuine slow-motion: the held output frames now land on distinct
    interpolated poses. idx(t)=round((t-t0)*fps*interp). interp=1 is the original nearest-frame behavior."""
    src = work / f"src_{tag}"; dst = work / f"warp_{tag}"
    src.mkdir(parents=True, exist_ok=True); dst.mkdir(parents=True, exist_ok=True)
    g = float(fps) * max(1, int(interp))                   # effective sampling grid (interpolated fps)
    span = max(0.05, (t1 - t0) + 1.0 / max(1.0, fps))      # +1 frame so the last window frame is included
    if int(interp) > 1:
        # INPUT seek (-ss BEFORE -i): jump to the window FIRST, then interpolate only ~span seconds. With output
        # seek (-ss after -i) the minterpolate filter runs on the ENTIRE decoded stream from 0s (e.g. 698s ×
        # interpolated-fps of motion estimation) before the trim discards it — catastrophic for late-in-clip
        # windows. Input seek is accurate (decodes from the prior keyframe to t0) so output frame 1 ≈ t0, keeping
        # idx(t)=round((t-t0)*g) valid. Used ONLY for interp>1 so the interp=1 default stays byte-identical.
        cmd = ["ffmpeg", "-nostdin", "-y", "-ss", f"{t0:.3f}", "-i", str(video), "-t", f"{span:.3f}",
               "-vf", f"minterpolate=fps={g:g}:mi_mode=mci:mc_mode=obmc:me_mode=bidir",
               "-vsync", "0", "-an", str(src / f"{tag}_%05d.png"), "-loglevel", "error"]
    else:
        cmd = ["ffmpeg", "-nostdin", "-y", "-i", str(video), "-ss", f"{t0:.3f}", "-t", f"{span:.3f}",
               "-vf", f"fps={g:g}", "-vsync", "0", "-an", str(src / f"{tag}_%05d.png"), "-loglevel", "error"]
    _run(cmd)
    pngs = sorted(src.glob(f"{tag}_*.png"))
    if not pngs:
        raise RuntimeError(f"DTW: no frames dumped for {video} [{t0:.2f},{t1:.2f}]")
    n = len(pngs)
    for k, t in enumerate(want_times):
        idx = int(round((t - t0) * g)); idx = max(0, min(n - 1, idx))
        os.symlink(pngs[idx].resolve(), dst / f"{tag}_{k + 1:05d}.png")
    return str(dst / f"{tag}_%05d.png")

def find_font():
    for p in [os.path.expanduser("~/Library/Fonts"),"/Library/Fonts","/System/Library/Fonts"]:
        for pat in ("*LMRoman*Italic*","*lmroman*italic*","*Latin*Modern*Italic*"):
            h=list(Path(p).glob(pat)) if Path(p).exists() else []
            if h: return str(h[0])
    return None

def main_track(kp, mc=0.3):
    best=None; bs=-1
    W=kp.get("video",{}).get("width",1) or 1
    for p in kp.get("persons",[]):
        hs=[];
        for f in p["frames"]:
            ys=[k[1] for k in f["kp"] if k[2]>=mc]
            if len(ys)>=6: hs.append(max(ys)-min(ys))
        if not hs: continue
        sc=len(hs)*statistics.median(hs)
        if sc>bs: bs=sc; best=p
    return best

def _eff(side, effector=None):
    """The salient EFFECTOR joint name on `side` ('l'|'r'). effector = the domain's salient pair (DATA, from
    ProductionConfig.salience via the plan/CLI); None → '{side}_wrist' (byte-identical tennis). A footwork domain
    passes ('r_ankle','l_ankle') so the side-by-side SYNC anchors on the ANKLE-strike, not the still wrist (iter48)."""
    sk = effector or DEFAULT_EFFECTOR   # None = the universal hands default (pose_schema SSOT; iter92, order irrelevant: _eff side-matches)
    for n in sk:
        if n.startswith(side+"_"): return n
    return sk[0] if sk else side+"_wrist"

def _norm_effector(raw):
    """Validate + normalize an effector spec from the UNTRUSTED --salience-keypoints boundary into a clean
    bilateral (left,right) pair, or None for the tennis wrist default. FAIL-LOUD on a present-but-invalid value
    (matches motion_certify's joint validation at the certified boundary) — NEVER silently fall back to wrists,
    which would render the WRONG joint with no warning. Accepts: None (→None); a bare 2-list
    ['r_ankle','l_ankle']; or, defensively, the full-config dict {'salience_keypoints':[...]} so a mis-wired
    caller fails with a CLEAR message instead of the cryptic JI['salience_keypoints'] KeyError."""
    if raw is None:
        return None
    if isinstance(raw, dict):                       # defensive: a full SalienceConfig dict passed by mistake
        raw = raw.get("salience_keypoints")
    if not isinstance(raw, (list, tuple)):
        raise ValueError(f"--salience-keypoints must be a JSON list of 2 joint names, got {type(raw).__name__}: {raw!r}")
    names = [str(n) for n in raw]
    if len(names) != 2:
        raise ValueError(f"--salience-keypoints needs exactly 2 joint names (one left + one right effector), got {len(names)}: {names}")
    bad = [n for n in names if n not in JI]
    if bad:
        raise ValueError(f"--salience-keypoints has unknown joint(s) {bad}; valid COCO names: {COCO}")
    sides = {("l" if n.startswith("l_") else "r" if n.startswith("r_") else "?") for n in names}
    if sides != {"l","r"}:
        raise ValueError(f"--salience-keypoints must be one LEFT (l_*) and one RIGHT (r_*) joint, got {names}")
    return tuple(names)

def parse_window(s):
    """Parse a 'start,end' seconds window string → (start, end) tuple, or None if ABSENT. THE one fail-closed window
    parser (iter96/Codex B2 — SSOT): both this renderer's CLI and build_ig_video's no-plan path use it (was two
    divergent copies). ABSENT (None / empty) → None → whole clip, legitimate only where the operator chose the clips
    directly (no matcher claim). PRESENT-but-malformed (non-numeric / not exactly two values) RAISES — a specified
    window must NEVER silently drop to a whole-clip uncertified render (the c6377 wrong-motion class at the pixel
    stage). The live --plan path serializes ALREADY-VALIDATED windows through here, so it never hits the raise
    (byte-identical); only a hand-malformed CLI window does."""
    if not s:
        return None
    try:
        t0, t1 = [float(x) for x in s.split(",")]              # exactly 2 → unpack raises ValueError on wrong arity
        if not (math.isfinite(t0) and math.isfinite(t1)):     # capstone-16 #3: float("nan")/"inf" PARSE fine (numeric!) but
            raise ValueError("non-finite window bound")        # a NaN/Inf window bound → degenerate/whole-clip render. The
        #                                                       docstring promises malformed FAILS CLOSED; finite is part of that.
    except ValueError as e:
        raise SystemExit(f"[sbs2] window {s!r} must be 'start,end' FINITE floats ({e}) — present-but-malformed fails closed; "
                         f"a specified window must never silently drop to a whole-clip uncertified render")
    return (min(t0, t1), max(t0, t1))


def _wrist_speed(fr, joint, mc=0.3):
    """Per-frame speed of the given EFFECTOR joint (full COCO name, e.g. 'r_wrist' or 'r_ankle')."""
    wi=JI[joint]; sp=[0.0]
    for k in range(1,len(fr)):
        a=fr[k-1]["kp"][wi]; b=fr[k]["kp"][wi]
        sp.append(math.dist(a[:2],b[:2]) if (a[2]>=mc and b[2]>=mc) else 0.0)
    return sp

def _impact_index(fr, mc=0.3, effector=None):
    """IMPACT (ball/target strike) index over `fr` — the GENERIC, pose-only, domain-agnostic contact primitive
    (tennis/golf/baseball/boxing). NOT global peak wrist speed: peak speed marks the late FOLLOW-THROUGH whip
    (the hand keeps accelerating after impact) or the OFF-arm's twitch, ~0.4s after the real strike — the
    iter41 convergence root cause of "the pro hits before me" (measured: Reference Player peak-speed=350.267 but real
    strike≈349.85; warp aligned the wrong frame → 633 ms output desync). Instead: (1) the ACTIVE effector =
    the wrist with the greater TOTAL path length over the window (the swinging racket arm; label-/handedness-
    agnostic, so two-hander / one-hander / switch / COCO L↔R swap all work with zero special-casing); (2) IMPACT
    = the frame where THAT wrist is at MAX body-relative REACH (distance to hip-center) among frames moving ≥40%
    of its peak speed — at impact the arm is EXTENDED toward the ball; the across-body wrap at the speed peak has
    SMALL reach and is rejected. Fail-safe: if reach is unobservable (no hips / low conf) fall back to the old
    peak-speed-over-both marker so behavior never degrades below the prior baseline. Returns (index, active_wrist).
    NOTE (iter41/Codex): this is the RENDER's contact primitive only; the certified MATCHER uses its own separate
    speed-peak logic (describe_clip.peak_time / motion_certify._contact_clamp) and is intentionally untouched here
    — unifying both on this proxy (with index regen + frozen selection/confusion regression) is queued (#54)."""
    n=len(fr)
    if n==0: return 0, "r"
    re_, le_ = _eff("r",effector), _eff("l",effector)    # the salient effector pair (DATA; None→wrists, byte-identical)
    rs=_wrist_speed(fr,re_,mc); ls=_wrist_speed(fr,le_,mc)
    arm = "r" if sum(rs) >= sum(ls) else "l"             # active effector = larger total path length
    sp = rs if arm=="r" else ls
    wi = JI[re_ if arm=="r" else le_]
    mx = max(sp) if sp else 0.0
    def _reach(k):
        p=fr[k]["kp"][wi]
        hv=[h for h in (fr[k]["kp"][JI["l_hip"]], fr[k]["kp"][JI["r_hip"]]) if h[2]>=mc]
        if p[2]<mc or not hv: return -1.0
        cx=sum(h[0] for h in hv)/len(hv); cy=sum(h[1] for h in hv)/len(hv)
        return math.dist(p[:2], (cx,cy))
    cand=[k for k in range(n) if mx>0 and sp[k] >= 0.4*mx] or list(range(n))
    best=max(cand, key=_reach)
    if _reach(best) < 0:                                  # reach unobservable → peak-speed-over-both fallback
        both=[max(rs[k],ls[k]) for k in range(n)]
        bi=max(range(n), key=lambda i:both[i]) if both else 0
        return bi, ("r" if rs[bi]>=ls[bi] else "l")
    return best, arm

def contact_frame(person, mc=0.3, window=None, effector=None):
    """Contact = the IMPACT frame (max active-effector REACH at speed — see _impact_index), NOT raw peak wrist
    speed. `window`=(t0,t1) restricts the search to the MATCHED motion (so a multi-event clip renders the event
    the matcher chose); None / too-few frames falls back to the whole clip. CHIRALITY-/handedness-FREE: the active
    effector is derived from motion (path length), never a per-person 'racket hand' label. `effector` = the salient
    joint pair (DATA; None→wrists, byte-identical). Returns (contact_frame, active_wrist)."""
    fr=person["frames"]
    if window:
        t0,t1=window
        wfr=[f for f in fr if t0<=f.get("t",0)<=t1]
        if len(wfr)>=3: fr=wfr
    ci, active = _impact_index(fr, mc, effector)
    return fr[ci], active

def _wrist_anchors(person, window=None, mc=0.3, expand=0.35, effector=None):
    """(takeback, contact, follow-end) in clip seconds, CHIRALITY-FREE (the L063 max-over-both fix completed
    on the REACH anchors, 2026-06-20 — contact_frame was already both-wrist; the reach anchors were not).
    CONTACT = peak speed over BOTH wrists WITHIN the matched window (consistent with contact_frame). REACH
    (takeback before / follow-end after) = the furthest EITHER wrist travels from ITS OWN contact position,
    searched in the window EXPANDED by `expand`s each side. Whichever wrist is reliably tracked and reaches
    furthest carries the phase — so a two-hander, a one-hander, a switch-hitter, or a mid-rotation COCO L/R
    label-swap are ALL handled with ZERO special-casing. The old single-active-wrist reach collapsed to 'only
    the finish' whenever the active-at-contact wrist returned toward contact / lost confidence while the OTHER
    wrist carried the swing out (measured: a student follow-through 0.07s→0.6s). `expand`(0.35s) < swing
    separation (~0.8s) so it cannot reach an adjacent swing."""
    allfr=person["frames"]; WR=(JI[_eff("r",effector)],JI[_eff("l",effector)])   # the salient effector pair (DATA; None→wrists, byte-identical; iter48)
    def _spd_both(frames):
        sp=[0.0]
        for k in range(1,len(frames)):
            d=0.0
            for wi in WR:
                a=frames[k-1]["kp"][wi]; b=frames[k]["kp"][wi]
                if a[2]>=mc and b[2]>=mc: d=max(d, math.dist(a[:2],b[:2]))
            sp.append(d)
        return sp
    win_fr=[f for f in allfr if window[0]<=f.get("t",0)<=window[1]] if window else allfr
    if len(win_fr)<3: win_fr=allfr
    spw=_spd_both(win_fr)                                          # both-wrist speed profile → cpk (swing-tempo scale)
    ci_w,_=_impact_index(win_fr,mc,effector); c_t=win_fr[ci_w]["t"]         # CONTACT = IMPACT (max active-effector reach at speed), not the raw speed peak (iter41)
    lo_t=(window[0]-expand) if window else allfr[0]["t"]; hi_t=(window[1]+expand) if window else allfr[-1]["t"]
    fr=[f for f in allfr if lo_t<=f.get("t",0)<=hi_t]
    if len(fr)<3: fr=win_fr
    ci=min(range(len(fr)),key=lambda i:abs(fr[i]["t"]-c_t))
    cpk=max(spw) if spw else 0.0                                   # contact peak speed (both-wrist) = the swing tempo
    SWING_FRAC=0.12                                                # an excursion counts only if the wrist is GENUINELY
    def _wspd(wi,k):                                               # MOVING in-phase (peak ≥ 12% of contact — not a
        a=fr[k-1]["kp"][wi]; b=fr[k]["kp"][wi]                     # near-stationary balance drift). 12% (not 30%):
        return math.dist(a[:2],b[:2]) if (k>0 and a[2]>=mc and b[2]>=mc) else 0.0  # contact is a SHARP spike, so 30%
                                                                  # of it over-rejected real follows (swept: 0.08-0.12
                                                                  # stable at 454/480 follows kept; 0.30 lost 32).
    def _ext(wi, k0, k1, sg0, sg1):                               # (max reach-from-own-contact, argmax idx) for ONE
        c=fr[ci]["kp"][wi]                                        # wrist over [k0,k1); GATED by its peak speed over the
        thr=SWING_FRAC*cpk                                        # IN-PHASE transitions [sg0,sg1) — which EXCLUDE the
        if cpk<=0.0 or thr<=0.0: return -1.0, None               # contact-arrival frame (an off-arm that only spikes
        if max((_wspd(wi,k) for k in range(sg0,sg1)), default=0.0) < thr: return -1.0, None  # AT contact then drifts
        best=-1.0; bi=None                                       # slow no longer qualifies). cpk<=0 ⇒ no swing ⇒ reject.
        for k in range(k0,k1):
            p=fr[k]["kp"][wi]
            if p[2]>=mc and c[2]>=mc:
                d=math.dist(p[:2],c[:2])
                if d>best: best=d; bi=k
        return best, bi
    # The backswing-top / follow-end is carried by the RACKET arm: among wrists whose excursion is REAL SWING
    # motion (in-phase peak speed ≥ SWING_FRAC of contact), take the FARTHEST displacement-from-own-contact. This
    # rejects a slow off-arm balance drift (far but slow) AND an off-arm that merely spikes at contact then drifts
    # (speed window excludes the contact transition) — and, with both-wrist contact, follows the racket hand even
    # across a mid-rotation COCO L/R label swap (jib: left at contact, right carries the follow-through). Displace-
    # ment alone picks the off-arm's wide-but-slow drift; speed alone picks a fast short recoil; far-AND-fast (in
    # the right phase) is the racket arc. If NO wrist qualifies (occluded/unobservable racket arm) the anchor stays
    # at contact → 0 duration → the swing gates reject it (fail-closed, never a faked or off-arm finish).
    # ASYMMETRIC speed windows: a backswing's defining motion IS the approach to contact, so takeback INCLUDES the
    # contact-arrival transition (and its displacement is measured PRE-contact, where an off-arm is tucked → safe).
    # A follow-through's motion is strictly AFTER contact, so follow EXCLUDES the arrival spike (an off-arm that only
    # spikes at contact then drifts no longer qualifies).
    tb_i=ci; fe_i=ci
    if ci>0:
        b=max((_ext(wi,0,ci+1, 1,ci+1) for wi in WR), key=lambda x:x[0])         # backswing: incl. approach-to-contact
        if b[1] is not None: tb_i=b[1]
    if ci<len(fr)-1:
        b=max((_ext(wi,ci,len(fr), ci+1,len(fr)) for wi in WR), key=lambda x:x[0])  # follow: strictly AFTER contact
        if b[1] is not None: fe_i=b[1]
    tb_t=fr[tb_i]["t"]; c_t2=fr[ci]["t"]; fe_t=fr[fe_i]["t"]
    # NO fail-open clamp: if a phase reach is unobservable (tb_i/fe_i stuck at contact), the duration stays 0 so
    # the swing gates (selection _anchor_ok, post-render C9) FAIL it — never fabricate a full swing from window
    # edges. The old `tb=fr[0]`/`fe=fr[-1]` clamp faked a 0.43s follow on an occluded racket arm (conf<mc every
    # post-contact frame). The render warp self-protects with max(0.05,·), so 0-duration cannot reach ffmpeg.
    return round(tb_t,3), round(c_t2,3), round(fe_t,3)

def swing_keyframes(person, window=None, mc=0.3, expand=0.35, effector=None):
    """The three PHASE anchors (takeback, contact, follow-end) for the TIME-WARP, CHIRALITY-FREE — contact and
    reach are both measured over BOTH wrists (see _wrist_anchors). A swing is a rotation at its own tempo;
    anchoring all three lets the renderer phase-normalize so prep/contact/follow stay aligned across tempos.
    The old per-clip single 'racket wrist' was deleted (L030): it collapsed the follow-through to 'only the
    finish' whenever the OTHER wrist carried the swing out (a two-hander / mid-rotation COCO L/R swap)."""
    return _wrist_anchors(person, window, mc, expand, effector)

def _facing(person, window=None, effector=None, mc=0.3):
    """Which way the swing FACES — DERIVED from motion, never a handedness label (L063). At contact the active
    effector is extended toward the hitting direction, so facing = the side of (effector_x − body_center_x) at
    the contact frame: 'right' if the effector is right of the torso center, else 'left'. Returns None if
    unobservable (the --face caller then falls back to auto). This lets a lefty/righty student force the output
    orientation without the renderer ever knowing 'handedness'."""
    cf, active = contact_frame(person, mc, window, effector)
    kp = cf["kp"]
    ew = kp[JI[_eff(active, effector)]]
    tor = [kp[JI[n]] for n in TORSO if kp[JI[n]][2] >= mc]
    if ew[2] < mc or not tor:
        return None
    cx = sum(t[0] for t in tor) / len(tor)
    return "right" if ew[0] > cx else "left"

def body_box(person, t_center, fps, mc=0.3, win=0.6):
    """SWING ENVELOPE over the window: the bounding box of ALL keypoints across the whole swing — so the
    HITTING WRIST sweeping up/out (≈ the racket arc) is captured, not just the static head→feet column.
    Returns the envelope + body_h (head→feet) so the caller can add a racket-reach margin. Previously this
    measured only head/feet/center → the racket (which reaches ~half a body beyond the wrist, above the
    head and out to the side) fell OUTSIDE the cell and was cut the whole time."""
    xs=[]; ys=[]; hs=[]; fe=[]
    for f in person["frames"]:
        if abs(f["t"]-t_center)>win: continue
        kp=f["kp"]
        for k in kp:
            if k[2]>=mc: xs.append(k[0]); ys.append(k[1])          # every confident joint (incl. wrists = racket hand)
        head=[kp[JI[n]][1] for n in HEAD if kp[JI[n]][2]>=mc]
        ank=[kp[JI[n]][1] for n in ANK if kp[JI[n]][2]>=mc]
        if head: hs.append(min(head))
        if ank: fe.append(max(ank))
    if not xs or not hs or not fe: return None
    xs.sort(); ys.sort()
    def pct(a,p): return a[min(len(a)-1,max(0,int(p*len(a))))]
    xmin=pct(xs,0.02); xmax=pct(xs,0.98); ymin=pct(ys,0.02); ymax=pct(ys,0.98)  # trim stray misdetections
    head_top=min(hs); feet=max(fe)
    return {"xmin":xmin,"xmax":xmax,"ymin":ymin,"ymax":ymax,
            "cx":(xmin+xmax)/2,"cy":(ymin+ymax)/2,
            "head_top":head_top,"feet":feet,"body_h":max(1.0,feet-head_top)}

def _min_body_frac(person, kp, window, mc=0.3, effector=None):
    """The MINIMUM on-screen body fraction this cell can render = body_h / source_height (when the crop is the
    full source height). Below this the crop would exceed the frame (the line-243 clamp), so the body would be
    FORCED larger than the target. Used to COORDINATE a common body fraction across both cells (L063)."""
    cf,_=contact_frame(person,mc,window,effector)
    box=body_box(person,cf["t"],kp["video"]["fps"],mc)
    if not box: return 0.50
    SH=max(1,int(kp["video"]["height"])); return max(1.0,box["body_h"])/SH

def cell_filter(idx, kp, flip, CW, CH, mc=0.3, window=None, src=None, body_frac=0.50, effector=None):
    person=main_track(kp,mc)
    if not person: raise RuntimeError(f"no athlete track in input {idx}")
    src=src or f"{idx}:v"               # source stream label (default raw input; or a time-warped stream)
    # MIRROR is now a CALLER decision derived from the motion-match PARITY (chirality computed from the
    # footage), NOT a per-person handedness constant (the L063 fix, 2026-06-19). flip=True ⇒ this cell is
    # horizontally mirrored so the two motions travel the same way (an opposite-chirality pair); flip=False ⇒
    # truthful, un-mirrored footage. Contact timing is side-agnostic (peak over both wrists).
    cframe,_=contact_frame(person,mc,window,effector)
    box=body_box(person,cframe["t"],kp["video"]["fps"],mc)
    if not box: raise RuntimeError(f"could not measure body box in input {idx}")
    SW=int(kp["video"]["width"]); SH=int(kp["video"]["height"])
    # COVER-FILL + BODY-ANCHORED (settled style D40: landscape clips side-by-side in a vertical video). BOTH bodies
    # are shown at the SAME on-screen size (body height = BODY_FRAC of the cell) with head-top at the SAME y
    # (HEAD_FRAC down the cell) and centered horizontally — so the side-by-side comparison is aligned. We CROP a
    # cell-aspect window around the body and scale it to the cell, so the cell is FILLED edge-to-edge (NO black
    # bars; the sides are cropped — the accepted trade for landscape-in-portrait, iter39 user confirm). This
    # REPLACES the old envelope-fit+overlay-on-black, which scaled a body+racket ENVELOPE and centered it on a
    # black cell → two clips with different envelopes landed at different sizes/positions with mismatched black
    # bars (the "looks whack" bug: one body small+low with black above it, the other framed completely differently).
    body_h=max(1.0, box["body_h"]); head_top=box["head_top"]; bcx=box["cx"]
    if flip: bcx = SW - bcx                              # mirrored cell: body center flips horizontally (crop is post-hflip)
    BODY_FRAC=body_frac                                  # body fraction is CALLER-COORDINATED (same f* for both cells → SAME on-screen size)
    HEAD_FRAC=min(0.24, (1.0-BODY_FRAC)/2.0)             # 0.24 headroom normally (f*=0.50→0.24); shrinks for large f* so head+body keep the FEET in-cell (feet = HEAD_FRAC+f* ≤ 1)
    crop_h = body_h / BODY_FRAC
    crop_w = crop_h * CW / CH                            # CELL ASPECT → scales to the cell with NO letterbox
    crop_x = bcx - crop_w/2.0                            # center the body horizontally
    crop_y = head_top - HEAD_FRAC*crop_h                 # head-top lands HEAD_FRAC down the cell
    crop_w=min(crop_w,float(SW)); crop_h=min(crop_h,float(SH))            # cover-fill cannot exceed the source frame
    crop_x=max(0.0,min(crop_x,SW-crop_w)); crop_y=max(0.0,min(crop_y,SH-crop_h))   # keep the crop inside the frame
    cw=int(crop_w)-(int(crop_w)%2); ch=int(crop_h)-(int(crop_h)%2)        # even dims (H.264)
    cx0=int(round(crop_x)); cy0=int(round(crop_y))
    pre = "hflip," if flip else ""
    # crop the body-anchored cell-aspect window, scale to the cell → FILLED, aligned, same body size. No black bg.
    f=f"[{src}]{pre}crop={cw}:{ch}:{cx0}:{cy0},scale={CW}:{CH},setsar=1,format=yuv420p[c{idx}]"
    return f, cframe["t"], flip

def main()->int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--a-video",required=True); ap.add_argument("--a-kp",required=True)
    ap.add_argument("--b-video",required=True); ap.add_argument("--b-kp",required=True)
    ap.add_argument("--out",required=True)
    # CHIRALITY: 'reflected' ⇒ the two motions are mirror images (opposite chirality) ⇒ mirror the STUDENT cell
    # (b) so both travel the same way for comparison; 'direct' ⇒ no mirror. DERIVED from the motion match
    # (select_partner emits parity from the footage), NEVER a per-person handedness label (L063). The reference
    # cell (a) is ALWAYS shown truthfully, un-mirrored.
    ap.add_argument("--parity",default="direct",choices=["direct","reflected"])
    ap.add_argument("--face",default="auto",choices=["auto","left","right"],
                    help="output facing (Person One 2026-06-23): auto=truthful reference + parity-mirrored subject "
                         "(default, byte-identical); left/right=force the WHOLE comparison to face that way (a lefty "
                         "vs righty student sees it their way) by mirroring BOTH cells together when the reference's "
                         "natural facing differs — preserving the player-to-player parity alignment")
    ap.add_argument("--label-a",default=""); ap.add_argument("--label-b",default="")
    ap.add_argument("--preroll",type=float,default=1.0); ap.add_argument("--duration",type=float,default=2.4)
    ap.add_argument("--cell-w",type=int,default=960); ap.add_argument("--cell-h",type=int,default=1080)
    ap.add_argument("--font",default=None)
    ap.add_argument("--no-phase-warp",action="store_true",help="disable phase time-warp (fall back to single-anchor contact seek)")
    ap.add_argument("--warp-mode",default="dtw",choices=["dtw","anchors","none"],
                    help="dtw=frame-accurate DTW sync of the FULL pose trajectory (default, Person One 2026-06-23 — "
                         "every phase stays in sync, not just contact); anchors=3-anchor (takeback/contact/follow) "
                         "piecewise setpts; none=legacy contact seek. --no-phase-warp forces none.")
    ap.add_argument("--contact-frac",type=float,default=0.45,help="output fraction at which contact lands (takeback=0, follow-end=1)")
    # OPTIONAL matched-window constraint "t0,t1" per side: restrict contact detection to the swing the
    # matcher chose (default unset → search the whole clip, i.e. IDENTICAL to prior behavior — additive, no regression).
    ap.add_argument("--a-window",default=None); ap.add_argument("--b-window",default=None)
    # VERIFIED contact instants (clip seconds), DTW mode only. Override the pose-only contact landmark with the
    # true ball-strike (reference = YOLO ball-trajectory reversal; subject = pose-transferred + eye-confirmed).
    # None → fall back to the horizontal-arm-extension landmark (generic default). contact-frac None → tempo
    # follows the real stroke proportion (pass pre/post-matched windows so the follow halves align comparably).
    ap.add_argument("--a-contact",type=float,default=None); ap.add_argument("--b-contact",type=float,default=None)
    # MULTI-ANCHOR (DTW mode): comma-separated INTERIOR swing-event times per side (clip seconds), e.g. the
    # takeback-onset AND the contact: "699.20,700.233". Each named event is forced to coincide in the output so
    # the WHOLE stroke is locked (not just contact) — fixes the lead-in "your cell starts late then catches up"
    # artifact. Overrides --a-contact/--b-contact when given. Must have equal counts on both sides.
    ap.add_argument("--a-anchors",default=None); ap.add_argument("--b-anchors",default=None)
    # SALIENT EFFECTOR pair (JSON list, e.g. '["r_ankle","l_ankle"]' for footwork): which joint's strike the
    # side-by-side SYNC anchors on. Omitted = the tennis wrist pair (BYTE-IDENTICAL). DATA, from the domain's
    # ProductionConfig.salience threaded through build_ig_video (iter48) — same salient joints the matcher used.
    ap.add_argument("--salience-keypoints",default=None)
    # iter172/T1: BooleanOptionalAction so BOTH --smooth-slowmo and --no-smooth-slowmo are valid. The bare-CLI default
    # stays OFF (byte-identical for direct-CLI debug + the golden/faithfulness fixtures); the PRODUCTION default is
    # smooth, applied by build_ig_video.render_pair which always passes the config-resolved timing flags (the hero
    # render is the default at the PRODUCTION boundary — ProductionConfig.render_timing_resolved, L083). One path, no
    # fork (L030): render_pair → ProductionConfig.render_timing_args() → these flags.
    ap.add_argument("--smooth-slowmo",action=argparse.BooleanOptionalAction,default=False,
                    help="DTW warp only: convert frame-HOLDS (a faster clip's repeated frame = a freeze) into "
                         "smooth slow-motion — ramp held source-times into fractional creeps and render them with "
                         "motion-interpolated in-between frames (--interp). Anchors stay frame-exact. "
                         "Production default = ON (via render_pair); --no-smooth-slowmo for byte-identical debug.")
    ap.add_argument("--interp",type=int,default=1,
                    help="DTW warp only: motion-compensated source supersample factor for --smooth-slowmo (e.g. 3). "
                         "1 = original nearest-frame remap (byte-identical debug). Production default = 3 (via render_pair).")
    a=ap.parse_args()
    try:                                                            # fail-loud boundary (−1000 IQ proof, L083):
        raw = json.loads(a.salience_keypoints) if a.salience_keypoints else None
    except json.JSONDecodeError as e:
        raise SystemExit(f"[sbs2] --salience-keypoints is not valid JSON: {e}")
    try:
        effector = _norm_effector(raw)                              # None → wrists (byte-identical); else validated 2-pair
    except ValueError as e:
        raise SystemExit(f"[sbs2] {e}")
    aw = parse_window(a.a_window); bw = parse_window(a.b_window)   # iter96/B2: the module-level SSOT fail-closed parser
    for _nm, _v in (("--a-contact", a.a_contact), ("--b-contact", a.b_contact)):  # capstone-16 #2: type=float ACCEPTS
        if _v is not None and not math.isfinite(_v):              # "nan"/"inf" (numeric!) → a non-finite contact anchor
            raise SystemExit(f"[sbs2] {_nm}={_v!r} must be a FINITE clip-second — a NaN/Inf contact instant would "
                             f"poison the DTW anchor map; present-but-malformed fails closed, never a silent whole-clip seek")
    ka=canonicalize_pose_track(json.loads(Path(a.a_kp).read_text())); kb=canonicalize_pose_track(json.loads(Path(a.b_kp).read_text()))  # #198.5 (capstone-13 #4): a NaN render keypoint -> absent before crop/body-box/DTW/render geometry
    CW,CH=a.cell_w,a.cell_h; OUT=a.duration; PC=max(0.1,min(0.8,a.contact_frac))
    pa=main_track(ka); pb=main_track(kb)
    # COORDINATED BODY SIZE (L063): both cells render the body at the SAME fraction f* of the cell, so the
    # side-by-side comparison is size-fair for ANY upload. f* = max(0.50 default, each cell's MIN achievable
    # fraction body_h/SH). If one source frames the body large (>50% of its height), its crop would clamp and
    # force it bigger than 0.50 (the old per-cell bug: student 0.50 vs a clamped-bigger reference); coordinating
    # makes the OTHER cell crop tighter to the SAME f* → equal on-screen size. NO upper cap (equality is the
    # primary invariant; a cap would re-break it for >cap bodies) — cell_filter keeps the body fully in-cell by
    # shrinking HEAD_FRAC as f* grows. Byte-identical (f*=0.50) whenever neither body exceeds half its source height.
    body_frac=max(0.50, _min_body_frac(pa,ka,aw,effector=effector), _min_body_frac(pb,kb,bw,effector=effector))
    # MIRROR DECISION (chirality, DERIVED — the L063 fix): reference cell a is NEVER flipped (shown truthfully);
    # student cell b is flipped iff the motion-match parity is 'reflected' (the two motions are opposite
    # chirality, e.g. a left-mover vs a right-mover) so both travel the same way for the comparison. No
    # handedness label, no per-clip pose guess, no random mirror — the decision comes from the match itself.
    # FACING (Person One 2026-06-23): auto = truthful reference + parity-mirrored subject (byte-identical). left/right =
    # force the WHOLE comparison to face that way (a lefty vs righty student sees it their way) by mirroring BOTH
    # cells together when the reference's natural facing differs — which PRESERVES the player-to-player parity
    # alignment (flip_a and flip_b toggle in lockstep). Facing is DERIVED from motion (_facing), never a handedness label.
    if a.face == "auto":
        flip_a = False; flip_b = (a.parity == "reflected")
    else:
        ref_face = _facing(pa, aw, effector)
        gmirror = (ref_face is not None and a.face != ref_face)   # mirror everything iff the reference faces the other way
        if ref_face is None:
            log(f"⚠ --face {a.face}: reference facing unobservable → no global mirror (auto behavior, fail-safe)")
        flip_a = gmirror
        flip_b = (a.parity == "reflected") ^ gmirror
        log(f"FACE={a.face} ref_face={ref_face} global_mirror={gmirror} → flip_a={flip_a} flip_b={flip_b}")
    font=a.font or find_font()
    def lbl(cell,label):
        if not label or not font: return f"[{cell}]null[{cell}o]"
        t=label.replace(":","\\:").replace("'","")
        return (f"[{cell}]drawtext=fontfile='{font}':text='{t}':x=(w-text_w)/2:y=h-80:"
                f"fontsize=46:fontcolor=white:borderw=2:bordercolor=black@0.6[{cell}o]")

    _mode = "none" if a.no_phase_warp else a.warp_mode
    if _mode == "none":
        # LEGACY single-anchor: seek each clip to contact-preroll, play at native rate (drifts across tempos).
        fa,ca,_=cell_filter(0,ka,flip_a,CW,CH,window=aw,body_frac=body_frac,effector=effector)
        fb,cb,_=cell_filter(1,kb,flip_b,CW,CH,window=bw,body_frac=body_frac,effector=effector)
        ssa=max(0.0,round(ca-a.preroll,3)); ssb=max(0.0,round(cb-a.preroll,3))
        fc=f"{fa};{fb};{lbl('c0',a.label_a)};{lbl('c1',a.label_b)};[c0o][c1o]hstack=2[v]".replace("{DUR}",f"{OUT}")
        cmd=["ffmpeg","-nostdin","-y","-ss",str(ssa),"-t",str(OUT),"-i",a.a_video,
             "-ss",str(ssb),"-t",str(OUT),"-i",a.b_video,
             "-filter_complex",fc,"-map","[v]","-t",str(OUT),"-r","30",
             "-c:v","libx264","-crf","18","-preset","veryfast","-pix_fmt","yuv420p",a.out,"-loglevel","error"]
        log(f"LEGACY seek a={ssa}s b={ssb}s (no phase warp)")
    elif _mode == "anchors":
        # PHASE TIME-WARP (3-anchor): map each clip's (takeback, contact, follow-end) onto a COMMON output timeline so
        # prep/contact/follow stay aligned across different swing tempos (fixes mid-swing drift). Two linear
        # segments (takeback→contact, contact→follow-end) via trim+setpts+concat; contact lands at PC*OUT.
        def warp(idx, person, window):
            tb,c,fe=swing_keyframes(person,window,effector=effector)   # chirality-free phase anchors on the salient effector (timing)
            ce=max(c,tb+0.05); fee=max(fe,ce+0.05)           # 0.05s span floor: guarantees d1,d2>0 (no zero-length trim,
            d1=ce-tb; d2=fee-ce                              # no div-by-zero) even for a degenerate anchor (tb==c / c==fe).
            # EXACT phase scale — NO speed clamp. The invariant is "contact lands at PC*OUT in EVERY cell": segment A
            # (takeback→contact) MUST occupy exactly PC*OUT, segment B exactly (1-PC)*OUT, whatever the swing's tempo.
            # The old max(0.25,min(4.0,..)) clamp BROKE this: a shallow/fast reference swing (d1<0.27s → raw s1>4.0) was
            # clamped to 4.0, so its takeback rendered SHORTER than PC*OUT and its contact landed BEFORE the student's
            # ("the reference player hits before I hit"; the cell also ended early → output 2.23s<2.40s). Removing the clamp makes
            # cross-tempo desync STRUCTURALLY IMPOSSIBLE (L063). Extreme stretch happens only on degenerate input the
            # upstream swing gates already reject; aligned-but-steppy >> smooth-but-desynced.
            s1=(PC*OUT)/d1; s2=((1-PC)*OUT)/d2
            f=(f"[{idx}:v]trim=start={tb:.3f}:end={ce:.3f},setpts=(PTS-STARTPTS)*{s1:.4f}[p{idx}a];"
               f"[{idx}:v]trim=start={ce:.3f}:end={fee:.3f},setpts=(PTS-STARTPTS)*{s2:.4f}[p{idx}b];"
               f"[p{idx}a][p{idx}b]concat=n=2:v=1[w{idx}]")
            return f,(tb,c,fe)
        wa,ka_key=warp(0,pa,aw); wb,kb_key=warp(1,pb,bw)
        fa,_,_=cell_filter(0,ka,flip_a,CW,CH,window=aw,src="w0",body_frac=body_frac,effector=effector)
        fb,_,_=cell_filter(1,kb,flip_b,CW,CH,window=bw,src="w1",body_frac=body_frac,effector=effector)
        fc=f"{wa};{wb};{fa};{fb};{lbl('c0',a.label_a)};{lbl('c1',a.label_b)};[c0o][c1o]hstack=2[v]".replace("{DUR}",f"{OUT}")
        cmd=["ffmpeg","-nostdin","-y","-i",a.a_video,"-i",a.b_video,
             "-filter_complex",fc,"-map","[v]","-t",str(OUT),"-r","30",
             "-c:v","libx264","-crf","18","-preset","veryfast","-pix_fmt","yuv420p",a.out,"-loglevel","error"]
        log(f"PHASE-WARP a keyframes(tb,c,fe)={ka_key} b={kb_key} contact@{PC:.2f} | parity={a.parity} flip_b={flip_b}")
    else:  # dtw (default) — FRAME-ACCURATE sync of the FULL pose trajectory (Person One 2026-06-23)
        # Align the two pose trajectories with Dynamic Time Warping so EVERY phase stays in sync (not just a
        # single contact anchor — the 'anchors' mode forced only 3 points to coincide and drifted between them,
        # the "I get to the ball quicker than he does" desync). Then show, per output frame k, the DTW-
        # corresponding SOURCE frame of each clip via a per-clip frame REMAP (an arbitrary per-frame mapping
        # cannot be a single setpts expression). Crop/scale is the SAME cell_filter cover-fill as every mode;
        # only WHICH source frame plays WHEN changes — so the plan/keypoints/windows/parity are untouched and
        # check_video C1-C12 are unaffected.
        import dtw_align
        OUT_FPS = 30
        N = max(2, int(round(OUT * OUT_FPS)))
        faw = dtw_align._win_frames(pa, aw); fbw = dtw_align._win_frames(pb, bw)   # the SAME frames DTW aligns on
        t0a, t1a = float(faw[0]["t"]), float(faw[-1]["t"])
        t0b, t1b = float(fbw[0]["t"]), float(fbw[-1]["t"])
        fps_a = float(ka["video"].get("fps") or 30) or 30.0
        fps_b = float(kb["video"].get("fps") or 30) or 30.0
        def _anchlist(s):
            if not s: return None
            try: return [float(x) for x in s.split(",") if x.strip()]
            except ValueError as e: raise SystemExit(f"[sbs2] bad anchors '{s}': {e}")
        anch_a = _anchlist(a.a_anchors); anch_b = _anchlist(a.b_anchors)
        if (anch_a is None) != (anch_b is None) or (anch_a and anch_b and len(anch_a) != len(anch_b)):
            raise SystemExit("[sbs2] --a-anchors/--b-anchors must both be set with EQUAL counts")
        have_contacts = (a.a_contact is not None and a.b_contact is not None) or bool(anch_a)
        ts_a, ts_b = dtw_align.dtw_frame_map(                                       # corresponding SOURCE times
            pa, pb, aw, bw, a.parity, effector, N,
            contact_frac=(None if have_contacts else PC),                          # verified → real-proportion tempo
            contact_ref_t=a.a_contact, contact_subj_t=a.b_contact,
            anchors_ref=anch_a, anchors_subj=anch_b, smooth_slowmo=a.smooth_slowmo)
        interp = max(1, int(a.interp))
        if a.smooth_slowmo and interp == 1: interp = 3                         # smooth-slowmo needs in-between frames
        wk = Path(a.out).parent / "_dtw"
        if wk.exists(): shutil.rmtree(wk)
        pat_a = _dump_and_reindex(a.a_video, t0a, t1a, fps_a, ts_a, wk, "a", interp)   # cell A (left)  = reference
        pat_b = _dump_and_reindex(a.b_video, t0b, t1b, fps_b, ts_b, wk, "b", interp)   # cell B (right) = subject
        fa,_,_=cell_filter(0,ka,flip_a,CW,CH,window=aw,src="0:v",body_frac=body_frac,effector=effector)
        fb,_,_=cell_filter(1,kb,flip_b,CW,CH,window=bw,src="1:v",body_frac=body_frac,effector=effector)
        fc=f"{fa};{fb};{lbl('c0',a.label_a)};{lbl('c1',a.label_b)};[c0o][c1o]hstack=2[v]"
        cmd=["ffmpeg","-nostdin","-y","-framerate",str(OUT_FPS),"-i",pat_a,"-framerate",str(OUT_FPS),"-i",pat_b,
             "-filter_complex",fc,"-map","[v]","-t",str(OUT),"-r",str(OUT_FPS),
             "-c:v","libx264","-crf","18","-preset","veryfast","-pix_fmt","yuv420p",a.out,"-loglevel","error"]
        log(f"DTW-SYNC N={N} a[{t0a:.2f},{t1a:.2f}]@{fps_a:.0f}fps b[{t0b:.2f},{t1b:.2f}]@{fps_b:.0f}fps | parity={a.parity} flip_b={flip_b}")
    r=subprocess.run(cmd)
    if r.returncode!=0: log("ffmpeg failed"); return r.returncode
    log(f"wrote {a.out}")
    return 0

if __name__=="__main__": raise SystemExit(main())

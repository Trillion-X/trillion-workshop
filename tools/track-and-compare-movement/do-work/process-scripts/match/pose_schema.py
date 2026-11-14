#!/usr/bin/env python3
# tools/match/pose_schema.py
#
# CANONICAL pose-keypoint schema — the SINGLE SOURCE OF TRUTH for the keypoint representation the whole
# matcher + render pipeline uses (iter67, Codex-converged).
#
# WHY THIS EXISTS (L063 category fix + SSOT): before this module, the identical `COCO=[...]` keypoint list and
# `JI={n:i...}` index were copy-pasted in EIGHT files (motion_certify, describe_clip, motion_geometry,
# swing_state, tcc_encoder, render_side_by_side_v2, detect_phases, render_pose_overlay) — a Single-Source-of-
# Truth violation; and the certified comparison-channel set (MOVE_KP) + its mirror map were hard-coded INSIDE
# the certified core (motion_certify) — a closed-enum / hard-coded-representation violation a domain could
# extend. The Holy-Trinity convergence (Codex gpt-5.5, iter67) verdict: MOVE_KP = VIOLATION-MUST-FIX, and the
# duplicated COCO schema is the broader representation floor. Fix: ONE canonical schema, imported everywhere,
# with the certified comparison representation expressed as DATA (ComparisonSpec) injected into the core.
#
# PHYSICS vs SOCIETY: keypoint NAMES, mirror pairs, and channel groups are the representation a pose ESTIMATOR
# produces — DATA (configurable per estimator/domain), not engine Physics. The default below is COCO-17 (what
# tools/motion/pose_estimate.py emits). SCOPE HONESTY (D74/iter67, Codex-converged): making this the SSOT +
# DATA is NECESSARY-but-NOT-SUFFICIENT for "any motion domain" — the pose estimator itself is the deeper floor
# (it only emits COCO-17 human keypoints). This removes the duplicated + hard-coded representation from the
# matcher; it does not by itself let the system match non-human motion (that needs a different estimator whose
# schema would be swapped HERE, in one place).
from __future__ import annotations

import math

# ── COCO-17 keypoint schema (the default human-pose representation) ──────────────────────────────────────────
COCO = ["nose", "l_eye", "r_eye", "l_ear", "r_ear", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow",
        "l_wrist", "r_wrist", "l_hip", "r_hip", "l_knee", "r_knee", "l_ankle", "r_ankle"]
JI = {n: i for i, n in enumerate(COCO)}

# ── Certified comparison channels (the limb+trunk that carry motion; face excluded — eyes/ears/nose add noise,
#    not motion signal). ORDER IS MATRIX-SIGNIFICANT: the frozen S1 all-pairs matrix indexes channels by this
#    order; never sort it. (This was motion_certify.MOVE_KP.) ──────────────────────────────────────────────────
MOVE_KP = ["l_shoulder", "r_shoulder", "l_elbow", "r_elbow", "l_wrist", "r_wrist", "l_hip", "r_hip",
           "l_knee", "r_knee", "l_ankle", "r_ankle"]
# Left<->right mirror pairs for the chirality (parity) test. (This was motion_certify.MIRROR.)
MIRROR = {"l_shoulder": "r_shoulder", "r_shoulder": "l_shoulder", "l_elbow": "r_elbow", "r_elbow": "l_elbow",
          "l_wrist": "r_wrist", "r_wrist": "l_wrist", "l_hip": "r_hip", "r_hip": "l_hip", "l_knee": "r_knee",
          "r_knee": "l_knee", "l_ankle": "r_ankle", "r_ankle": "l_ankle"}

# Proximal→distal kinematic chains per limb type — the COCO skeleton's limb STRUCTURE (which joints form a
# limb), used to gate a window's admission on the WHOLE limb's keypoint confidence (not just the effector).
# This is skeleton topology (Physics of the keypoint schema, NOT tennis Society); it lives here with COCO/MIRROR
# as canonical SSOT (was a local `_LIMB_CHAIN` dict in describe_clip, iter70). A different pose schema defines
# its own limb chains here; consumers read this, never a local copy.
LIMB_CHAINS = {"wrist": ("shoulder", "elbow", "wrist"), "ankle": ("hip", "knee", "ankle")}

# Skeleton DRAW topology — which joint pairs form a visible bone when rendering a pose. Same rationale as
# LIMB_CHAINS: this is Physics of the keypoint schema (the COCO skeleton's bone structure), NOT Society. It is the
# ONE source every skeleton renderer reads (the live canvas overlay AND the freeze-card image) so the bones can
# never disagree between surfaces; a different pose schema defines its own bones here. Named pairs (schema-portable);
# EDGES gives the index pairs renderers actually use. Face joints (eyes/ears) are intentionally not drawn — the
# limbs + trunk + a neck stub carry the readable shape.
EDGE_NAMES = [
    ("l_shoulder", "l_elbow"), ("l_elbow", "l_wrist"), ("r_shoulder", "r_elbow"), ("r_elbow", "r_wrist"),
    ("l_shoulder", "r_shoulder"), ("l_hip", "r_hip"), ("l_shoulder", "l_hip"), ("r_shoulder", "r_hip"),
    ("l_hip", "l_knee"), ("l_knee", "l_ankle"), ("r_hip", "r_knee"), ("r_knee", "r_ankle"),
    ("nose", "l_shoulder"), ("nose", "r_shoulder"),
]
EDGES = [(JI[a], JI[b]) for a, b in EDGE_NAMES]   # index pairs for renderers (COCO-17 order)

# The DEFAULT salient EFFECTOR — the joint pair whose speed defines "the motion event" when a domain configures
# none. The wrists (hands) are the most common effector across human motion (swinging, throwing, reaching,
# gesturing, cooking, most sports), so they are the maximally-capable -1000IQ default (L083), NOT tennis Society:
# any domain overrides per-config via salience_keypoints (footwork → ankles). It is ONE SSOT here in the shared
# pose-vocabulary LEAF (the home of COCO/JI/MOVE_KP/MIRROR/LIMB_CHAINS) because the matcher/analysis leaves
# (motion_certify, describe_clip, render_side_by_side_v2) all import pose_schema and must NOT depend on the Society
# config layer (ProductionConfig) — that would invert the dependency direction. Was 5 scattered ("l_wrist","r_wrist")
# / ("r_wrist","l_wrist") literals across those 3 files (iter92, Codex iter89 B3). ORDER is irrelevant downstream:
# every consumer reduces the pair by max (contact-clamp speed, salience_series) or side-match (render _eff).
DEFAULT_EFFECTOR = ("l_wrist", "r_wrist")


class ComparisonSpec:
    """The COMPLETE certified-comparison as DATA (iter67 channels + mirror; iter68 dist-calibration; iter81 live
    admission bars): which channels are compared, their left/right mirror map, the observability gate
    (`min_reliable` = how many channels must be reliably observed to certify), the certification bar (`epsilon`),
    AND the live admission bars select_partner applies (`cert_admit`/`cert_same`/`ambig_margin`). This is the
    INJECTED capability the certified core (motion_certify) + the live selector (select_partner) consume — a
    different pose domain passes its own spec WITHOUT editing either (enum-dissolution: the extensible list AND its
    COMPLETE calibration are PARAMETERS, not core-owned constants).
    `mirror_idx[i]` is the channel index that channel i maps to under a horizontal flip; it is precomputed to be
    byte-identical to the old `MOVE_KP.index(MIRROR[name])` lookup. Fail-closed: a duplicate channel or a mirror
    target outside `channels` raises (a typo must never silently mis-mirror). `min_reliable` MUST be <= the
    channel count to be satisfiable — a smaller-channel domain sets a smaller gate (iter67 L069 probe found the
    old hard-coded 8 made any <8-channel spec un-certifiable).
    D90 (iter80) PROVED the admission bars are channel-set-CALIBRATED, not universal: the certified veto = the MAX
    divergence over the DISCRIMINATING observed channels, so dropping channels lowers that max and the SAME 0.22
    admits wrong matches (12-channel→0 wrong, 10ch→2, 8ch→10 on the frozen Reference Player confusables). THEREFORE the
    bars MUST travel with the channels — a domain that swaps channels re-calibrates these bars AND re-validates
    0-wrong on its OWN confusable data (a per-spec DATA gate, parallel to the recall gate D12; NOT code-derivable)."""
    __slots__ = ("channels", "mirror", "mirror_idx", "min_reliable", "epsilon",
                 "cert_admit", "cert_same", "ambig_margin")

    def __init__(self, channels, mirror, min_reliable=8, epsilon=0.55,
                 cert_admit=0.22, cert_same=0.30, ambig_margin=0.05):
        # FAIL-CLOSED on TYPES (iter136 / Codex iter135 — the iter133 char-split + iter134 value-type categories applied
        # to the S1-CRITICAL certified-comparison config, at the constructor chokepoint so from_dict + direct + DEFAULT
        # all gate). list("abc")==['a','b','c'] would char-split a bare-string channel set; float("0.9")/float(True) would
        # silently accept a mistyped admission bar that LOOSENS live safety (a wrong-match hole). The D90 0-wrong
        # re-validation is a CONVENTION (docstring), not structural — this is the structural gate that makes it impossible.
        if isinstance(channels, (str, bytes)) or not isinstance(channels, (list, tuple)) or not channels \
           or not all(isinstance(c, str) and c for c in channels):
            raise ValueError(f"ComparisonSpec.channels must be a non-empty list of non-empty channel-name strings, "
                             f"got {type(channels).__name__} {channels!r} (a bare string would char-split)")
        if not isinstance(mirror, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in mirror.items()):
            raise ValueError(f"ComparisonSpec.mirror must be a dict of channel-name strings, got {type(mirror).__name__}")
        if isinstance(min_reliable, bool) or not isinstance(min_reliable, int) or min_reliable <= 0:
            raise ValueError(f"ComparisonSpec.min_reliable must be a positive int, got "
                             f"{type(min_reliable).__name__} {min_reliable!r}")
        # NOTE (iter136): we do NOT reject min_reliable > len(channels) here. An over-large gate is UNSATISFIABLE →
        # certified() can never observe enough reliable channels → no certification → no_match. That is FAIL-CLOSED
        # (refuse), not a fail-open, and from_dict is deliberately schema-agnostic (parses ANY channel set; bad channel
        # NAMES fail closed downstream at the keypoint lookup). The satisfiability bound is the domain author's
        # responsibility (documented in the class docstring + caught by the mandatory per-spec 0-recall re-validation).
        # capstone-9 #1 (SAFETY): a TYPE check is not enough — float('nan')/float('inf') are floats that PASS
        # isinstance but DEFEAT every gate comparison: `worst <= cert_admit` is True for cert_admit=inf (admit ANY
        # match), and `x < cert_same`/`< ambig_margin` is False for NaN (the refuse-gates never fire). The S1
        # 0-wrong guarantee silently dies. Require FINITE in addition to numeric-non-bool, at the constructor
        # chokepoint so from_dict + direct + DEFAULT all gate.
        for _bn, _bv in (("epsilon", epsilon), ("cert_admit", cert_admit), ("cert_same", cert_same), ("ambig_margin", ambig_margin)):
            if isinstance(_bv, bool) or not isinstance(_bv, (int, float)) or not math.isfinite(_bv):
                raise ValueError(f"ComparisonSpec.{_bn} must be a FINITE number (a JSON string/bool mis-bars the gate; "
                                 f"NaN/Infinity silently disables it — admit-any or never-refuse), "
                                 f"got {type(_bv).__name__} {_bv!r}")
        self.channels = list(channels)
        self.mirror = dict(mirror)
        self.min_reliable = int(min_reliable)   # observability gate (was motion_certify.MIN_RELIABLE)
        self.epsilon = float(epsilon)           # per-channel certification bar (was motion_certify.EPSILON)
        # iter81 (L069 completeness — D90): the LIVE admission calibration select_partner applies, now carried WITH
        # the channels it calibrates. iter68 moved min_reliable+epsilon (the certified() test bars) here but LEFT
        # these three live bars in select_partner OUTSIDE the spec, so swapping channels did NOT bring the
        # calibration with it. Closed now. Defaults 0.22/0.30/0.05 == the byte-identical tennis live bars; a
        # non-default channel set passes its OWN re-calibrated bars (see the class-level D90 note).
        self.cert_admit = float(cert_admit)     # CERTIFIED admission ε: worst reliable channel ≤ this ⇒ admit
        self.cert_same = float(cert_same)       # ε_same: two refs self-certify below this ⇒ "same motion" (ambiguity gate)
        self.ambig_margin = float(ambig_margin) # refuse if a DIFFERENT motion is within this of the best (fail-closed)
        pos = {n: i for i, n in enumerate(self.channels)}
        if len(pos) != len(self.channels):
            raise ValueError("ComparisonSpec: duplicate channel name")
        idx = []
        for n in self.channels:
            mn = self.mirror.get(n, n)            # unmapped channel mirrors to itself
            if mn not in pos:
                raise ValueError(f"ComparisonSpec: mirror target {mn!r} not among channels")
            idx.append(pos[mn])
        self.mirror_idx = idx

    @classmethod
    def from_dict(cls, d):
        """Build a ComparisonSpec from a self-describing dict, letting the CONSTRUCTOR own EVERY default — the ONE
        canonical dict→spec parser (iter82, Codex-found CSSOT fix). Before this, FOUR sites (check_video
        _pair_comparison_spec, production_config.comparison_spec_obj, select_partner CLI, index_confusion --spec)
        each re-specified default literals via `d.get('cert_admit', 0.22)` etc. — duplicated defaults that could
        diverge from the constructor (a 5th source), and check_video's copy DROPPED the bars entirely (egress
        re-cert silently fell back to 0.22 even for a re-calibrated spec — the iter68 mistake repeating at the
        builder). Here only KEYS PRESENT in the dict are passed; every omitted key falls through to the SINGLE
        constructor default. 'channels' is the only required key. Changing a default in __init__ now changes it
        for every parse site automatically (the CSSOT test: change it in one place, everywhere sees it).
        iter84 (L063/L091 — structurally eliminate the iter82 drop-bug CLASS): the optional-key set is DERIVED
        from __init__'s signature by introspection, NOT a hardcoded list. So ADDING a calibration field to
        __init__ is AUTOMATICALLY carried here — a future field can never be silently dropped by a stale list
        (which is exactly how the iter82 bug arose). This brings ComparisonSpec to parity with the @dataclass
        deserializers (ProductionConfig.load, salience_config_from_dict), which already derive their key set from
        `fields(cls)`; ComparisonSpec is a __slots__ class (computed mirror_idx + validation) so it can't use
        dataclasses.replace, but signature introspection gives the same structural guarantee."""
        import inspect
        optional = [p for p in inspect.signature(cls.__init__).parameters if p not in ("self", "channels", "mirror")]
        kw = {k: d[k] for k in optional if k in d}
        return cls(d["channels"], d.get("mirror", {}), **kw)


# The default certified comparison: COCO limb+trunk, min_reliable=8, epsilon=0.55 — byte-identical to the
# pre-iter67/68 hard-coded MOVE_KP / MIRROR / MIN_RELIABLE / EPSILON.
DEFAULT_COMPARISON_SPEC = ComparisonSpec(MOVE_KP, MIRROR, min_reliable=8, epsilon=0.55)


# ─────────────────────────────────────────────────────────────────────────────────────────────────────
# #198.2 — UNIVERSAL KEYPOINT CANONICALIZER (the SSOT, moved here from segment_moment per Codex #2).
#
# A keypoint LIST value is canonicalized to [x, y, conf], FAIL-CLOSED to the ABSENT point [0,0,0] on anything
# malformed/non-finite. The deepest root (#198): a NaN/Inf keypoint read straight from a `.kp.json` cache flows
# into the certified descriptor math (motion_certify._skel indexes kp[JI[n]] -> p[0]/p[1]/p[2]) and FABRICATES a
# NaN comparison value that defeats the worst-channel admission gate (capstone-11 #7 SAFETY-CRITICAL). The
# DESCRIPTOR boundary (#198.1) cannot catch this because descriptor_at builds the descriptor LIVE in-memory,
# never through a finite_json write. So keypoints are canonicalized at INGESTION instead.
#
# SEMANTIC (Codex #9 — keypoints differ from descriptors): per-KEYPOINT absence, NOT whole-file reject. A single
# NaN keypoint in one frame must NOT reject the whole clip — it becomes [0,0,0] with conf 0.0, which every
# downstream consumer already EXCLUDES via its `conf >= MC` gate (main_track, _skel._torso, salience). On a real
# 3-element finite keypoint, kp3 returns [float(x),float(y),float(conf)] — byte-identical, so the frozen S1
# certified matrix is unchanged.

def kp3(v):
    """Canonicalize a single keypoint value to [x, y, conf]; degenerate/non-finite -> [0,0,0] absent (conf 0).
    A 2-element [x,y] carries an implicit confidence of 1.0 (the coco_to_named / motion_score / lesson_pipeline
    convention). The SINGLE definition (was segment_moment._kp3) — moved to the pose-schema data-loading layer so
    every `.kp.json` reader canonicalizes through ONE place (L063/SSOT)."""
    def _num(z):
        return isinstance(z, (int, float)) and not isinstance(z, bool) and math.isfinite(z)
    if v is None:
        return [0.0, 0.0, 0.0]
    try:
        lv = list(v)
    except TypeError:
        return [0.0, 0.0, 0.0]                              # scalar / non-iterable -> absent (fail-closed)
    if len(lv) < 2 or not _num(lv[0]) or not _num(lv[1]):
        return [0.0, 0.0, 0.0]                              # missing or non-finite x/y -> absent
    if len(lv) >= 3:
        return [float(lv[0]), float(lv[1]), float(lv[2])] if _num(lv[2]) else [0.0, 0.0, 0.0]
    return [float(lv[0]), float(lv[1]), 1.0]                # 2-element [x,y] -> implicit confidence 1.0


def _canon_frames(frames):
    for fr in frames or []:
        if isinstance(fr, dict) and isinstance(fr.get("kp"), list):
            fr["kp"] = [kp3(k) for k in fr["kp"]]


def canonicalize_pose_track(obj):
    """Canonicalize EVERY keypoint in a loaded pose object through kp3, so a non-finite coordinate becomes an
    ABSENT point (conf 0) BEFORE it can reach the certified descriptor / salience / overlay math. Handles all
    three live shapes (#198.5 generalized for the pinned-ghost reference seam):
      * a full pose track:   {persons:[{frames:[{kp:[[x,y,c],...]}]}], ...}   (.kp.json readers)
      * a single person:     {frames:[{kp:[...]}]}                            (a pinned-ghost `frames` ref)
      * a single pose:       {kp:[[x,y,c],...]}                               (a pinned-ghost single-pose ref)
    Mutates `kp` lists in place and returns obj (readers own the freshly-parsed dict — in-place avoids a deep copy
    of large tracks; idempotent on already-canonical data). Non-dict -> returned unchanged. The ONLY field touched
    is `kp`; `t`, `video`, `source`, `id`, `parity`, person/frame ordering are preserved exactly (byte-identical on
    real finite data — kp3 is identity on a real 3-element finite keypoint)."""
    if not isinstance(obj, dict):
        return obj
    for person in obj.get("persons", []) or []:
        if isinstance(person, dict):
            _canon_frames(person.get("frames", []))
    _canon_frames(obj.get("frames", []))                    # a person-shaped ref (no `persons` wrapper)
    if isinstance(obj.get("kp"), list):                     # a single-pose ref
        obj["kp"] = [kp3(k) for k in obj["kp"]]
    return obj

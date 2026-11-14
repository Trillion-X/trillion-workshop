#!/usr/bin/env python3
# tools/match/gate_thresholds.py
#
# CSSOT for the CAMERA / RELIABILITY / FULL-SWING gate thresholds shared by the SELECT seam (select_partner),
# the BATCH pre-filter (produce_batch), and the EGRESS authority (check_video C4/C9/C10). Before this module
# (iter86, Codex iter85 Finding 3), these constants were duplicated as independent literals in all three files,
# "kept in sync by comment" (e.g. check_video `MIN_PLAYER=0.24  # matches produce_batch.MIN_PLAYER_SIZE`) — a
# silent-drift hazard exactly like the cert_admit duplication (iter82/84). One canonical home now; everything
# reads from here, so a change propagates and the literals can never diverge.
#
# WHY HERE (tools/match/): select_partner already lives here; check_video and produce_batch both add tools/match
# to sys.path (they import describe_clip / motion_certify), so all three consumers can import this module.
#
# PHYSICS-vs-SOCIETY note: these are camera-comparability + pose-reliability + swing-completeness floors. They
# are universal DEFAULTS (a reversed camera is reversed in any domain; an unreadably-small player is unreliable
# in any domain). They are calibrated constants, not tennis Society. If a future domain needs to tune them, they
# graduate to ProductionConfig DATA (the same path comparison_spec/salience took) — NOT today (no domain needs
# it yet; L076/L077). The point of THIS module is to kill the duplication, not to prematurely make them DATA.

# ── Camera AZIMUTH (heading) gates — degrees of phase-aligned median |Δheading| ────────────────────────────
# Three nested tiers (MET ⊆ TIER2 ⊆ ADMIT): a pair is "same camera" ≤ MET, "admissible but off-angle" ≤ TIER2,
# shippable (not reversed) ≤ ADMIT, and REJECTED above ADMIT. produce_batch's tier-1/tier-2 selection reads MET +
# TIER2 from here (iter89, completing the iter86 SSOT — they were the literals 40.0/60.0 in the tiering logic).
HEADING_ADMIT = 75.0   # > this = reversal / wrong-side → REJECT (a shipped pair must never be camera-reversed).
HEADING_TIER2_CEIL = 60.0  # ≤ this (and ≤ ADMIT) = tier-2 "admissible but different angle, not reversed" (shown only if no tier-1).
HEADING_MET   = 40.0   # ≤ this = honest "same camera angle" for the scorecard / tier-1 (40-75 is admissible but NOT "met").

# ── Pose RELIABILITY floor ─────────────────────────────────────────────────────────────────────────────────
MIN_PLAYER = 0.24      # min median player-bbox height / frame height for a RELIABLE pose (smaller → refuse).

# ── FULL-SWING (collapse / finish-only) floors — seconds of backswing(d1) AND follow(d2) per side ───────────
# TWO distinct ROLES (NOT a drift to collapse — iter86/D96, correcting Codex iter85 Finding 3's "mismatch" read):
#   EGRESS_PHASE_FLOOR = the HARD definition of "collapsed/finish-only" the shipping gate (check_video C9) enforces.
#   SELECT_ANCHOR_FLOOR = the BATCH pre-filter (produce_batch._anchor_ok), set DELIBERATELY ≥ the egress floor so a
#     staged pair clears C9 with margin (a correct pre-filter is at least as strict as the final gate). select and
#     egress compute the SAME quantity (same swing_keyframes / kp / window / effector), so SELECT ≥ EGRESS means
#     nothing select stages can fail C9 on this axis. They are intentionally different VALUES, not duplicated ones.
EGRESS_PHASE_FLOOR = 0.13
SELECT_ANCHOR_FLOOR = 0.15

# ── SELECTION / ASSEMBLY knobs (shared by BOTH drivers: produce_batch batch + match_one single-upload) ───────
# iter97 (Codex iter95 capstone B3): these were duplicated literals — produce_batch had `quality>=0.5` and `[:6]`
# inline; match_one had its own module-level MIN_QUALITY=0.5 / MAX_PAIRS=6 (with a comment admitting "this should
# live in [shared DATA]… restated here rather than duplicated-by-copy"). Same silent-drift hazard the rest of this
# module kills. ONE home now; both drivers import these. (WEIGHTS was the third duplicated literal but it is a DEAD
# positional arg to select() — see select_partner.py L26/L168 — so it was DELETED, not moved here: enshrining a dead
# value as a shared constant would be worse than the dup. Same L076/L077 graduation path to ProductionConfig applies
# if a domain ever needs to tune these per-instance — not today.)
MIN_QUALITY = 0.5      # salience floor for a candidate WINDOW to count as a real motion event (drops low-salience noise).
REFERENCE_MIN_QUALITY = 0.45  # iter125/Codex iter122 F4: the swing-quality bar for REFERENCE-pool candidates inside
#                        select_partner — INTENTIONALLY looser than MIN_QUALITY (the query-side pre-filter): a wider
#                        certified-candidate pool maximizes recall, and the 0.22 worst-channel CERT gate (not this
#                        salience floor) is the actual same-motion safety. Named here (was a magic 0.45 literal in
#                        select_partner's default + CLI) so the two quality bars live in ONE CSSOT and can't silently
#                        drift; the asymmetry is deliberate, not a bug — do NOT "fix" it to equal MIN_QUALITY (D107).
MAX_PAIRS = 6          # variety cap: max distinct side-by-side pairs assembled into the rendered band.

# ── CAPTION / TRANSCRIPT FAITHFULNESS floor (S9 "captions ARE the spoken transcript") ───────────────────────
# iter145→iter148 (Codex iter143 F2 + iter147 F2): the egress voice gate (check_video C8) + the producer (clean_clone)
# caught EMPTY transcripts (iter140) and INSERTED ref-tail leaks, but NOT a transcript that does not MATCH the intended
# narration. CAPTION_ALIGN_MIN is the minimum SYMMETRIC alignment between the expected script tokens and the spoken/ASR
# tokens: matched-in-order block mass / max(|expected|, |spoken|). Dividing by the LONGER side penalizes BOTH missing
# script words (recall — a wrong/garbage clone) AND EXTRA spoken words (precision — a 'correct script + appended
# garbage' transcript, which a recall-only ratio scored 1.0 while the garbage shipped as captions). Calibrated on the
# full live corpus (real renders have |expected|==|spoken|): REAL alignment 95.7-100%; a garbage transcript ~0%; a
# correct-script-plus-26%-appended-garbage transcript ~79.5%. 0.85 sits in the empty gap [79.5%, 95.7%] — catches
# wholesale-wrong AND meaningful appends, with ~10.7pt margin below the real minimum so normal ASR drift (±1-2 tokens,
# homophones) never false-rejects. Read by BOTH the producer (clean_clone, regenerate-on-misaligned) and the egress
# gate (check_video C8, blocks shipping) — ONE SSOT so the two can't drift.
CAPTION_ALIGN_MIN = 0.85

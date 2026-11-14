#!/usr/bin/env python3
# tools/match/match_clips.py
#
# PURPOSE: the SSOT for camera-VIEWPOINT geometry — the continuous viewpoint distance + its Euclidean embedding.
#
# iter126 (Codex iter122 F6, L030/L100): this file used to also hold a v1 weighted constraint-solver `rank()` + a
# CLI (main) + helpers (dtw, kin_dist, emb_dist, viewpoint3d_dist, windows_of). ALL were DEAD and are deleted:
#   - the LIVE selection authority is select_partner (certified worst-channel same-motion correspondence), which
#     imports ONLY `viewpoint_dist` from here; viewpoint_index imports ONLY `viewpoint_embed`. Nothing live called
#     rank/dtw/kin_dist/emb_dist/viewpoint3d_dist/windows_of/main (grep-verified across the live tree).
#   - `rank()` was also broken-by-schema-drift: it read `window["kinematics"]`, a field current describe_clip
#     descriptors no longer emit (they emit signature/state/quality).
#   - `viewpoint3d_dist` was a vestige of the REJECTED MediaPipe-3D viewpoint path (Decisions Log D1/D14).
# The file is now just the viewpoint-geometry primitive. (The certified matcher's own DTW lives in motion_certify.)
#
# Mirror-invariance: the chiral viewpoint component (ear_sign) is compared by MAGNITUDE (|ear_sign|), so a
# left-handed subject filmed from one side correctly matches a right-handed reference filmed from the other once
# ONE clip is horizontally flipped at render. Handedness is therefore a RENDER transform, NOT a match penalty.
#
#   importable: viewpoint_dist(va, vb) -> float ; viewpoint_embed(v) -> [4 floats]  (L2(embed_a, embed_b) == viewpoint_dist)

from __future__ import annotations
import math

VIEWPOINT_SC = (2.0, 1.0, 2.0, 1.0)  # rough per-feature spans -> comparable contribution (SSOT for viewpoint geometry)

def viewpoint_embed(v):
    """The viewpoint vec mapped into a EUCLIDEAN space where plain L2 distance EQUALS viewpoint_dist — the SSOT
    for the viewpoint geometry. [sideness, face_vis, leg_torso] are divided by their spans; the CHIRAL ear_sign
    maps to |ear_sign| so the min-over-mirror term (min((a-b)^2,(a+b)^2) == (|a|-|b|)^2) becomes an ordinary
    squared difference. This lets a BallTree(metric='euclidean') over embedded points reproduce the view-family
    hard gate EXACTLY and sublinearly (S7 — index the cheap hard gate, L099)."""
    return [v[0]/VIEWPOINT_SC[0], v[1]/VIEWPOINT_SC[1], v[2]/VIEWPOINT_SC[2], abs(v[3])/VIEWPOINT_SC[3]]

def viewpoint_dist(va, vb):
    """Continuous camera-viewpoint distance (viewpoint layout v2): [sideness, face_vis, leg_torso, ear_sign].
    sideness/face_vis/leg_torso are ACHIRAL (mirror-symmetric). ear_sign is CHIRAL — a left-handed subject
    filmed from one side matches a right-handed subject filmed from the other once ONE clip is horizontally
    flipped at render, so mirror is handled by min-over-mirror (flip the sign of the chiral term), NOT by
    abs()-folding (which would erase the only side/back-distinguishing cue). Per-feature scales differ
    (sideness~0-3, face~0-1, leg_torso~0-4) so each is divided by its rough range to contribute comparably.
    Defined as the L2 distance of viewpoint_embed(va), viewpoint_embed(vb) (ONE SSOT geometry — see
    viewpoint_embed; the |ear_sign| embedding is the exact algebraic equivalent of min-over-mirror)."""
    if len(va)<4 or len(vb)<4: return 1.0
    ea, eb = viewpoint_embed(va), viewpoint_embed(vb)
    return math.sqrt(sum((ea[i]-eb[i])**2 for i in range(4)))

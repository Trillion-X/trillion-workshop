#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/render_overlay.py
#
# =============================================================================
# PURPOSE — THE MATCH-TRACKING OVERLAY (the product surface, not the brain)
# =============================================================================
#
# The CV01–CV14c pipeline is a perception ENGINE that emits JSON facts (court
# homography, dense ball-state, bounces, calibrated line-calls). Facts are not a
# product — a human cannot open a JSON file and SEE the match being tracked. This
# is the missing product surface (the gauntlet's "tennis overlay means the decided
# live overlay in the UI, not a separate brain"): it draws the SAME facts the live
# CV08 emitter produces ONTO the real video, so the tracking is visible and usable.
#
# It runs the identical live path (court detector + WASB ball-state + CV14c court
# gate + bounce + uncertainty line-call) and renders:
#   - the court lines, projected from the calibrated reference template through the
#     per-frame homography (so the overlay proves the homography is correct)
#   - the dense ball track: a fading trail + the current ball, GREEN when observed,
#     AMBER when interpolated/occluded (fail-closed: you can SEE low-confidence)
#   - each bounce: a ring at the contact point + its IN / OUT / NEEDS_YOUR_CALL call
#     with confidence (held on screen for ~1s so it is readable)
#   - a HUD: frame, ball confidence, model provenance, court-gate state
#
# Output: an annotated .mp4 + sample .png frames the user can open immediately.
# Input: a video file OR a frame directory (TrackNet game/clip layout).
#
# Run: python3 render_overlay.py <video.mp4 | frame_dir> [out.mp4] [max_frames]
#
# max_frames (positional, or MATCH_MAX_FRAMES env DATA from the descriptor; 0/absent
# = the whole clip) bounds how many frames are tracked+drawn — the SAME generic knob
# emit_match_facts.py carries, for a fast preview overlay and a bounded e2e test.
# =============================================================================

from __future__ import annotations

import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# Vendored TennisProject (court detector) + weights live OUTSIDE package source —
# their location is DATA from TrackerDescriptor.env (MATCH_VENDOR_ROOT), exactly as
# emit_match_facts.py resolves them. The generic package names NO machine path
# (Physics/Society + L089); fail closed when the env DATA is absent.
_VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not _VENDOR:
    raise SystemExit(
        "MATCH_VENDOR_ROOT env DATA is required (supplied by TrackerDescriptor.env) — "
        "the vendored TennisProject + weights live in the Society home, not package source"
    )
sys.path.insert(0, os.path.join(_VENDOR, "TennisProject"))

import wasb_infer  # noqa: E402
from bounce_detect_v2 import detect_bounces  # noqa: E402
from court_detection_net import CourtDetectorNet  # noqa: E402
from court_geometry import (  # noqa: E402
    REF_BASELINE_TOP_Y, REF_BASELINE_BOT_Y, REF_SINGLES_LEFT_X, REF_SINGLES_RIGHT_X,
    REF_DOUBLES_LEFT_X, REF_DOUBLES_RIGHT_X, REF_NET_Y, REF_SERVICE_TOP_Y,
    REF_SERVICE_BOT_Y, REF_MIDDLE_X, tennis_polygons, project_px_to_court_m,
    signed_distance_to_polygon, line_call, court_region_accept, calibrate_court_gate,
)

# Court lines as DATA in reference coords (endpoints); projected ref->image per
# frame via inv(H). Generic: a different sport = a different segment list.
_BT, _BB = REF_BASELINE_TOP_Y, REF_BASELINE_BOT_Y
_DL, _DR = REF_DOUBLES_LEFT_X, REF_DOUBLES_RIGHT_X
_SL, _SR = REF_SINGLES_LEFT_X, REF_SINGLES_RIGHT_X
_ST, _SB = REF_SERVICE_TOP_Y, REF_SERVICE_BOT_Y
COURT_SEGMENTS = [
    ((_DL, _BT), (_DL, _BB)), ((_DR, _BT), (_DR, _BB)),          # doubles sidelines
    ((_DL, _BT), (_DR, _BT)), ((_DL, _BB), (_DR, _BB)),          # baselines
    ((_SL, _BT), (_SL, _BB)), ((_SR, _BT), (_SR, _BB)),          # singles sidelines
    ((_SL, _ST), (_SR, _ST)), ((_SL, _SB), (_SR, _SB)),          # service lines
    ((REF_MIDDLE_X, _ST), (REF_MIDDLE_X, _SB)),                  # centre service line
    ((_DL, REF_NET_Y), (_DR, REF_NET_Y)),                        # net
]

CYAN, GREEN, AMBER, RED, WHITE = (255, 230, 0), (0, 230, 0), (0, 180, 255), (40, 40, 255), (255, 255, 255)
CALL_COLOR = {"IN": GREEN, "OUT": RED, "NEEDS_YOUR_CALL": AMBER}


def read_input(path, max_frames=0):
    if os.path.isdir(path):
        exts = (".jpg", ".jpeg", ".png")
        files = sorted(f for f in os.listdir(path) if f.lower().endswith(exts))
        if max_frames:
            files = files[:max_frames]
        frames = [cv2.imread(os.path.join(path, f)) for f in files]
        return [f for f in frames if f is not None]
    return wasb_infer.read_frames(path, max_frames)


def project_ref_to_image(ref_pt, H):
    """ref (court-template) coords -> image px via inv(H) (H maps image->ref)."""
    Hi = np.linalg.inv(np.asarray(H, float))
    v = Hi @ np.array([ref_pt[0], ref_pt[1], 1.0])
    return int(round(v[0] / v[2])), int(round(v[1] / v[2]))


def draw_court(img, H):
    for a, b in COURT_SEGMENTS:
        try:
            pa, pb = project_ref_to_image(a, H), project_ref_to_image(b, H)
        except np.linalg.LinAlgError:
            return
        cv2.line(img, pa, pb, CYAN, 2, cv2.LINE_AA)


def label(img, org, text, color, scale=0.6):
    (w, h), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
    x, y = org
    cv2.rectangle(img, (x - 3, y - h - 5), (x + w + 3, y + 5), (0, 0, 0), -1)
    cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2, cv2.LINE_AA)


def main():
    # The clip + output path are caller-supplied (the orchestrator / compute.process
    # descriptor passes them); a Society-home probe clip is the default so the
    # script is runnable standalone without any package-source path.
    video = sys.argv[1] if len(sys.argv) > 1 else os.path.join(_VENDOR, "_probe", "fed_court_720.mp4")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(_VENDOR, "_probe", "match_overlay.mp4")
    max_frames = int(sys.argv[3]) if len(sys.argv) > 3 else int(os.environ.get("MATCH_MAX_FRAMES", "0") or "0")
    frames = read_input(video, max_frames)
    if not frames:
        raise SystemExit(f"no frames in {video}")
    Himg, Wimg = frames[0].shape[:2]

    court = CourtDetectorNet(os.path.join(_VENDOR, "weights", "court_detection.pt"), "cpu")
    H_mats, _ = court.infer_model(frames)

    cands, states = wasb_infer.infer_frames(frames, device="cpu")
    accept = court_region_accept(H_mats)
    reliable, frac = calibrate_court_gate(cands, accept)
    if reliable:                                            # CV14c live-path parity
        cands, states = wasb_infer.infer_frames(frames, device="cpu", accept=accept)

    dense = [(s.frame, s.xy[0], s.xy[1]) for s in states if s.status != "unknown"]
    doubles = tennis_polygons()["doubles"]

    def on_court(fr, xy):
        H = H_mats[fr] if fr < len(H_mats) and H_mats[fr] is not None else None
        return True if H is None else signed_distance_to_polygon(project_px_to_court_m(xy, H), doubles) < 2.0

    bounces = detect_bounces(dense, min_gap_frames=12, accept=on_court,
                             provenance={"over": "perception.ball.state"})
    # line-call per bounce (uncertainty band), held on screen from its frame for ~30 frames
    calls = {}
    for b in bounces:
        H = H_mats[b.frame] if b.frame < len(H_mats) and H_mats[b.frame] is not None else None
        if H is None:
            continue
        cm = project_px_to_court_m(b.image_xy, H)
        lc = line_call(np.asarray(cm), np.diag([0.04, 0.04]), tennis_polygons()["singles"],
                       polygon_name="singles")
        calls[b.frame] = (b, lc)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    vw = cv2.VideoWriter(out, fourcc, 30.0, (Wimg, Himg))
    trail, png_saved = [], []
    for i, fr in enumerate(frames):
        img = fr.copy()
        if i < len(H_mats) and H_mats[i] is not None:
            draw_court(img, H_mats[i])
        s = states[i]
        if s.status != "unknown":
            x, y = int(s.xy[0]), int(s.xy[1])
            trail.append((x, y))
            trail = trail[-18:]
            for j, (tx, ty) in enumerate(trail[:-1]):
                cv2.circle(img, (tx, ty), 2, (120, 120, 120), -1, cv2.LINE_AA)
            col = GREEN if s.status == "observed" else AMBER
            cv2.circle(img, (x, y), 7, col, 2, cv2.LINE_AA)
        # bounces + calls held for ~30 frames after the contact
        for bf, (b, lc) in calls.items():
            if bf <= i <= bf + 30:
                bx, by = int(b.image_xy[0]), int(b.image_xy[1])
                cv2.circle(img, (bx, by), 14, CALL_COLOR.get(lc.call, WHITE), 3, cv2.LINE_AA)
                label(img, (bx + 18, by), f"{lc.call.replace('_',' ')} {lc.call_confidence:.2f}",
                      CALL_COLOR.get(lc.call, WHITE), 0.6)
        # HUD
        conf = s.confidence if s.status != "unknown" else 0.0
        label(img, (12, 26), f"f{i}  ball {s.status} {conf:.2f}", WHITE, 0.6)
        label(img, (12, 52), f"WASB-SBDT + court{'  +gate' if reliable else ''}  bounces:{len(bounces)}",
              CYAN, 0.55)
        vw.write(img)
        if i in (0, len(frames) // 2, len(frames) - 1) or i in calls:
            p = out.replace(".mp4", f"_f{i:04d}.png")
            cv2.imwrite(p, img)
            png_saved.append(p)
    vw.release()

    print("MATCH-TRACKING OVERLAY rendered (the product surface, not the brain):")
    print(f"  input: {os.path.basename(video)}  frames: {len(frames)}")
    print(f"  court homographies: {sum(1 for H in H_mats if H is not None)}/{len(frames)}")
    print(f"  ball states: {sum(1 for s in states if s.status != 'unknown')}/{len(frames)} dense; "
          f"court gate: {'ON' if reliable else 'off'} ({frac:.2f})")
    print(f"  bounces drawn: {len(bounces)}; line-calls: {len(calls)}")
    print(f"  VIDEO: {out}")
    print(f"  FRAMES (open these): {', '.join(os.path.basename(p) for p in png_saved)}")


if __name__ == "__main__":
    main()

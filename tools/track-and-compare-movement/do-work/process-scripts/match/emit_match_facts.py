#!/usr/bin/env python3
"""emit_match_facts.py — CV08 (plan §24.5 / §24.10): run the REAL match-perception
stage graph on one clip and emit SELF-DESCRIBING perception fact records (L090),
each carrying its own kind + payload + provenance + confidence so the generic
motion-analysis record-maker admits them with ZERO court/ball-specific code.

The stage graph (all proven leaves — no hardcoded geometry, no ±4-frame nearest,
no rectangle classify()):
  court  : CourtDetectorNet            -> perception.court.geometry (14 kps + H)
  ball   : WASB-SBDT + CV03 smoother   -> perception.ball.state  (dense, occlusion-aware)
  bounce : CV05 two-segment/BIC fit    -> perception.ball.bounce (posterior, fail-closed)
  call   : CV06 uncertainty geometry   -> perception.line_call   (IN/OUT/NEEDS_YOUR_CALL)

Every line-call propagates the ball-state covariance through the court homography
to court-meters, then applies the ball-radius + 1.96σ band — an ambiguous bounce
returns NEEDS_YOUR_CALL, never a fabricated call (fail-closed, plan §24.5.6).

STRUCTURE (MP9.2 slice 2d-iii): the module is IMPORTABLE — perception
(`detect_perception`, forward-injectable) is separated from fact assembly
(`build_command_output`). The native script path (`main`) constructs the forwards
from MATCH_FORWARD; the on-device runtime imports these functions and drives them
with onnxruntime-web forwards (capture/replay), emitting BYTE-IDENTICAL facts — one
canonical assembler, never a second implementation (SSOT).

USAGE: emit_match_facts.py <video> <command-output.json> [request_id] [max_frames]
"""
import sys, os, json
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
# Vendored TennisProject (court detector) + weights live OUTSIDE package source —
# their location is DATA from TrackerDescriptor.env (MATCH_VENDOR_ROOT). The generic
# package names NO path (L089: env is data, not a code branch) and FAILS CLOSED if it
# is absent (SP5 — no silent fallback to a machine-specific path).
_VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not _VENDOR:
    raise RuntimeError(
        "MATCH_VENDOR_ROOT env DATA is required (supplied by TrackerDescriptor.env) — "
        "the generic package names no model path"
    )
sys.path.insert(0, os.path.join(_VENDOR, "TennisProject"))
# torch is imported LAZILY (only in the native forward providers / the optional player
# stage) so this emitter is importable in a torch-free runtime (on-device Pyodide). The
# neural FORWARD is DATA-selected (MATCH_FORWARD): "torch" = the native worker oracle
# (compute.process on a server with torch); "onnx" = onnxruntime (on-device via the same
# court_onnx/wasb_infer seam, byte-identical — proven cont.39/40). L089: runtime is data,
# not a code branch; the leaf math is ONE canonical impl, only the net call swaps (SSOT).
MATCH_FORWARD = os.environ.get("MATCH_FORWARD", "torch").strip().lower()

import wasb_infer
from bounce_detect_v2 import detect_bounces
from court_geometry import tennis_polygons, ref_to_m, line_call, signed_distance_to_polygon, net_line_m
from rally_events import build_rally_fact
from shot_speed import shot_speeds_kmh
from player_coverage import build_coverage_fact

W = os.path.join(_VENDOR, "weights")


def _torch_device():
    import torch
    return "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")


def detect_courts_data_selected(frames, court_run_model=None):
    """Per-frame (homographies, keypoints) via the DATA-selected forward provider.
    An INJECTED `court_run_model` (e.g. an onnxruntime-web forward, on-device) wins;
    else "onnx" runs the torch-free court_onnx seam (onnxruntime-python, byte-identical
    to the oracle — parity-gated); else "torch" runs the vendored CourtDetectorNet oracle.
    All return the IDENTICAL (mats, kps) contract, so every downstream fact is unchanged."""
    if court_run_model is not None:
        from court_onnx import detect_courts
        return detect_courts(frames, court_run_model)
    if MATCH_FORWARD == "onnx":
        from court_onnx import detect_courts, make_onnxruntime_model
        return detect_courts(frames, make_onnxruntime_model())
    from court_detection_net import CourtDetectorNet
    return CourtDetectorNet(os.path.join(W, "court_detection.pt"), _torch_device()).infer_model(frames)


def _ball_run_model(ball_run_model=None):
    """The ball model FORWARD for the DATA-selected runtime: an INJECTED forward (e.g.
    onnxruntime-web, on-device) wins; else the onnxruntime-python forward for "onnx";
    else None to use wasb_infer's native torch forward on the worker."""
    if ball_run_model is not None:
        return ball_run_model
    return wasb_infer.make_onnxruntime_model() if MATCH_FORWARD == "onnx" else None


def detect_perception(frames, *, court_run_model=None, ball_run_model=None):
    """Run court + ball perception (forward-injectable) and the CV14c court gate.
    Returns (H_mats, kps, cands, states, gate_info). The forwards are INJECTED so the
    on-device runtime can pass onnxruntime-web forwards; native passes None and the
    MATCH_FORWARD-selected provider is constructed. NOTE: the CV14c gate may call
    wasb_infer.infer_frames TWICE (ungated → calibrate → gated), so an injected
    ball_run_model MUST be re-callable across both passes (a precomputed-replay forward
    should index by call-count modulo the frame count, not a one-shot iterator)."""
    H_mats, kps = detect_courts_data_selected(frames, court_run_model)
    _ball_fwd = _ball_run_model(ball_run_model)
    cands, states = wasb_infer.infer_frames(frames, device="cpu", run_model=_ball_fwd)
    # CV14c: gate off-court detector hallucinations using the court homographies we
    # already computed — but ONLY when self-calibration shows the court fit is reliable
    # (the clip's own confident detections mostly project on-court). A wrong court fit
    # auto-disables the gate, so the ungated track is kept (no regression). Reuses the
    # court_geometry leaf; the WASB tracker stays court-agnostic (injected accept, L090).
    from court_geometry import court_region_accept, calibrate_court_gate
    _accept = court_region_accept(H_mats, margin_m=4.0)
    _reliable, _frac = calibrate_court_gate(cands, _accept)
    if _reliable:
        cands, states = wasb_infer.infer_frames(frames, device="cpu", accept=_accept, run_model=_ball_fwd)
    return H_mats, kps, cands, states, {"reliable": _reliable, "frac": _frac}


def stream_perception(frame_iter, *, court_run_model=None, ball_run_model=None, cfg=None):
    """Streaming, DECODE-ON-DEMAND counterpart to detect_perception for the on-device
    runtime: pulls frames ONE AT A TIME from frame_iter (a generator) holding only a
    3-frame ring buffer (ball needs i-1,i,i+1; court needs i) — O(1) frame memory instead
    of O(N). A full match clip fully decoded (~2.76MB/frame × thousands of frames) OOMs the
    phone; this never holds more than ~3 frames + 3 preps alive.

    Emits perception BYTE-IDENTICAL to detect_perception: the SAME per-frame court/ball
    forwards, the SAME leaves, and the SAME CV14c gate — but the gate is applied as a PURE
    post-loop candidate FILTER (no model re-run). That is byte-identical because the forward
    is deterministic: detect_perception's gated re-run produces the IDENTICAL heatmaps →
    IDENTICAL raw candidates → then filters by `accept`, which equals filtering the candidates
    we already extracted. (Proven against the batch path by test_stream_decode.)

    BOTH forwards MUST be per-frame (an injected onnxruntime-web forward, on-device, or the
    onnxruntime-python seam via MATCH_FORWARD=onnx). The batch torch court detector has no
    per-frame seam — it is the native worker path; use detect_perception there.

    Returns (H_mats, kps, cands, states, gate_info, n_frames, peak_window) where peak_window
    is the max number of raw frames alive at once (the O(1) structural witness)."""
    from court_onnx import detect_courts, make_onnxruntime_model
    cfg = cfg or {"inp_width": 512, "inp_height": 288}

    # per-frame court forward (DATA-selected; mirrors detect_courts_data_selected but stateless)
    if court_run_model is not None:
        court_fwd = court_run_model
    elif MATCH_FORWARD == "onnx":
        court_fwd = make_onnxruntime_model()
    else:
        raise SystemExit(
            "stream_perception needs a per-frame court forward "
            "(inject court_run_model or set MATCH_FORWARD=onnx)")
    ball_fwd = _ball_run_model(ball_run_model)

    H_mats, kps, cands = [], [], []
    sx = sy = None
    peak_window = 0
    for i, raw_i, p_prev, p_cur, p_next in wasb_infer.ball_window_stream(frame_iter, cfg):
        if sx is None:
            sx, sy = wasb_infer.frame_scale(raw_i.shape, cfg)
        # court — per-frame stateless (1-frame list in, 1-element lists out)
        mats, kp = detect_courts([raw_i], court_fwd)
        H_mats.append(mats[0])
        kps.append(kp[0])
        # ball — run the injected forward on the 3-frame window, keep only the tiny candidates
        hm = ball_fwd(wasb_infer.ball_stack_from_preps(p_prev, p_cur, p_next))
        cands.append(wasb_infer.candidates_from_heatmap(hm, sx, sy))
        # structural O(1) witness: ball_window_stream holds raw_cur + (transiently) raw_next
        peak_window = max(peak_window, 2)

    # CV14c — the SAME gate as detect_perception, applied as a pure candidate FILTER (no re-run).
    from court_geometry import court_region_accept, calibrate_court_gate
    _accept = court_region_accept(H_mats, margin_m=4.0)
    _reliable, _frac = calibrate_court_gate(cands, _accept)
    if _reliable:
        cands = [[c for c in fc if _accept(i, (c[0], c[1]))] for i, fc in enumerate(cands)]
    states = wasb_infer.ball_states_from_candidates(cands)
    return H_mats, kps, cands, states, {"reliable": _reliable, "frac": _frac}, len(H_mats), peak_window


def kp_xy(p):
    a = np.asarray(p, dtype=np.float32).reshape(-1)
    return [round(float(a[0]), 1), round(float(a[1]), 1)] if a.size >= 2 and np.isfinite(a[0]) and np.isfinite(a[1]) else None


def homography_to_court_m(px, H):
    """Project an image pixel through the court homography to court coords, then
    to meters. Returns (xy_m, jacobian 2x2 d(m)/d(px)) for covariance propagation."""
    def f(p):
        c = cv2.perspectiveTransform(np.array([[[float(p[0]), float(p[1])]]], np.float32),
                                     np.asarray(H, np.float32))[0, 0]
        return ref_to_m((float(c[0]), float(c[1])))
    base = f(px)
    eps = 1.0  # 1px finite difference
    jx = (f((px[0] + eps, px[1])) - base) / eps
    jy = (f((px[0], px[1] + eps)) - base) / eps
    J = np.array([[jx[0], jy[0]], [jx[1], jy[1]]])  # d(m)/d(px)
    return base, J


def _addr_token(raw):
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in str(raw))


def build_command_output(frames, fps, H_mats, kps, cands, states, *, rid,
                         video="", runtime=None, emit_players=False, published_path=None):
    """Assemble the SELF-DESCRIBING perception facts + command-output from already-run
    perception. This is the ONE canonical assembler — native and on-device call it with
    the SAME args, so the emitted facts are byte-identical regardless of where the model
    forward ran (SSOT). `emit_players` gates the optional fasterrcnn player stage.

    `published_path` is the record path the generic record-maker publishes under — it is
    DATA (the TrackerDescriptor `_emits.published_path`), threaded in via the orchestrator
    env (MATCH_PUBLISHED_PATH), NOT hardcoded in this source (V4 / L120 SSOT: the path lives
    in the descriptor DATA, the emitter is generic over it). The address namespace is the
    first path segment, so a different perception tracker reuses this emitter by DATA alone.
    Defaults to the match-perception path for standalone/test runs."""
    runtime = runtime if runtime is not None else MATCH_FORWARD
    published_path = list(published_path) if published_path else ["match-perception", "content-media-evidence"]
    namespace = published_path[0]
    facts = []
    # 1) court.geometry — DENSE SERIES (WS3b-T4b): one COLUMNAR series fact for the whole clip instead of
    # one dict per frame. Every per-frame value is preserved (full fidelity, zero data dropped) as parallel
    # arrays indexed by `frames[k]`; the repeated per-fact structural keys collapse to one header. log:False
    # (kept in the artifact, never exploded into log records — unchanged contract).
    court_frames_idx, court_keypoints, court_present, court_homography = [], [], [], []
    for i, H in enumerate(H_mats):
        if H is None:
            continue
        pts = [kp_xy(p) for p in kps[i]]
        court_frames_idx.append(i)
        court_keypoints.append(pts)
        court_present.append(sum(1 for p in pts if p))
        court_homography.append(np.asarray(H, dtype=np.float32).round(5).tolist())
    facts.append({"kind": "perception.court.geometry.series", "log": False,
                  "count": len(court_frames_idx), "frames": court_frames_idx,
                  "keypoints": court_keypoints, "keypoints_present": court_present,
                  "homography": court_homography})

    # 2) ball.state — DENSE SERIES (WS3b-T4b): dense, occlusion-aware. The provenance dict was re-serialized
    # in EVERY per-frame fact (the ~14x wrap, WS3b byte-attribution: 4.4GB of 8.8M ball.state facts). It is
    # now written ONCE as the series header; per-frame xy/covariance/status/confidence stay as parallel
    # arrays (full fidelity). log:False, unchanged (excluded from log records).
    BALL_PROV = {"model_name": "WASB-SBDT", "weights_ref": "wasb_tennis_best.pth.tar",
                 "model_version": "hrnet", "stage": "ball-track.dense.v1"}
    ball_frames_idx, ball_xy, ball_cov, ball_status, ball_conf = [], [], [], [], []
    dense_track = []  # (frame, x, y) for the bounce/line-call stages
    for s in states:
        if s.status == "unknown":
            continue
        ball_frames_idx.append(s.frame)
        ball_xy.append([round(s.xy[0], 1), round(s.xy[1], 1)])
        ball_cov.append([[round(v, 3) for v in row] for row in s.covariance_2x2])
        ball_status.append(s.status)
        ball_conf.append(s.confidence)
        dense_track.append((s.frame, s.xy[0], s.xy[1]))
    facts.append({"kind": "perception.ball.state.series", "log": False, "provenance": BALL_PROV,
                  "count": len(ball_frames_idx), "frames": ball_frames_idx, "xy": ball_xy,
                  "covariance_2x2": ball_cov, "status": ball_status, "confidence": ball_conf})

    # 3) bounce — CV05 two-segment/BIC over the dense track
    # court-plane plausibility: a real ball bounce must project within the doubles
    # court (+2m margin for alleys/just-out). Off-court inflections (player at fence,
    # noise) are rejected. The predicate is injected — the bounce leaf stays generic.
    DOUBLES_M = tennis_polygons()["doubles"]

    def _on_court(frame, image_xy):
        H = H_mats[frame] if frame < len(H_mats) else None
        if H is None:
            return False
        cm, _ = homography_to_court_m(image_xy, H)
        return signed_distance_to_polygon(np.asarray(cm), DOUBLES_M) < 2.0  # within 2m of doubles

    # min_gap_frames=12: physical floor (a ball can't bounce twice within ~0.2s @ 60fps).
    bounces = detect_bounces(dense_track, min_gap_frames=12, accept=_on_court,
                             provenance={"over": "perception.ball.state", "court_plane_gated": True})
    state_by_frame = {s.frame: s for s in states}
    SINGLES_M = tennis_polygons()["singles"]
    for b in bounces:
        H = H_mats[b.frame] if b.frame < len(H_mats) else None
        court_xy = None
        if H is not None:
            cm, _ = homography_to_court_m(b.image_xy, H)
            court_xy = [round(float(cm[0]), 3), round(float(cm[1]), 3)]
        facts.append({"kind": "perception.ball.bounce", "frame": b.frame,
                      "image_xy": [round(b.image_xy[0], 1), round(b.image_xy[1], 1)],
                      "court_xy_m": court_xy, "event_confidence": b.event_confidence,
                      "model_votes": b.model_votes, "provenance": b.provenance})

        # 4) line_call — CV06 uncertainty-propagated, fail-closed (only with a homography)
        if H is None:
            continue
        st = state_by_frame.get(b.frame)
        cov_img = np.array(st.covariance_2x2) if st else np.diag([9.0, 9.0])  # px^2
        bounce_m, J = homography_to_court_m(b.image_xy, H)
        cov_m = J @ cov_img @ J.T   # J_p Σ_pixel J_pᵀ (the J_H Σ_H term folds into calibration_margin)
        lc = line_call(bounce_m, cov_m, SINGLES_M, polygon_name="singles",
                       calibration_margin_m=0.05,  # honest: covers un-modeled keypoint/H uncertainty
                       provenance={"homography": "court_detection.pt", "bounce_frame": b.frame})
        facts.append({"kind": "perception.line_call", "frame": b.frame,
                      "call": lc.call, "target_polygon": lc.target_polygon,
                      "signed_distance_m": lc.signed_distance_m, "sigma_m": lc.sigma_m,
                      "ball_radius_m": lc.ball_radius_m, "decision_band_m": lc.decision_band_m,
                      "call_confidence": lc.call_confidence, "provenance": lc.provenance})

    # 5) rally events — the ORDERED point-scoring event stream (CJ-A.3 / §24, points-from-video).
    # Project the dense ball track to court-meters per frame (only where a court homography
    # exists), then build the rally-event fact over the REAL bounces + ball track. The net
    # line is DATA from the court spec (court_geometry.net_line_m); NO scoring rules live
    # here — the DMG reduce-graph (DATA) turns these bounce@side / net_cross symbols into
    # points. Same metre frame as the bounce court_xy_m + line-call (homography_to_court_m).
    ball_track_m = []
    for (fr, x, y) in dense_track:
        H = H_mats[fr] if fr < len(H_mats) else None
        if H is None:
            continue
        cm, _ = homography_to_court_m((x, y), H)
        ball_track_m.append((fr, float(cm[0]), float(cm[1])))
    net_pos_m, net_axis = net_line_m()
    line_call_by_frame = {f["frame"]: f["call"] for f in facts if f["kind"] == "perception.line_call"}
    bounce_facts = [f for f in facts if f["kind"] == "perception.ball.bounce"]
    facts.append(build_rally_fact(bounce_facts, ball_track_m, net_pos_m=net_pos_m,
                                  net_axis=net_axis, line_call_by_frame=line_call_by_frame))

    # 6) shot speed (km/h) — CJ-A.4 / MPV02: a measure over the SAME court-metre ball track.
    # Reuses ball_track_m; the in-court envelope test is INJECTED (generic leaf knows no court).
    # Fail-closed against TrackNet teleports (near-consecutive + in-envelope + <max km/h). The
    # median is the honest headline; peak carries its un-trustworthy caveat.
    def _in_court_envelope(xy_m):
        return signed_distance_to_polygon(np.asarray(xy_m), DOUBLES_M) < 1.0  # within 1m of doubles
    _speed = shot_speeds_kmh(ball_track_m, float(fps), accept=_in_court_envelope)
    facts.append({"kind": "perception.shot.speed",
                  "frame": _speed["samples"][0]["frame"] if _speed["samples"] else 0,
                  "samples": _speed["samples"], "count": _speed["count"],
                  "median_kmh": _speed.get("median"), "p90_kmh": _speed.get("p90"),
                  "peak_kmh": _speed.get("peak"),
                  "provenance": {"stage": "shot-speed.v1",
                                 "over": ["perception.ball.state", "perception.court.geometry"],
                                 "headline": "median",
                                 "caveat": "peak is unreliable without trajectory-continuity gating (TrackNet false-match teleports)"}})

    # 7) player positions + coverage — WHERE THE PLAYERS ARE on the court plane (the
    # "track everything" foundation: movement, court-coverage, heat). Reuses the VENDORED
    # PersonDetector leaf (TennisProject) — the package does NOT re-own person detection —
    # and the SAME homography->court-metre seam as the ball/bounce facts, so a player
    # position lives in the IDENTICAL frame as a ball position. Dense per-frame positions
    # are log:False (kept in the artifact, never exploded into the log — cont.16 trap
    # policy); the reduced perception.player.coverage fact (one per clip, like rally) is
    # log:True and carries the per-side counts + centroid + occupancy grid the dashboard
    # renders. DATA-gated by `emit_players` (descriptor env MATCH_EMIT_PLAYERS) so the
    # default fast path never pays the detector cost; absent/0 -> this stage is skipped.
    if emit_players:
        if runtime == "onnx":
            # The person detector (fasterrcnn) is NOT yet ONNX-exported, so the player stage
            # cannot run torch-free on-device. Fail CLOSED (SP5) rather than silently import
            # torch into a torch-free runtime — the descriptor must not request players on the
            # onnx runtime until the fasterrcnn export lands (a future MP9.2 slice).
            raise RuntimeError(
                "MATCH_EMIT_PLAYERS is on but MATCH_FORWARD=onnx — the player detector is not "
                "yet ONNX-exported; run players on the torch (native worker) runtime, or wait "
                "for the fasterrcnn ONNX export"
            )
        import torch  # native player path only (lazy — keeps the module torch-free at import)
        import torchvision  # the GENERIC upstream detector library — reuse, never re-own
        # Faster R-CNN / COCO is the person detector (the vendored PersonDetector wrapper
        # only adds court-mask logic we don't need and is broken on this torch — its
        # legacy `.to(torch.FloatTensor)` raises). We call the upstream model directly,
        # exactly as the proven court-ball-vision player path did; the ONLY new code here
        # is the court-metre projection + on-court gate, not the detection.
        _det = torchvision.models.detection.fasterrcnn_resnet50_fpn(pretrained=True).to("cpu").eval()

        def _detect_people(img_bgr, min_score=0.85):
            t = torch.from_numpy(img_bgr[..., ::-1].copy()).permute(2, 0, 1).float().div(255).unsqueeze(0)
            with torch.no_grad():
                p = _det(t)[0]
            return [([float(v) for v in box], float(sc))
                    for box, lab, sc in zip(p["boxes"], p["labels"], p["scores"])
                    if int(lab) == 1 and float(sc) >= min_score]  # COCO label 1 = person

        PLAYER_COURT_MARGIN_M = 6.0                     # ITF run-back/run-off play envelope (see gate below)
        _net_pos_m, _net_axis = net_line_m()           # (metres along the dividing axis, axis idx)
        _dx = [float(p[0]) for p in DOUBLES_M]
        _dy = [float(p[1]) for p in DOUBLES_M]
        _court_extent = (min(_dx), max(_dx), min(_dy), max(_dy))  # grid bounds = court spec DATA
        _player_positions = []
        # DENSE SERIES (WS3b-T4b): player positions collapse to ONE columnar series fact (provenance once)
        # instead of one dict per detection; per-detection values stay as parallel arrays (full fidelity).
        pp_frames, pp_court_xy, pp_side, pp_image_xy, pp_conf = [], [], [], [], []
        for i, H in enumerate(H_mats):
            if H is None:
                continue
            for box, pr in _detect_people(frames[i]):
                foot = ((float(box[0]) + float(box[2])) / 2.0, float(box[3]))  # bbox bottom-centre
                cm, _ = homography_to_court_m(foot, H)
                # keep players within the court PLAY ENVELOPE (drop far spectators/coaches).
                # Unlike a ball BOUNCE (which lands ON the court, ~2m gate), a PLAYER legitimately
                # stands behind the baseline (serving) and runs wide — measured 2.1–5.0m outside
                # the doubles lines on the real clip. PLAYER_COURT_MARGIN_M = 6.0m ≈ the ITF
                # run-back/run-off area, so the full movement envelope is captured while true
                # courtside spectators (10m+) are excluded. (DATA-level constant, court-agnostic.)
                if signed_distance_to_polygon(np.asarray(cm), DOUBLES_M) >= PLAYER_COURT_MARGIN_M:
                    continue
                side = "far" if float(cm[_net_axis]) < _net_pos_m else "near"
                pos = {"court_xy_m": [round(float(cm[0]), 3), round(float(cm[1]), 3)], "side": side}
                _player_positions.append(pos)
                pp_frames.append(i)
                pp_court_xy.append(pos["court_xy_m"])
                pp_side.append(side)
                pp_image_xy.append([round(foot[0], 1), round(foot[1], 1)])
                pp_conf.append(round(float(pr), 4))
        facts.append({"kind": "perception.player.position.series", "log": False,
                      "provenance": {"stage": "player-detect.v1", "model_name": "fasterrcnn_resnet50_fpn",
                                     "over": ["perception.court.geometry"]},
                      "count": len(pp_frames), "frames": pp_frames, "court_xy_m": pp_court_xy,
                      "side": pp_side, "image_xy": pp_image_xy, "confidence": pp_conf})
        facts.append(build_coverage_fact(_player_positions, grid=(3, 4), extent=_court_extent,
                                         provenance={"stage": "player-coverage.v1",
                                                     "over": ["perception.player.position"]}))
        print(f"player positions: {len(_player_positions)} on-court facts -> 1 coverage fact")

    # --- L098 translation boundary: canonical provided records for the generic seam ---
    # The namespace + path are DATA (the TrackerDescriptor `_emits.published_path`), NOT
    # hardcoded here (V4 / L120 SSOT). The address namespace is the path's first segment.
    COMMAND_RUN_ID = f"package::{namespace}::command-run-request::{rid}"

    def to_record(fact, idx):
        kind = fact["kind"]
        frame = fact.get("frame", idx)
        fact_id = f"{rid}:{kind}:{frame}:{idx}"
        payload = {k: v for k, v in fact.items() if k != "log"}
        return {
            "address": f"package::{namespace}::{_addr_token(kind)}::{_addr_token(fact_id)}",
            "path": list(published_path),
            "payload": {**payload, "request_id": rid, "command_run_id": COMMAND_RUN_ID, "fact_id": fact_id},
        }

    # Self-describing log policy (L090/L063): only facts the LOG's consumers read are
    # persisted as individual records. Dense per-frame raw state (court.geometry,
    # ball.state) is tagged `log: False` at its creation site — it stays in `facts`
    # (the full-fidelity command-output artifact, used internally by the perception
    # stages) but is NOT exploded into hundreds of unread log records. This keeps the
    # committed write-set small so the dispatch never traps serializing it (the
    # workflow response always echoes execution_context.writes — interactive.rs:244).
    records = [to_record(f, i) for i, f in enumerate(facts) if f.get("log", True)]
    calls = [f["call"] for f in facts if f["kind"] == "perception.line_call"]
    command_output = {
        "request_id": rid, "schema": "match-perception.v2", "video": video, "runtime": runtime,
        "frames": len(frames), "fps": round(float(fps), 2), "records": records, "facts": facts,
        "summary": {
            "fact_count": len(facts), "record_count": len(records),
            "court_frames": next((f["count"] for f in facts if f["kind"] == "perception.court.geometry.series"), 0),
            "ball_state_frames": next((f["count"] for f in facts if f["kind"] == "perception.ball.state.series"), 0),
            "bounces": sum(1 for f in facts if f["kind"] == "perception.ball.bounce"),
            "player_position_facts": next((f["count"] for f in facts if f["kind"] == "perception.player.position.series"), 0),
            "player_coverage": next((f for f in facts if f["kind"] == "perception.player.coverage"), None),
            "line_calls": calls,
            "calls_breakdown": {c: calls.count(c) for c in set(calls)},
            "rally_symbols": next((f["symbols"] for f in facts if f["kind"] == "perception.rally.events"), []),
            "shot_speed_median_kmh": next((f.get("median_kmh") for f in facts if f["kind"] == "perception.shot.speed"), None),
        },
    }
    return command_output


def main():
    video = sys.argv[1]
    out = sys.argv[2]
    rid = sys.argv[3] if len(sys.argv) > 3 else f"match-{os.path.basename(video)}"
    maxf = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    emit_players = os.environ.get("MATCH_EMIT_PLAYERS", "").strip().lower() in ("1", "true", "yes", "on")
    # Published record path is DATA (TrackerDescriptor `_emits.published_path`), threaded in
    # via env as a "/"-joined string (e.g. "match-perception/content-media-evidence"). Absent
    # -> the emitter's default (standalone/test runs). V4 / L120: not hardcoded in source.
    _pp = os.environ.get("MATCH_PUBLISHED_PATH", "").strip()
    published_path = [seg for seg in _pp.split("/") if seg] or None

    # --- read frames once; share with court detector + WASB ---
    frames = wasb_infer.read_frames(video, maxf)
    if not frames:
        raise SystemExit("no frames read")
    cap = cv2.VideoCapture(video); fps = cap.get(cv2.CAP_PROP_FPS); cap.release()

    H_mats, kps, cands, states, gate = detect_perception(frames)
    print(f"CV14c court gate: on-court fraction {gate['frac']:.2f} -> "
          f"{'reliable, gated' if gate['reliable'] else 'unreliable, ungated'}")

    command_output = build_command_output(frames, fps, H_mats, kps, cands, states,
                                          rid=rid, video=video, runtime=MATCH_FORWARD,
                                          emit_players=emit_players, published_path=published_path)
    with open(out, "w") as f:
        json.dump(command_output, f, indent=2)
    s = command_output["summary"]
    print(f"DONE: {s['fact_count']} facts -> court {s['court_frames']}f, ball.state {s['ball_state_frames']}f, "
          f"bounces {s['bounces']}, calls {s['calls_breakdown']}  -> {out}")


if __name__ == "__main__":
    main()

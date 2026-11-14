#!/usr/bin/env python3
# tools/match/run_perception.py
#
# PURPOSE: The ONE perception entrypoint — a clip in, a self-describing MotionClipDescriptor
# (motion-clip-descriptor.v1) out. It is the single process-job the `motion-analysis` package
# runs as DATA (a ProcessDescriptor); the package never knows there are two internal stages.
#
# This is a THIN ORCHESTRATOR, not a reimplementation (L030 — move, don't rebuild). It chains the
# TWO existing, proven stage binaries exactly as the live pipeline already invokes them:
#   STAGE 1  tools/motion/pose_estimate.py  --video CLIP --out POSE.json   (YOLO-pose; self-caches,
#            content-addressed — ingest_corpus.py:90 / build_label_sheet.py:25 use this call verbatim)
#   STAGE 2  tools/match/describe_clip.py   --kp POSE.json --source CLIP --out DESC.json
#            [--salience-config JSON]                       (test_e2e_wire.py:42 / ingest_corpus.py:93)
#
# NON-NEGOTIABLE INVARIANTS:
#   * FAIL-CLOSED (mirrors ingest_corpus iter128/Codex-iter127-F1): each stage must return rc==0 AND
#     produce its output file, else this entrypoint exits non-zero with a machine-readable reason.
#     A stale/partial file on disk is NEVER reported as success — the process-engine must see the
#     failure (FE_*), never a silent wrong descriptor.
#   * GENERIC / no domain literals: the salient-joint set is DATA (`--salience-config`, a SalienceConfig
#     JSON). Omitted => the describe_clip default (byte-identical tennis), the exact iter46 seam. No
#     "tennis"/"ball"/"wrist" appears in this file's logic — a footwork domain passes its own config.
#   * ENVIRONMENT IS DATA, NOT A BRANCH (L089): --device / --checkpoint are pass-through. Omitted =>
#     each stage's own default stands. The same code runs on an MPS laptop and a CPU server; only the
#     DATA differs.
#
# USAGE: run_perception.py --clip CLIP.mp4 --out DESC.json [--kp POSE.json]
#                          [--salience-config '{"salience_keypoints":["r_ankle","l_ankle"]}']
#                          [--device cpu] [--checkpoint yolo11x-pose.pt]
#   --kp omitted => an intermediate pose.json is written next to --out (DESC.kp.json) and reused.

from __future__ import annotations
import argparse
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# LAYOUT-AGNOSTIC stage resolution so THIS FILE IS BYTE-IDENTICAL in both homes (SSOT — one file, no
# per-location edit; a bundle-parity guard proves the copies never drift). describe_clip is always a
# sibling (source `tools/match/` AND the flat package bundle). pose_estimate is a sibling in the flat
# bundle, or one dir over in `tools/motion/` in the source-repo layout — try both, fail-closed surfaces
# a missing-stage error at run time (never a silent wrong path).
DESCRIBE_CLIP = HERE / "describe_clip.py"
sys.path.insert(0, str(HERE))  # perception_backend is a sibling (pose/heading/elevation backend = DATA, L089)
import perception_backend  # noqa: E402


def log(m: str) -> None:
    print(f"[perception] {m}", file=sys.stderr, flush=True)


def _stage(argv: list[str], out: Path, label: str) -> str | None:
    """Run one stage as its own process. Returns None on success, else a machine-readable reason.

    FAIL-CLOSED: success REQUIRES rc==0 AND the declared output exists. A non-zero rc OR a missing
    output file is a failure even if a stale file from a prior run is still on disk."""
    r = subprocess.run(argv, capture_output=True, text=True)
    if r.returncode != 0:
        return f"{label}-fail:rc={r.returncode}:{r.stderr.strip()[-160:]}"
    if not out.exists():
        return f"{label}-fail:no-output:{r.stderr.strip()[-160:]}"
    if r.stderr.strip():
        log(f"{label}: {r.stderr.strip()[-160:]}")
    return None


def run_perception(clip: Path, out: Path, kp: Path | None = None,
                   salience_config: str | None = None,
                   device: str | None = None, checkpoint: str | None = None,
                   max_frames: int | None = None) -> int:
    """clip -> pose_estimate -> describe(pose, clip, salience_cfg) -> descriptor JSON. rc 0 = success."""
    clip = Path(clip).resolve()
    out = Path(out)
    if not clip.exists():
        log(f"REFUSED: clip does not exist: {clip}")
        return 2
    out.parent.mkdir(parents=True, exist_ok=True)
    kp = Path(kp) if kp else out.with_suffix(".kp.json")
    kp.parent.mkdir(parents=True, exist_ok=True)

    # STAGE 1 — pose. Backend is DATA (L089): torch `pose_estimate` (cv2 decode) by default, or the
    # torch-free `pose_estimate_onnx` (mounted-ffmpeg decode) on the bare Fly host — same --video/--out
    # contract. pose self-caches, content-addressed; we always invoke and let it decide.
    pose_estimate = perception_backend.pose_script(HERE)
    pose_argv = [sys.executable, str(pose_estimate), "--video", str(clip), "--out", str(kp)]
    if checkpoint:
        pose_argv += ["--checkpoint", checkpoint]
    if perception_backend.pose_needs_ffmpeg():
        pose_argv += ["--ffmpeg", os.environ.get("MATCH_FFMPEG", "ffmpeg")]
    if device:
        pose_argv += ["--device", device]
    if max_frames is not None:
        pose_argv += ["--max-frames", str(max_frames)]
    err = _stage(pose_argv, kp, "pose")
    if err:
        log(f"REFUSED: {err}")
        return 1
    log(f"pose ok -> {kp.name}")

    # STAGE 2 — describe (the DATA effector seam; omitted salience-config => byte-identical default).
    desc_argv = [sys.executable, str(DESCRIBE_CLIP), "--kp", str(kp), "--source", str(clip), "--out", str(out)]
    if salience_config:
        desc_argv += ["--salience-config", salience_config]
    err = _stage(desc_argv, out, "describe")
    if err:
        log(f"REFUSED: {err}")
        return 1
    log(f"describe ok -> {out.name}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="One perception process-job: clip -> motion-clip-descriptor.v1")
    ap.add_argument("--clip", required=True, help="source clip (any player/angle/swing)")
    ap.add_argument("--out", required=True, help="descriptor JSON output path (motion-clip-descriptor.v1)")
    ap.add_argument("--kp", default=None, help="intermediate pose.json path (default: <out>.kp.json, reused)")
    ap.add_argument("--salience-config", default=None,
                    help="JSON SalienceConfig (which joints define the motion event); omitted = describe_clip default (byte-identical tennis). The DATA seam for any motion domain, zero code change.")
    ap.add_argument("--device", default=None, help="pass-through to pose_estimate (e.g. cpu/mps/cuda); omitted = its default")
    ap.add_argument("--checkpoint", default=None, help="pass-through pose checkpoint; omitted = pose_estimate default (SSOT)")
    ap.add_argument("--max-frames", type=int, default=None, help="pass-through frame cap to pose_estimate (0 = all); omitted = its default")
    a = ap.parse_args()
    return run_perception(Path(a.clip), Path(a.out), Path(a.kp) if a.kp else None,
                          a.salience_config, a.device, a.checkpoint, a.max_frames)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
# tools/match/perception_backend.py
#
# THE SSOT for "which perception backend provides the camera-on-sphere channels (heading + elevation/facing)."
# The backend is DATA, not a code branch (L089: one code path, environment is data). The default is the torch
# modules (byte-identical to the frozen S1 index); a different backend is opt-in via ONE env var.
#
# WHY (L055): heading/elevation have two interchangeable implementations with the SAME contract — the torch
# modules (`body_orientation` / `orientation`, dev/GPU) and the torch-free ONNX modules
# (`body_orientation_onnx` / `orientation_onnx`, the bare Fly host). Selecting between them must NOT be a
# code branch in every consumer (that is Society leaking into N call sites). It is ONE data value.
#
# ENUM-DISSOLUTION (L090 / enum-dissolution rule): the discriminant lives entirely in DATA and dispatch is a
# NAMING CONVENTION, not a closed registry. `MATCH_PERCEPTION_BACKEND=X` maps each contract module `<base>`
# to `<base>_X`. Adding a future backend (`trt`, `coreml`, …) needs only `<base>_trt` modules satisfying the
# same `heading_for_window` / `elevation_for_window` / `facing_for_window` contract — ZERO edit here or in any
# consumer. Empty/unset → the torch modules (`<base>`), preserving the existing frozen baseline.
#
# CONTRACT each backend module MUST provide (identical signatures across backends):
#   heading_for_window(video, t0, t1, frames=...) -> {...} | None
#   elevation_for_window(video, t0, t1, frames=...) -> {...} | None
#   facing_for_window(video, t0, t1, frames=...) -> {...} | None   (orientation module)
#
# The pose extractor (STAGE 1) is selected the SAME way — `pose_script(here)` resolves the backend's pose
# SCRIPT (`pose_estimate.py` torch default -> `pose_estimate_onnx.py` for backend='onnx'), so the WHOLE
# perception path (pose + heading + elevation) is one code path chosen by data (L089), default byte-identical.
import os
import importlib
from pathlib import Path

_ENV = "MATCH_PERCEPTION_BACKEND"


def backend() -> str:
    """The active backend suffix (DATA via env). '' = torch default (byte-identical to the frozen index)."""
    return os.environ.get(_ENV, "").strip()


def perception_module(base: str):
    """Resolve a contract module by its base name under the active backend (naming-convention dispatch).
    base='body_orientation', backend='onnx' -> import 'body_orientation_onnx'. backend='' -> 'body_orientation'."""
    suffix = backend()
    name = f"{base}_{suffix}" if suffix else base
    return importlib.import_module(name)


def heading_module():
    """The module providing heading_for_window for the active backend."""
    return perception_module("body_orientation")


def orientation_module():
    """The module providing elevation_for_window / facing_for_window for the active backend."""
    return perception_module("orientation")


def pose_script(here) -> Path:
    """The STAGE-1 pose-extractor SCRIPT for the active backend (naming-convention dispatch, like
    perception_module — pose runs as a subprocess, not an import, so this returns a path).
    backend='onnx' -> `pose_estimate_onnx.py` sibling (fail-closed if absent — never a silent wrong path).
    backend='' -> the layout-agnostic torch `pose_estimate.py` (flat-bundle sibling OR `../motion/` in the
    source-repo layout), byte-identical to the prior resolution."""
    here = Path(here)
    suffix = backend()
    if suffix:
        p = here / f"pose_estimate_{suffix}.py"
        if not p.exists():
            raise FileNotFoundError(f"pose extractor for backend '{suffix}' not found: {p}")
        return p
    for c in (here / "pose_estimate.py", here.parent / "motion" / "pose_estimate.py"):
        if c.exists():
            return c
    return here / "pose_estimate.py"


def pose_needs_ffmpeg() -> bool:
    """True when the active pose backend decodes via the mounted static ffmpeg (the torch-free path) rather
    than cv2 — i.e. any non-default backend. Driven by the DATA value, not a hardcoded backend name."""
    return bool(backend())

#!/usr/bin/env python3
# packages/motion-comparison/do-work/process-scripts/author-comparison-edl.py
#
# =============================================================================
# PURPOSE
# =============================================================================
# Translate a motion-comparison ALIGNMENT (which two clips, each clip's contact
# time, each clip's pose) into a media-composition `split` EDL — the package-proper
# keystone that turns a match result into a renderable side-by-side video. This is
# the producer role: it reads pose keypoints and emits crop rects as DATA, so the
# media-composition compositor stays BLIND to keypoints (the documented boundary —
# the compositor never sees a keypoint).
#
# Everything is DATA-driven: labels, layout, mirror (flip), and the pass list
# (full / slow-mo contact) are all config. The first-stroke and second-stroke
# backhand producers are two CONFIGURATIONS of this one script (L069) — no player
# name, no stroke name, no hardcoded count anywhere in here.
#
# media-composition is invoked downstream via its render action (compute.process),
# NOT imported. This script only WRITES the EDL JSON (media-composition's public
# input contract) — zero compile-time coupling.
#
# USAGE: author-comparison-edl.py --spec SPEC.json --out EDL.json
#
# SPEC.json (self-describing, generic):
# {
#   "encode": {"width":1920,"height":1080,"fps":30,"crf":20,"preset":"medium"},
#   "layout": "h",                         # h | v (passed through to split)
#   "left":   {"clip": "<path>", "kp": "<kp.json>", "peak": 4.8,
#              "label": "YOU", "corner": "tl", "flip": null},
#   "right":  {"clip": "<path>", "kp": "<kp.json>", "peak": 16.85,
#              "label": "REFERENCE PLAYER", "corner": "tr", "flip": "h"},
#   "passes": [ {"id":"full","half":1.0},
#               {"id":"contact","half":0.5,"speed":0.4,"label_suffix":" — CONTACT"} ]
# }
# =============================================================================

from __future__ import annotations
import argparse
import json
import urllib.request
from pathlib import Path
from typing import Any


def read_json(path: str) -> dict[str, Any]:
    # A path may be a local file OR an http(s) URL (e.g. the engine CAS endpoint
    # http://<engine>/cas/<ref>) — the live layer injects resolved media/pose URLs
    # so this pure script never reaches into CAS itself (L098).
    if path.startswith("http://") or path.startswith("https://"):
        with urllib.request.urlopen(path, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def player_crop(kp_path: str, peak_t: float, half: float, cell_aspect: float) -> dict[str, int]:
    """Union of confident keypoints in [peak-half, peak+half] -> a padded crop rect at
    the cell aspect, CLAMPED to the source frame. An over-large w/h ERRORS in ffmpeg, so
    clamping happens HERE (the compositor has no source dims and cannot clamp). No
    confident pose -> a centered full-height crop at the cell aspect (honest fallback,
    never a crash)."""
    d = read_json(kp_path)
    W, H = d["video"]["width"], d["video"]["height"]
    xs: list[float] = []
    ys: list[float] = []
    for fr in d["persons"][0]["frames"]:
        if abs(fr["t"] - peak_t) > half:
            continue
        for kp in fr["kp"]:
            x, y, c = kp[0], kp[1], kp[2]
            if c > 0.3:
                xs.append(x)
                ys.append(y)
    if not xs:
        cw = min(W, int(H * cell_aspect))
        return {"w": cw, "h": H, "x": (W - cw) // 2, "y": 0}
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bh = max((y1 - y0) * 1.6, (x1 - x0) * 1.35)  # pad around the body
    h = min(H, bh)
    w = h * cell_aspect
    if w > W:
        w = W
        h = w / cell_aspect
    x = max(0.0, min(cx - w / 2, W - w))
    y = max(0.0, min(cy - h / 2, H - h))
    return {"w": int(w), "h": int(h), "x": int(x), "y": int(y)}


def safe_half(target: float, peak: float, clip_dur: float) -> float:
    """Largest symmetric half-window keeping both seek bounds inside the clip."""
    return max(0.2, min(target, peak - 0.05, clip_dur - peak - 0.05))


def cell_aspect(layout: str, width: int, height: int) -> float:
    """Two equal cells: side-by-side (h) splits width; stacked (v) splits height."""
    return (width / 2) / height if layout == "h" else width / (height / 2)


def build_edl(spec: dict[str, Any], clip_durations: dict[str, float] | None = None) -> dict[str, Any]:
    enc = spec.get("encode", {})
    width = enc.get("width", 1920)
    height = enc.get("height", 1080)
    layout = spec.get("layout", "h")
    aspect = cell_aspect(layout, width, height)
    sides = [spec["left"], spec["right"]]
    durs = clip_durations or {}

    segments = []
    for p in spec["passes"]:
        target = float(p.get("half", 1.0))
        # symmetric half clamped to BOTH clips so the cells stay phase-aligned + in-bounds
        halves = []
        for s in sides:
            cd = durs.get(s["clip"])
            halves.append(safe_half(target, float(s["peak"]), cd) if cd else target)
        half = min(halves)
        suffix = p.get("label_suffix", "")
        sources = []
        for s in sides:
            crop = player_crop(s["kp"], float(s["peak"]), max(half, 0.6), aspect)
            src: dict[str, Any] = {
                "source": s["clip"],
                "in": round(float(s["peak"]) - half, 3),
                "out": round(float(s["peak"]) + half, 3),
                "crop": crop,
                "label": {"text": str(s.get("label", "")) + suffix,
                          "corner": s.get("corner", "tl"),
                          "size": int(s.get("label_size", 54))},
            }
            if s.get("flip"):
                src["flip"] = s["flip"]
            sources.append(src)
        seg: dict[str, Any] = {"id": p["id"], "kind": "split", "layout": layout, "sources": sources}
        if p.get("speed"):
            seg["speed"] = float(p["speed"])
        segments.append(seg)

    edl: dict[str, Any] = {
        "encode": {"width": width, "height": height, "fps": enc.get("fps", 30),
                   "crf": enc.get("crf", 20), "preset": enc.get("preset", "medium")},
        "base": {"kind": "color", "color": spec.get("bg", "black")},
        "spine": {"segments": segments},
    }
    # Voice-over track (DATA): the coaching caption spoken by the voice step, attached
    # as the composed video's audio. `voice_audio` is a resolved media path/URL injected
    # by the live layer (e.g. http://<engine>/cas/<speech-audio ref>) — this script stays
    # pure + path-agnostic (L098). Absent => a silent comparison render (unchanged).
    voice_audio = spec.get("voice_audio")
    if voice_audio:
        edl["audio_graph"] = {"replace_audio": voice_audio}
    return edl


def _midpoint(window: dict[str, Any]) -> float:
    """A swing window's contact peak = the midpoint of its [start,end] seconds."""
    return (float(window["startSeconds"]) + float(window["endSeconds"])) / 2.0


def spec_from_match_record(record: dict[str, Any], clip_paths: dict[str, str],
                           pose_paths: dict[str, str], render: dict[str, Any]) -> dict[str, Any]:
    """Translate a motion-comparison `MotionComparisonResultRecord` (the data owner's
    output) into a build_edl spec. This is the operator-flow connector: the record
    carries `sourceClipId`/`referenceClipId` + `sync.{source,reference}Window` (the
    matcher's measured windows); the live layer injects the id->path maps resolved
    from CAS (clip bytes) and from perception output (pose kp). `render` is the visual
    DATA (labels/layout/flip/passes) — same generic config as the hand-authored spec.

    Fail closed: a no-match record (no usable alignment) yields NO spec (None) — never
    a bogus EDL. The id->path maps are injected (L083/L098): this script never reaches
    into CAS itself; it consumes resolved DATA, so it stays pure + testable."""
    if record.get("noMatchReason"):
        return None  # no credible partner -> nothing to render (fail closed)
    src_id = record["sourceClipId"]
    ref_id = record["referenceClipId"]
    sync = record["sync"]
    for cid in (src_id, ref_id):
        if cid not in clip_paths:
            raise KeyError(f"clip path not resolved for clipId {cid!r}")
        if cid not in pose_paths:
            raise KeyError(f"pose path not resolved for clipId {cid!r}")
    return {
        "encode": render.get("encode", {}),
        "layout": render.get("layout", "h"),
        "bg": render.get("bg", "black"),
        "left": {
            "clip": clip_paths[src_id], "kp": pose_paths[src_id],
            "peak": _midpoint(sync["sourceWindow"]),
            "label": render.get("left_label", ""), "corner": render.get("left_corner", "tl"),
            "label_size": render.get("label_size", 54),
            **({"flip": render["left_flip"]} if render.get("left_flip") else {}),
        },
        "right": {
            "clip": clip_paths[ref_id], "kp": pose_paths[ref_id],
            "peak": _midpoint(sync["referenceWindow"]),
            "label": render.get("right_label", ""), "corner": render.get("right_corner", "tr"),
            "label_size": render.get("label_size", 54),
            **({"flip": render["right_flip"]} if render.get("right_flip") else {}),
        },
        "passes": render.get("passes", [{"id": "full", "half": 1.0}]),
        **({"voice_audio": render["voice_audio"]} if render.get("voice_audio") else {}),
    }


def spec_from_direct(source_clip: str, reference_clip: str, source_pose: str,
                     reference_pose: str, source_peak: float, reference_peak: float,
                     render: dict[str, Any]) -> dict[str, Any]:
    """Build a build_edl spec from directly-resolved media/pose URLs + contact peaks +
    render DATA. The live layer passes engine CAS http URLs as plain args (no dynamic-key
    clip_paths map, no match-record file to mount) — the simplest wiring for the pipeline
    compose-edl step. `render` carries labels/layout/passes/voice_audio (same generic DATA
    as the other modes)."""
    return {
        "encode": render.get("encode", {}),
        "layout": render.get("layout", "h"),
        "bg": render.get("bg", "black"),
        "left": {
            "clip": source_clip, "kp": source_pose, "peak": float(source_peak),
            "label": render.get("left_label", ""), "corner": render.get("left_corner", "tl"),
            "label_size": render.get("label_size", 54),
            **({"flip": render["left_flip"]} if render.get("left_flip") else {}),
        },
        "right": {
            "clip": reference_clip, "kp": reference_pose, "peak": float(reference_peak),
            "label": render.get("right_label", ""), "corner": render.get("right_corner", "tr"),
            "label_size": render.get("label_size", 54),
            **({"flip": render["right_flip"]} if render.get("right_flip") else {}),
        },
        "passes": render.get("passes", [{"id": "full", "half": 1.0}]),
        **({"voice_audio": render["voice_audio"]} if render.get("voice_audio") else {}),
    }


def probe_duration(path: str) -> float | None:
    import subprocess
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
        return float(out) if out else None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="match alignment -> media-composition split EDL")
    # Two input modes (the second is the operator-flow connector):
    #   --spec SPEC.json                                     (already-resolved spec)
    #   --match-record REC --clip-paths MAP --pose-paths MAP --render CFG
    ap.add_argument("--spec", default=None, help="already-resolved build_edl spec")
    ap.add_argument("--match-record", default=None, help="a MotionComparisonResultRecord JSON")
    ap.add_argument("--clip-paths", default=None, help="JSON map {clipId: resolved clip path}")
    ap.add_argument("--pose-paths", default=None, help="JSON map {clipId: resolved pose kp path}")
    ap.add_argument("--render", default=None, help="render config JSON (labels/layout/flip/passes)")
    ap.add_argument("--voice-audio", default=None, help="resolved voice-over media path/URL for audio_graph.replace_audio")
    # Direct-URL mode (the simplest pipeline wiring): pass resolved clip/pose URLs + peaks.
    ap.add_argument("--source-clip-url", default=None)
    ap.add_argument("--reference-clip-url", default=None)
    ap.add_argument("--source-pose-url", default=None)
    ap.add_argument("--reference-pose-url", default=None)
    ap.add_argument("--source-peak", default=None, type=float)
    ap.add_argument("--reference-peak", default=None, type=float)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.source_clip_url:
        render = read_json(args.render) if args.render else {}
        spec = spec_from_direct(args.source_clip_url, args.reference_clip_url,
                                args.source_pose_url, args.reference_pose_url,
                                args.source_peak if args.source_peak is not None else 1.0,
                                args.reference_peak if args.reference_peak is not None else 1.0,
                                render)
    elif args.match_record:
        if not (args.clip_paths and args.pose_paths and args.render):
            ap.error("--match-record requires --clip-paths, --pose-paths and --render")
        spec = spec_from_match_record(read_json(args.match_record), read_json(args.clip_paths),
                                      read_json(args.pose_paths), read_json(args.render))
        if spec is None:
            print("[author-comparison-edl] no-match record -> no EDL authored (fail closed)")
            return 0
    elif args.spec:
        spec = read_json(args.spec)
    else:
        ap.error("provide --spec OR --match-record")

    durs = {s["clip"]: probe_duration(s["clip"]) for s in (spec["left"], spec["right"])}
    durs = {k: v for k, v in durs.items() if v is not None}
    if args.voice_audio:
        spec["voice_audio"] = args.voice_audio
    edl = build_edl(spec, durs)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(edl, fh, indent=2)
    print(f"[author-comparison-edl] {len(edl['spine']['segments'])} segment(s) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

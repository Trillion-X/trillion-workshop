#!/usr/bin/env python3
# tools/motion/pose_estimate.py
#
# PURPOSE: Estimate 2D human pose per frame from a video and emit the engine-agnostic
#          `pose.keypoints.v1` contract (see research/2026-06-17-model-landscape-cssot.md).
#          This is the ONLY script that knows about a specific pose engine. Everything
#          downstream (angles, phases, alignment, render, records) consumes the contract,
#          never the engine — so swapping YOLO11-pose -> RTMPose is a new producer, zero
#          downstream edits (L069 generative primitive / L090 self-describing data).
#
# NON-NEGOTIABLE INVARIANTS:
#   - Output is pose.keypoints.v1 with COCO-17 keypoint order.
#   - Multi-person aware: `persons[]`, each with a stable track_id and per-frame keypoints.
#   - Content-addressed cache: identical (video fingerprint + engine + checkpoint) -> reuse,
#     never recompute (explicit user rule: pose is expensive, cache it).
#   - One job only. No angle math, no rendering here.
#
# ENGINE: default yolo11-pose via ultralytics (trivial install, torch+MPS). COCO-17.
#
# USAGE:
#   pose_estimate.py --video IN.mp4 --out kp.json [--checkpoint yolo11x-pose.pt]
#                    [--device mps] [--conf 0.3] [--max-frames N] [--no-cache]

from __future__ import annotations
import argparse, hashlib, json, os, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "match"))  # shared canonical pose schema (SSOT, iter75)
from pose_schema import COCO as COCO17, canonicalize_pose_track  # SSOT (iter75) — was a local COCO-17 dup, AST-verified == pose_schema.COCO → byte-identical kp.json keypoint_names; #198.6 keypoint canonicalizer (cache read + pre-write)

# SSOT for the default pose-engine checkpoint (iter155): the ONE place the default model name lives. argparse defaults to
# it AND ingest_corpus folds it into its descriptor build_fp, so swapping the model auto-busts the descriptor cache
# (structural — not a remembered BUILD_SCHEMA bump). The pose cache (_cache_valid) already keys on engine.checkpoint.
DEFAULT_POSE_CHECKPOINT = "yolo11x-pose.pt"

def log(m): print(f"[pose] {m}", file=sys.stderr, flush=True)

def fingerprint(path: str, sample=1<<20) -> str:
    """blake3-ish content fingerprint: size + head+tail md5 (fast, stable, no full read)."""
    st = os.stat(path); h = hashlib.md5()
    h.update(str(st.st_size).encode())
    with open(path, "rb") as f:
        h.update(f.read(sample))
        if st.st_size > sample:
            f.seek(-sample, os.SEEK_END); h.update(f.read(sample))
    return "md5:" + h.hexdigest()

def full_content_md5(path: str) -> str:
    """FULL-content md5 (chunked, memory-safe) — the STRUCTURAL footage-identity for check_video's C12 provenance
    proof. fingerprint() above SAMPLES head+tail (fast, fine for a cache key where a collision is benign); but a
    SAFETY bind that proves 'the rendered video IS the certified source' must hash EVERY byte — else a crafted
    same-size, same-head, same-tail, different-MIDDLE file collides and wrong footage passes the gate (iter113,
    Codex iter112 convergence). Cheap: ~200 MB/s (measured 229 ms / 46 MB reference, 2 ms / 1 MB subject trim)."""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return "md5:" + h.hexdigest()

def content_md5_bytes(data: bytes) -> str:
    """FULL-content md5 of IN-MEMORY bytes — the bytes-input twin of full_content_md5(path): IDENTICAL algorithm +
    'md5:' prefix, so content_md5_bytes(open(p,'rb').read()) == full_content_md5(p) (md5 is streaming → chunked and
    one-shot agree). For a serve path that must hash the EXACT bytes it streams: read once → hash THOSE bytes → serve
    THOSE bytes, closing the re-open TOCTOU where re-hashing a PATH then re-opening it to send is time-of-check ≠
    time-of-use (iter144, Codex iter143 F1)."""
    return "md5:" + hashlib.md5(data).hexdigest()

def _cache_valid(prev: dict, content_md5: str, checkpoint: str) -> bool:
    """A cached pose JSON is reusable IFF it was posed from the SAME video CONTENT (full `content_md5`) by the same
    checkpoint. iter117 (Codex iter116 convergence) — the gate was the PARTIAL `source_fingerprint` (head+tail
    sample). Two harms from the partial gate: (1) SAFETY — a different video that collides on the sampled bytes
    would cache-hit and return keypoints posed from the WRONG clip; (2) AVAILABILITY — a pre-iter113 entry lacks
    `content_md5`, and re-invoking pose_estimate to 'self-heal' it (produce_batch.pose) was a NO-OP because this very
    cache returned the stale file UNCHANGED, so check_video's C12 provenance gate kept FALSE-REFUSING it. Gating on
    the full content_md5 (already computed every call, line ~69 — zero added cost) fixes both: a pre-iter113 entry
    has no content_md5 → invalid → re-pose → the fresh write stamps content_md5 (the structural self-heal), and a
    partial collision can no longer reuse the wrong pose. Pure + side-effect-free so the cache decision is unit-
    tested without running YOLO (L091)."""
    v = prev.get("video", {})
    return isinstance(v, dict) and bool(content_md5) and v.get("content_md5") == content_md5 \
        and prev.get("engine", {}).get("checkpoint") == checkpoint

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--checkpoint", default=DEFAULT_POSE_CHECKPOINT)   # SSOT (iter155)
    ap.add_argument("--device", default="mps")
    ap.add_argument("--conf", type=float, default=0.3)
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--no-cache", action="store_true")
    a = ap.parse_args()

    if not Path(a.video).exists():
        log(f"video not found: {a.video}"); return 2

    fp = fingerprint(a.video)                 # partial sample (fast) — kept for back-compat / transcribe-style cache parity
    content_md5 = full_content_md5(a.video)   # iter113: FULL-content identity for check_video C12's structural provenance proof
    engine = {"name": "yolo11-pose", "checkpoint": a.checkpoint, "version": None}

    # cache check: reuse ONLY a pose of the SAME video CONTENT (full content_md5) by the same checkpoint — iter117
    # (Codex iter116). Was the PARTIAL source_fingerprint, which could collide (return the wrong pose) AND left
    # pre-iter113 entries un-healed for C12. See _cache_valid for the full reasoning. (source_fingerprint is still
    # WRITTEN below for emit_motion_records + back-compat; it is just no longer the cache gate.)
    if Path(a.out).exists() and not a.no_cache:
        try:
            prev = canonicalize_pose_track(json.loads(Path(a.out).read_text()))  # #198.6: keypoint cache read canonicalized
            if _cache_valid(prev, content_md5, a.checkpoint):
                log(f"cache hit -> {a.out} ({sum(len(p['frames']) for p in prev.get('persons',[]))} person-frames)")
                return 0
        except Exception:
            pass

    import cv2
    from ultralytics import YOLO
    import ultralytics
    engine["version"] = f"ultralytics-{ultralytics.__version__}"

    cap = cv2.VideoCapture(a.video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); cap.release()
    log(f"video {W}x{H} @ {fps:.3f}fps, {nframes} frames; engine={a.checkpoint} device={a.device}")

    model = YOLO(a.checkpoint)
    persons: dict[int, dict] = {}   # track_id -> {track_id, frames:[]}
    t0 = time.time(); i = 0

    # model.track gives stable per-person IDs across frames (needed for multi-athlete clips).
    for r in model.track(source=a.video, stream=True, device=a.device, conf=a.conf,
                         verbose=False, persist=True):
        t = i / fps
        kpts = r.keypoints
        if kpts is not None and kpts.xy is not None and len(kpts.xy):
            ids = r.boxes.id.int().cpu().tolist() if (r.boxes is not None and r.boxes.id is not None) \
                  else list(range(len(kpts.xy)))
            xy = kpts.xy.cpu().numpy()           # (n,17,2)
            cf = kpts.conf.cpu().numpy() if kpts.conf is not None else None  # (n,17)
            for p, tid in enumerate(ids):
                row = [[round(float(xy[p][k][0]),2), round(float(xy[p][k][1]),2),
                        round(float(cf[p][k]),3) if cf is not None else 1.0] for k in range(17)]
                persons.setdefault(int(tid), {"track_id": int(tid), "frames": []})
                persons[int(tid)]["frames"].append({"t": round(t,4), "i": i, "kp": row})
        i += 1
        if a.max_frames and i >= a.max_frames:
            break
        if i % 60 == 0:
            log(f"  {i} frames, {len(persons)} persons, {i/(time.time()-t0):.1f} fps")

    out = {
        "schema": "pose.keypoints.v1",
        "engine": engine,
        "video": {"path": os.path.abspath(a.video), "fps": round(fps,4),
                  "width": W, "height": H, "frames": i, "source_fingerprint": fp, "content_md5": content_md5},
        "keypoint_names": COCO17,
        "persons": [persons[k] for k in sorted(persons)],
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(canonicalize_pose_track(out), separators=(",", ":")))  # finite-ok: keypoints canonicalized pre-write (NaN→[0,0,0] conf-0), #198.6
    log(f"wrote {a.out}: {len(out['persons'])} persons, {i} frames, {time.time()-t0:.1f}s")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

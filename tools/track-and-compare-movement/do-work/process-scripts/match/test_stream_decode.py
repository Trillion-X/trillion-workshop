#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_stream_decode.py
#
# MP9.2 slice 3 (decode-on-demand) gate: stream_perception (pulls frames ONE AT A TIME via a
# generator, holding only a 3-frame ring buffer → O(1) frame memory) must emit perception
# BYTE-IDENTICAL to detect_perception (the batch path that materializes EVERY decoded frame).
#
# WHY this matters: slice 3 already made the HEATMAPS O(1); this removes the LAST memory
# ceiling — the decoded-frame array itself (~2.76MB/frame). A real match clip is thousands of
# frames; fully decoded it OOMs the on-device phone. stream_perception never holds more than
# ~3 frames + 3 preps alive, yet emits the same facts. This proves the user's "press start →
# on-device stats" vision is viable on match-length video, not just a 30-frame test clip.
#
# Env-gated (MATCH_VENDOR_ROOT + onnx models + clip); SKIPs cleanly offline. Forces the onnx
# forward (the on-device runtime; stream_perception requires a per-frame court forward).
import os
import sys

VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not VENDOR:
    print("SKIP (env): MATCH_VENDOR_ROOT not set")
    sys.exit(0)
NEED = [os.path.join(VENDOR, "onnx", "court_detection.onnx"),
        os.path.join(VENDOR, "onnx", "wasb_ball.onnx"),
        os.environ.get("MATCH_TEST_CLIP") or os.path.join(VENDOR, "_probe", "fed_court_720.mp4")]
missing = [p for p in NEED if not os.path.exists(p)]
if missing:
    print(f"SKIP (env): missing {', '.join(os.path.basename(m) for m in missing)}")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
CLIP = NEED[2]
N = int(os.environ.get("MATCH_TEST_MAX_FRAMES", "30"))

os.environ["MATCH_FORWARD"] = "onnx"          # on-device runtime — must precede the import (read at module load)
import cv2                                     # noqa: E402
import emit_match_facts as E                   # noqa: E402
import wasb_infer                              # noqa: E402

RID, RUNTIME = "rid-stream", "onnx"
_cap = cv2.VideoCapture(CLIP)
FPS = _cap.get(cv2.CAP_PROP_FPS)
_cap.release()


def facts_from(H_mats, kps, cands, states, n):
    # players OFF (the on-device default; players need the deferred fasterrcnn ONNX export).
    # build_command_output reads only len(frames) on this path → a count shim suffices (SSOT:
    # the assembler is untouched).
    return E.build_command_output([None] * n, FPS, H_mats, kps, cands, states,
                                  rid=RID, video=CLIP, runtime=RUNTIME)


# --- BATCH path (oracle): materializes every decoded frame ---
frames = wasb_infer.read_frames(CLIP, N)
n_batch = len(frames)
bH, bK, bC, bS, bg = E.detect_perception(frames)
batch = facts_from(bH, bK, bC, bS, n_batch)
del frames                                     # free the whole array before streaming

# --- STREAM path: decode-on-demand, 3-frame ring buffer (never holds the clip) ---
sH, sK, sC, sS, sg, n_stream, peak = E.stream_perception(wasb_infer.stream_frames(CLIP, N))
stream = facts_from(sH, sK, sC, sS, n_stream)

# 1) decode-on-demand actually bounded the frame memory (the O(1) structural witness)
assert n_stream == n_batch == N, f"frame count mismatch: stream {n_stream} batch {n_batch} N {N}"
assert peak <= 3 and N > peak, f"ring buffer not bounded: peak {peak} frames alive (N={N})"
assert sg["reliable"] == bg["reliable"], f"CV14c gate decision diverged: {sg} vs {bg}"

# 2) byte-identical facts vs the batch oracle
assert len(stream["facts"]) == len(batch["facts"]) > 0, \
    f"fact count mismatch/empty: {len(stream['facts'])} vs {len(batch['facts'])}"

maxnum = [0.0]
diffs = []


def walk(x, y, path=""):
    if isinstance(x, bool) or isinstance(y, bool):
        if x != y:
            diffs.append(f"{path}: {x!r} != {y!r}")
    elif isinstance(x, (int, float)) and isinstance(y, (int, float)):
        d = abs(float(x) - float(y))
        maxnum[0] = max(maxnum[0], d)
        if d > 1e-6:
            diffs.append(f"{path}: {x} != {y} (Δ{d:.2e})")
    elif isinstance(x, list) and isinstance(y, list):
        if len(x) != len(y):
            diffs.append(f"{path}: len {len(x)} != {len(y)}")
            return
        for i, (u, v) in enumerate(zip(x, y)):
            walk(u, v, f"{path}[{i}]")
    elif isinstance(x, dict) and isinstance(y, dict):
        if x.keys() != y.keys():
            diffs.append(f"{path}: keys {set(x) ^ set(y)}")
            return
        for k in x:
            walk(x[k], y[k], f"{path}.{k}")
    else:
        if x != y:
            diffs.append(f"{path}: {x!r} != {y!r}")


walk(stream["facts"], batch["facts"], "facts")
assert not diffs, "decode-on-demand stream facts diverge from the batch oracle:\n  " + "\n  ".join(diffs[:20])

nb = sum(1 for f in stream["facts"] if f["kind"] == "perception.ball.bounce")
nl = sum(1 for f in stream["facts"] if f["kind"] == "perception.point.line_call")
print(f"MP9.2 DECODE-ON-DEMAND PARITY PASS — stream_perception (3-frame ring buffer, peak "
      f"{peak} frames alive vs {N} decoded in batch) is byte-identical to detect_perception "
      f"({len(stream['facts'])} facts incl {nb} bounces + {nl} line_calls, max numeric Δ {maxnum[0]:.2e})")

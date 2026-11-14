#!/usr/bin/env python3
# packages/motion-comparison/do-work/process-scripts/test_author_comparison_edl.py
#
# Contract lock for author-comparison-edl.py — the match-alignment -> media-composition
# split EDL translation. Pure (no torch/ffmpeg): synthetic kp.json + spec, asserts the
# emitted EDL. Proves the producer is GENERIC (labels/layout/flip/passes are DATA) and
# that crops are CLAMPED to source dims (an over-large crop would ERROR in ffmpeg).
# Run: python3 test_author_comparison_edl.py

from __future__ import annotations
import importlib.util
import json
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("author_edl", HERE / "author-comparison-edl.py")
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}")


def write_kp(path: Path, w: int, h: int, peak: float, cx: float, cy: float):
    """A synthetic pose: confident keypoints clustered around (cx,cy) at the peak time."""
    frames = []
    for i in range(20):
        t = i * 0.2
        kp = [[cx - 30, cy - 40, 0.9], [cx + 30, cy + 40, 0.9], [cx, cy, 0.95]]
        frames.append({"t": round(t, 2), "kp": kp})
    path.write_text(json.dumps({"video": {"width": w, "height": h}, "persons": [{"frames": frames}]}))


def main() -> int:
    tmp = Path(tempfile.mkdtemp())
    lkp = tmp / "left.kp.json"
    rkp = tmp / "right.kp.json"
    write_kp(lkp, 1920, 1080, 4.8, 960, 540)
    # right clip is a small frame near an edge -> crop MUST clamp into the frame
    write_kp(rkp, 1280, 720, 1.6, 20, 20)

    spec = {
        "encode": {"width": 1920, "height": 1080, "fps": 30},
        "layout": "h",
        "left": {"clip": "/x/left.mp4", "kp": str(lkp), "peak": 4.8, "label": "PLAYER A", "corner": "tl"},
        "right": {"clip": "/x/right.mp4", "kp": str(rkp), "peak": 1.6, "label": "PLAYER B", "corner": "tr", "flip": "h"},
        "passes": [
            {"id": "full", "half": 1.0},
            {"id": "contact", "half": 0.5, "speed": 0.4, "label_suffix": " — CONTACT"},
        ],
    }
    # no clip durations passed -> uses target half (probe is skipped in the pure path)
    edl = M.build_edl(spec)

    segs = edl["spine"]["segments"]
    check("two passes -> two split segments", len(segs) == 2)
    check("every segment is a split with the spec layout", all(s["kind"] == "split" and s["layout"] == "h" for s in segs))
    check("encode passthrough", edl["encode"]["width"] == 1920 and edl["encode"]["height"] == 1080)

    full = segs[0]
    check("each split has exactly two sources", len(full["sources"]) == 2)

    left_src, right_src = full["sources"]
    check("labels come from DATA (no hardcoded names)", left_src["label"]["text"] == "PLAYER A" and right_src["label"]["text"] == "PLAYER B")
    check("corner from DATA", left_src["label"]["corner"] == "tl" and right_src["label"]["corner"] == "tr")
    check("flip passes through only where DATA sets it", "flip" not in left_src and right_src.get("flip") == "h")

    # crop clamped into the RIGHT frame (1280x720): x>=0,y>=0 and x+w<=1280, y+h<=720
    rc = right_src["crop"]
    check("right crop x in-bounds", 0 <= rc["x"] and rc["x"] + rc["w"] <= 1280)
    check("right crop y in-bounds", 0 <= rc["y"] and rc["y"] + rc["h"] <= 720)
    # left cell aspect for h-split = (1920/2)/1080 = 0.8889; crop w/h should match that ratio (±1px rounding)
    lc = left_src["crop"]
    check("left crop matches cell aspect", abs(lc["w"] / lc["h"] - (960 / 1080)) < 0.02)

    contact = segs[1]
    check("slow-mo pass carries speed from DATA", contact.get("speed") == 0.4)
    check("label_suffix applied on the slow-mo pass", contact["sources"][0]["label"]["text"].endswith("— CONTACT"))

    # vertical layout flips the cell aspect (stacked): (1920)/(1080/2) = 3.555
    vspec = dict(spec); vspec["layout"] = "v"
    vedl = M.build_edl(vspec)
    vlc = vedl["spine"]["segments"][0]["sources"][0]["crop"]
    check("vertical layout uses stacked cell aspect", abs(vlc["w"] / vlc["h"] - (1920 / 540)) < 0.05)

    # no-confident-pose fallback never crashes (empty frames)
    empty = tmp / "empty.kp.json"
    empty.write_text(json.dumps({"video": {"width": 1000, "height": 800}, "persons": [{"frames": []}]}))
    crop = M.player_crop(str(empty), 1.0, 1.0, 960 / 1080)
    check("empty-pose fallback returns an in-bounds centered crop", 0 <= crop["x"] and crop["x"] + crop["w"] <= 1000)

    # ---- operator-flow connector: consume a real MotionComparisonResultRecord ----
    record = {
        "kind": "motion-comparison-result",
        "comparisonId": "c1", "requestId": "r1",
        "sourceClipId": "clip-subject", "referenceClipId": "clip-partner",
        "sync": {
            "sourceWindow": {"startSeconds": 4.0, "endSeconds": 5.6},      # midpoint 4.8
            "referenceWindow": {"startSeconds": 1.2, "endSeconds": 2.0},   # midpoint 1.6
            "phaseAlignment": "strong", "frameOffsets": [],
        },
        "createdAt": "2026-06-29T00:00:00Z",
    }
    clip_paths = {"clip-subject": str(tmp / "s.mp4"), "clip-partner": str(tmp / "p.mp4")}
    pose_paths = {"clip-subject": str(lkp), "clip-partner": str(rkp)}
    render = {
        "encode": {"width": 1920, "height": 1080, "fps": 30}, "layout": "h",
        "left_label": "YOU", "right_label": "REFERENCE PLAYER", "right_flip": "h",
        "passes": [{"id": "full", "half": 0.8}, {"id": "contact", "half": 0.5, "speed": 0.4, "label_suffix": " — CONTACT"}],
    }
    rspec = M.spec_from_match_record(record, clip_paths, pose_paths, render)
    check("connector derives left peak from sourceWindow midpoint", abs(rspec["left"]["peak"] - 4.8) < 1e-6)
    check("connector derives right peak from referenceWindow midpoint", abs(rspec["right"]["peak"] - 1.6) < 1e-6)
    check("connector resolves clip paths from injected map", rspec["left"]["clip"].endswith("s.mp4") and rspec["right"]["clip"].endswith("p.mp4"))
    check("connector carries flip from render DATA only where set", "flip" not in rspec["left"] and rspec["right"].get("flip") == "h")
    redl = M.build_edl(rspec)
    check("connector spec builds a valid 2-pass EDL", len(redl["spine"]["segments"]) == 2)

    # no-match record -> NO spec (fail closed, never a bogus EDL)
    nomatch = dict(record); nomatch["noMatchReason"] = "no_admissible_motion_in_view_family"
    check("no-match record yields no spec (fail closed)", M.spec_from_match_record(nomatch, clip_paths, pose_paths, render) is None)

    # unresolved clip id -> loud failure (never silently wrong)
    try:
        M.spec_from_match_record(record, {"clip-subject": "x"}, pose_paths, render)
        check("unresolved clip id raises", False)
    except KeyError:
        check("unresolved clip id raises", True)

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())

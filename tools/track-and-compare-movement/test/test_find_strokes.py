"""The stroke finder on a made-up track: six strokes, then one tracker glitch where the body is lost and a wrist jumps
fifty body heights in a frame (the Nov 20 2026 footage had exactly this). The three physical rules live in the
salience settings (SalienceConfig) of describe_clip; with them off the glitch sets the bar and hides the strokes, with
them on every stroke is found. find_strokes.py turns them on as data and swaps nothing at run time."""
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DO = os.path.join(HERE, "..", "do-work")
sys.path.insert(0, os.path.join(DO, "process-scripts", "perception"))
for _name in ("pose_schema", "describe_clip"):  # read-data/ has its own pose_schema; this test needs perception's
    sys.modules.pop(_name, None)
import describe_clip as dc  # noqa: E402

FPS = 30.0
STROKES = [3.0, 6.0, 9.0, 12.0, 15.0, 18.0]
GLITCH = 21.0


def body(t, wrist_dx=0.0, lost=False):
    """17 COCO joints of a standing body 300 px tall; the right wrist is pushed sideways by wrist_dx."""
    top, h = 100.0, 300.0
    if lost:
        h = 20.0
    kp = [[500.0, top + h * y, 0.9] for y in (0.0, 0.0, 0.0, 0.02, 0.02, 0.2, 0.2, 0.35, 0.35, 0.5, 0.5,
                                               0.55, 0.55, 0.78, 0.78, 1.0, 1.0)]
    kp[10] = [500.0 + wrist_dx, top + h * 0.5, 0.9]
    return {"t": round(t, 4), "kp": kp}


def track():
    frames = []
    n = int(24.0 * FPS)
    for i in range(n):
        t = i / FPS
        dx = 0.0
        for s in STROKES:
            if abs(t - s) < 0.2:  # a forehand: the wrist sweeps 1.5 body heights out and back in 0.4 s
                dx = 450.0 * math.sin((t - s + 0.2) / 0.4 * math.pi)
        lost = abs(t - GLITCH) < 0.1
        if abs(t - GLITCH) < 0.02:
            dx = 15000.0
        frames.append(body(t, dx, lost))
    return {"video": {"path": "made-up.mp4", "fps": FPS, "width": 1920, "height": 1080, "frames": n},
            "persons": [{"id": 1, "frames": frames}]}


def contacts(windows, person):
    out = []
    for a, b in windows:
        fr = person["frames"][a:b + 1]
        out.append(max(fr, key=lambda f: abs(f["kp"][10][0] - 500.0))["t"])
    return out


class PhysicalRules(unittest.TestCase):
    def test_off_by_default_so_existing_callers_are_unchanged(self):
        cfg = dc.DEFAULT_SALIENCE_CONFIG
        self.assertEqual((cfg.lost_body_frac, cfg.max_body_heights_per_frame, cfg.cap_percentile), (0.0, 0.0, 0.0))

    def test_glitch_hides_strokes_without_rules(self):
        person = dc.main_track(track())
        self.assertLess(len(dc.detect_windows(person, FPS)), len(STROKES))

    def test_rules_find_every_stroke(self):
        cfg = dc.salience_config_from_dict({"lost_body_frac": 0.4, "max_body_heights_per_frame": 1.0,
                                            "cap_percentile": 0.99})
        person = dc.main_track(track())
        found = contacts(dc.detect_windows(person, FPS, cfg), person)
        self.assertEqual(len(found), len(STROKES))
        for want, got in zip(STROKES, found):
            self.assertAlmostEqual(want, got, delta=0.1)

    def test_bad_rule_values_are_refused(self):
        for bad in ({"cap_percentile": 1.5}, {"lost_body_frac": -0.1}, {"max_body_heights_per_frame": "1"}):
            with self.assertRaises(ValueError):
                dc.salience_config_from_dict(bad)

    def test_find_strokes_uses_the_rules_and_swaps_nothing(self):
        before = dc.salience_series
        with tempfile.TemporaryDirectory() as d:
            src, out = os.path.join(d, "t.json"), os.path.join(d, "s.json")
            json.dump(track(), open(src, "w"))
            r = subprocess.run([sys.executable, os.path.join(DO, "find_strokes.py"), "--track", src, "--out", out],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout.strip().splitlines()[-1])["result"]["strokes"], len(STROKES))
        self.assertIs(dc.salience_series, before)
        source = open(os.path.join(DO, "find_strokes.py")).read()
        self.assertNotIn("dc.salience_series =", source)


if __name__ == "__main__":
    unittest.main()

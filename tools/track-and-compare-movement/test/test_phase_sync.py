"""phase_sync.py on made-up swings: the reference is the target's swing played through a known retiming, so the pieces
phase_sync finds can be checked against the retiming it has to undo.

No video: a pose track is a skeleton whose arm turns with the swing's phase, so every phase has its own posture.
"""
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import importlib.util

import numpy as np

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "phase_sync.py"
spec = importlib.util.spec_from_file_location("phase_sync", SCRIPT)
M = importlib.util.module_from_spec(spec)
sys.modules["phase_sync"] = M
spec.loader.exec_module(M)

FPS = 30.0


def posture(phase):
    """A COCO-17 skeleton whose racket arm turns 2 radians per second of phase (a different posture for each phase)."""
    angle = phase * 2.0
    kp = [[100.0, 50.0, 0.99]] * 5
    kp += [[130.0, 100.0, 0.99], [70.0, 100.0, 0.99]]
    kp += [[130 + 30 * math.cos(angle), 100 + 30 * math.sin(angle), 0.9], [60.0, 140.0, 0.9]]
    kp += [[130 + 60 * math.cos(angle), 100 + 60 * math.sin(angle), 0.9], [50.0, 180.0, 0.9]]
    kp += [[120.0, 200.0, 0.99], [80.0, 200.0, 0.99], [122.0, 260.0, 0.9], [78.0, 260.0, 0.9], [124.0, 320.0, 0.9], [76.0, 320.0, 0.9]]
    return kp


def track(seconds, phase_of, frames_from=0, frames_to=None):
    """Pose frames at FPS whose posture is phase_of(second)."""
    frames = [{"t": round(i / FPS, 6), "i": i, "kp": posture(phase_of(i / FPS))} for i in range(frames_from, frames_to or int(seconds * FPS) + 1)]
    return {"video": {"width": 400, "height": 400, "fps": FPS}, "persons": [{"track_id": 1, "frames": frames}]}


# The reference plays the target's phases through this retiming: target second -> reference second.
TARGET_KNOTS = [0.5, 1.1, 1.7, 2.3, 2.6]
REFERENCE_KNOTS = [5.0, 5.3, 6.2, 6.8, 7.4]          # speeds 0.5, 1.5, 1.0, 2.0
CONTACT_TARGET, CONTACT_REFERENCE = 1.7, 6.2


def retiming(target_second):
    return float(np.interp(target_second, TARGET_KNOTS, REFERENCE_KNOTS))


def write_pair(folder, reference_knots=REFERENCE_KNOTS):
    target = folder / "target.json"
    reference = folder / "reference.json"
    target.write_text(json.dumps(track(3.0, lambda t: t)))
    reference.write_text(json.dumps(track(8.0, lambda r: float(np.interp(r, reference_knots, TARGET_KNOTS)))))
    return {
        "fps": FPS,
        "target": {"kp": str(target), "in": TARGET_KNOTS[0], "contact": CONTACT_TARGET, "out": TARGET_KNOTS[-1], "track_id": 1},
        "reference": {"kp": str(reference), "in": reference_knots[0], "contact": reference_knots[2], "out": reference_knots[-1]},
    }


def reference_second_at(sync, plays):
    """Where the synced reference is at `plays` output seconds from the cell start."""
    for piece in sync["pieces"]:
        if piece["plays_from"] - 1e-9 <= plays <= piece["plays_to"] + 1e-9:
            return piece["from"] + (plays - piece["plays_from"]) * piece["speed"]
    raise AssertionError(f"no piece plays at {plays}")


class TheSync(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.tmp = Path(self.folder.name)
        self.spec = write_pair(self.tmp)

    def tearDown(self):
        self.folder.cleanup()

    def test_the_reference_reaches_every_phase_of_the_target_within_one_output_frame(self):
        sync = M.phase_sync(self.spec)
        self.assertEqual(sync["kind"], "phase_sync.v1")
        self.assertLessEqual(len(sync["pieces"]), M.SETTINGS["max_pieces"])
        for frame in range(int((TARGET_KNOTS[-1] - TARGET_KNOTS[0]) * FPS) + 1):
            plays = frame / FPS
            # The reference shows the target's phase at output time `plays` when it is at retiming(target second).
            wanted = retiming(TARGET_KNOTS[0] + plays)
            got = reference_second_at(sync, plays)
            speed = next(p["speed"] for p in sync["pieces"] if p["plays_from"] - 1e-9 <= plays <= p["plays_to"] + 1e-9)
            self.assertLessEqual(abs(got - wanted) / speed * FPS, 1.0, (frame, got, wanted, sync["pieces"]))

    def test_contact_is_pinned_and_the_window_edges_meet(self):
        sync = M.phase_sync(self.spec)
        self.assertAlmostEqual(reference_second_at(sync, CONTACT_TARGET - TARGET_KNOTS[0]), CONTACT_REFERENCE, places=6)
        self.assertEqual(sync["pieces"][0]["from"], REFERENCE_KNOTS[0])
        self.assertEqual(sync["pieces"][-1]["to"], REFERENCE_KNOTS[-1])
        self.assertAlmostEqual(sync["pieces"][-1]["plays_to"], TARGET_KNOTS[-1] - TARGET_KNOTS[0], places=6)
        self.assertTrue(any(abs(p["plays_to"] - (CONTACT_TARGET - TARGET_KNOTS[0])) < 1e-9 for p in sync["pieces"]))

    def test_the_speed_ramp_is_the_pieces_in_reference_seconds_from_its_in(self):
        sync = M.phase_sync(self.spec)
        self.assertEqual([r["speed"] for r in sync["speed_ramp"]], [p["speed"] for p in sync["pieces"]])
        self.assertEqual(sync["speed_ramp"][0]["t"], 0.0)
        # Played through the ramp, the reference's window lasts exactly as long as the target's.
        played = sum((p["to"] - p["from"]) / p["speed"] for p in sync["pieces"])
        self.assertAlmostEqual(played, TARGET_KNOTS[-1] - TARGET_KNOTS[0], places=5)

    def test_a_retiming_beyond_the_speed_bounds_is_refused_not_distorted(self):
        far = [5.0, 5.03, 6.2, 6.8, 7.4]                  # 0.05x then about 2x: the first piece is below 0.25x
        spec = write_pair(self.tmp, far)
        with self.assertRaises(M.Refused) as caught:
            M.phase_sync(spec)
        self.assertLess(caught.exception.facts["speed"], M.SETTINGS["min_speed"])
        self.assertIn("cannot be synced", str(caught.exception))

    def test_the_bounds_are_data(self):
        self.spec["settings"] = {"max_speed": 1.2}
        with self.assertRaises(M.Refused) as caught:
            M.phase_sync(self.spec)
        self.assertGreater(caught.exception.facts["speed"], 1.2)

    def test_a_window_with_contact_outside_it_is_refused(self):
        self.spec["target"]["contact"] = 9.0
        with self.assertRaisesRegex(ValueError, "in < contact < out"):
            M.phase_sync(self.spec)

    def test_a_half_with_no_torso_is_refused(self):
        empty = self.tmp / "empty.json"
        empty.write_text(json.dumps({"persons": [{"track_id": 1, "frames": []}]}))
        self.spec["reference"]["kp"] = str(empty)
        with self.assertRaises(M.Refused) as caught:
            M.phase_sync(self.spec)
        self.assertEqual(caught.exception.facts["reference_frames"], 0)


class TheCommand(unittest.TestCase):
    def test_it_writes_the_sync_and_prints_the_result_line_and_a_refusal_says_why(self):
        with tempfile.TemporaryDirectory() as folder:
            tmp = Path(folder)
            (tmp / "spec.json").write_text(json.dumps(write_pair(tmp)))
            done = subprocess.run([sys.executable, str(SCRIPT), "--spec", str(tmp / "spec.json"), "--out", str(tmp / "o" / "sync.json")], capture_output=True, text=True, timeout=120)
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            result = json.loads(done.stdout.strip().splitlines()[-1])["result"]
            self.assertEqual(result["pieces"], len(json.loads((tmp / "o" / "sync.json").read_text())["pieces"]))
            bad = write_pair(tmp, [5.0, 5.03, 6.2, 6.8, 7.4])
            (tmp / "bad.json").write_text(json.dumps(bad))
            done = subprocess.run([sys.executable, str(SCRIPT), "--spec", str(tmp / "bad.json"), "--out", str(tmp / "o" / "bad.json")], capture_output=True, text=True, timeout=120)
            self.assertEqual(done.returncode, 1)
            self.assertIn("speed", json.loads(done.stdout.strip().splitlines()[-1])["refused"])
            self.assertFalse((tmp / "o" / "bad.json").exists())


if __name__ == "__main__":
    unittest.main()

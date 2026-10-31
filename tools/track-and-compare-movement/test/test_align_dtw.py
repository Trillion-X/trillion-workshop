"""align_dtw.py on synthetic skeletons: a wrist swing on a sine, so two tracks differ in phase and speed.

Carried from the package's alignment tests (the three align_dtw tests), with unittest in place of pytest.
"""
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "align_dtw.py"


def synthetic_track(n_frames, phase_shift=0.0, speed=1.0):
    """A moving COCO-17 skeleton: wrists swing on a sine so two tracks differ in phase/speed."""
    frames = []
    for i in range(n_frames):
        t = (i * speed) / max(n_frames - 1, 1) * math.pi + phase_shift
        swing = 40 * math.sin(t)
        kp = [[100.0, 50.0, 0.99]] * 5                               # 0-4 head
        kp += [[130 + swing, 100, 0.99], [70 - swing, 100, 0.99]]    # 5,6 shoulders
        kp += [[140 + swing, 140, 0.9], [60 - swing, 140, 0.9]]      # 7,8 elbows
        kp += [[150 + swing, 180, 0.9], [50 - swing, 180, 0.9]]      # 9,10 wrists
        kp += [[120, 200, 0.99], [80, 200, 0.99]]                    # 11,12 hips
        kp += [[122, 260, 0.9], [78, 260, 0.9]]                      # 13,14 knees
        kp += [[124, 320, 0.9], [76, 320, 0.9]]                      # 15,16 ankles
        frames.append({"t": i / 30.0, "i": i, "kp": kp})
    return {"schema": "pose.keypoints.v1", "persons": [{"track_id": 0, "frames": frames}]}


def run(clip, reference, *extra):
    folder = Path(tempfile.mkdtemp(prefix="align-dtw-"))
    s, r, out = folder / "s.json", folder / "r.json", folder / "a.json"
    s.write_text(json.dumps(clip))
    r.write_text(json.dumps(reference))
    done = subprocess.run([sys.executable, str(SCRIPT), "--clip", str(s), "--reference", str(r), "--out", str(out), *extra],
                          capture_output=True, text=True)
    return done, out


class AlignDtw(unittest.TestCase):
    def test_phase_aligns_different_speeds(self):
        """Two swings of different length and speed give a monotonic phase-alignment path."""
        done, out = run(synthetic_track(30, speed=1.0), synthetic_track(45, phase_shift=0.6, speed=1.3), "--gamma", "0.1")
        self.assertEqual(done.returncode, 0, done.stderr)
        alignment = json.loads(out.read_text())
        self.assertEqual(alignment["kind"], "phase_alignment.v1")
        self.assertEqual((alignment["clip_frames"], alignment["reference_frames"]), (30, 45))
        path = alignment["path"]
        self.assertEqual(path[0], [0, 0])
        self.assertEqual(path[-1], [29, 44])                      # endpoints anchored
        si, ri = [p[0] for p in path], [p[1] for p in path]
        self.assertEqual(si, sorted(si))
        self.assertEqual(ri, sorted(ri))                          # monotonic (no time reversal)
        self.assertTrue(set(range(30)) <= set(si) and set(range(45)) <= set(ri))  # full coverage
        answer = json.loads(done.stdout.strip().splitlines()[-1])["result"]
        self.assertEqual((answer["clip_frames"], answer["reference_frames"], answer["path_length"]), (30, 45, len(path)))

    def test_fail_closed_on_empty(self):
        """A degenerate or empty pose track exits non-zero and writes nothing, never a silent alignment."""
        done, out = run({"persons": []}, synthetic_track(10))
        self.assertNotEqual(done.returncode, 0)
        self.assertFalse(out.exists())
        self.assertIn("REFUSED", done.stderr)
        self.assertIn("needs at least 2 frames", json.loads(done.stdout.strip().splitlines()[-1])["error"])

    def test_reads_the_kp_key(self):
        """The frame keypoint key is `kp` (pose.keypoints.v1), not `keypoints`: a regression guard."""
        done, _ = run(synthetic_track(12), synthetic_track(12))
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_hard_dtw_when_gamma_is_zero(self):
        done, out = run(synthetic_track(12), synthetic_track(12), "--gamma", "0")
        self.assertEqual(done.returncode, 0, done.stderr)
        path = json.loads(out.read_text())["path"]
        self.assertEqual(path, [[i, i] for i in range(12)])       # identical tracks line up frame for frame

    def test_a_keypoint_that_is_not_a_number_is_refused(self):
        """A NaN would make every cost NaN and the path meaningless: it is refused with the reason, nothing is written."""
        bad = synthetic_track(12)
        bad["persons"][0]["frames"][3]["kp"][9] = [float("nan"), 180, 0.9]
        done, out = run(bad, synthetic_track(12))
        self.assertEqual(done.returncode, 1)
        self.assertFalse(out.exists())
        self.assertIn("finite", json.loads(done.stdout.strip().splitlines()[-1])["error"])


if __name__ == "__main__":
    unittest.main()

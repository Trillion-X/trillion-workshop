"""estimate_pose.py and pose_schema.py without a pose model: the contract, the cache rule and the refusals."""
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "read-data"))
sys.path.insert(0, str(HERE / "do-work"))
import estimate_pose  # noqa: E402
import pose_schema  # noqa: E402

SCRIPT = HERE / "do-work" / "estimate_pose.py"


def run(*args):
    done = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=120)
    return done, json.loads(done.stdout.strip().splitlines()[-1])


class TheContract(unittest.TestCase):
    def test_coco_has_seventeen_named_joints_in_order(self):
        self.assertEqual(len(pose_schema.COCO), 17)
        self.assertEqual((pose_schema.COCO[5], pose_schema.COCO[11], pose_schema.COCO[16]), ("l_shoulder", "l_hip", "r_ankle"))

    def test_a_keypoint_is_made_safe(self):
        kp3 = pose_schema.kp3
        self.assertEqual(kp3([1, 2, 0.5]), [1.0, 2.0, 0.5])
        self.assertEqual(kp3([1, 2]), [1.0, 2.0, 1.0])                  # two numbers: full confidence
        self.assertEqual(kp3([math.nan, 2, 0.9]), [0.0, 0.0, 0.0])      # absent, never a position
        self.assertEqual(kp3([1, 2, math.inf]), [0.0, 0.0, 0.0])
        self.assertEqual(kp3([True, 2, 1]), [0.0, 0.0, 0.0])
        self.assertEqual(kp3(None), [0.0, 0.0, 0.0])
        self.assertEqual(kp3(7), [0.0, 0.0, 0.0])
        self.assertEqual(kp3([1]), [0.0, 0.0, 0.0])

    def test_all_three_shapes_are_canonicalized_in_place_and_only_kp_changes(self):
        bad = [[math.nan, 0, 1]] + [[1, 2, 0.9]] * 16
        whole = {"persons": [{"track_id": 3, "frames": [{"t": 0.5, "i": 1, "kp": [list(p) for p in bad]}]}]}
        person = {"frames": [{"kp": [list(p) for p in bad]}]}
        pose = {"kp": [list(p) for p in bad]}
        for shape, get in ((whole, lambda s: s["persons"][0]["frames"][0]["kp"]), (person, lambda s: s["frames"][0]["kp"]), (pose, lambda s: s["kp"])):
            self.assertIs(pose_schema.canonicalize_pose_track(shape), shape)
            self.assertEqual(get(shape)[0], [0.0, 0.0, 0.0])
            self.assertEqual(get(shape)[1], [1.0, 2.0, 0.9])
        self.assertEqual((whole["persons"][0]["track_id"], whole["persons"][0]["frames"][0]["t"]), (3, 0.5))
        self.assertEqual(pose_schema.canonicalize_pose_track("x"), "x")


class TheCacheRule(unittest.TestCase):
    def test_a_track_is_reused_only_for_the_same_bytes_and_checkpoint(self):
        with tempfile.TemporaryDirectory() as folder:
            a, b = Path(folder) / "a.bin", Path(folder) / "b.bin"
            a.write_bytes(b"x" * 3_000_000 + b"1" + b"y" * 10)
            b.write_bytes(b"x" * 3_000_000 + b"2" + b"y" * 10)           # same size, same head and tail, other middle
            digest_a, digest_b = estimate_pose.content_digest(a), estimate_pose.content_digest(b)
            self.assertNotEqual(digest_a, digest_b)
            track = {"video": {"content_digest": digest_a}, "engine": {"checkpoint": "m.pt"}}
            self.assertTrue(estimate_pose.cache_valid(track, digest_a, "m.pt"))
            self.assertFalse(estimate_pose.cache_valid(track, digest_b, "m.pt"))
            self.assertFalse(estimate_pose.cache_valid(track, digest_a, "other.pt"))
            self.assertFalse(estimate_pose.cache_valid({"video": {}, "engine": {}}, digest_a, "m.pt"))
            self.assertFalse(estimate_pose.cache_valid({}, "", "m.pt"))


class TheCommand(unittest.TestCase):
    def test_a_missing_video_or_checkpoint_says_what_to_change(self):
        with tempfile.TemporaryDirectory() as folder:
            model = Path(folder) / "m.pt"
            model.write_bytes(b"weights")
            done, answer = run("--video", str(Path(folder) / "none.mp4"), "--out", str(Path(folder) / "t.json"), "--checkpoint", str(model))
            self.assertEqual(done.returncode, 2)
            self.assertIn("not a file", answer["error"])
            video = Path(folder) / "v.mp4"
            video.write_bytes(b"video")
            done, answer = run("--video", str(video), "--out", str(Path(folder) / "t.json"), "--checkpoint", str(Path(folder) / "none.pt"))
            self.assertEqual(done.returncode, 2)
            self.assertIn("downloaded pose model", answer["error"])

    def test_a_track_made_from_the_same_video_and_checkpoint_is_returned_without_a_model(self):
        with tempfile.TemporaryDirectory() as folder:
            video, model, out = Path(folder) / "v.mp4", Path(folder) / "m.pt", Path(folder) / "t.json"
            video.write_bytes(b"some video bytes")
            model.write_bytes(b"weights")
            track = {"schema": "pose.keypoints.v1", "engine": {"checkpoint": str(model)},
                     "video": {"content_digest": estimate_pose.content_digest(video), "frames": 4},
                     "persons": [{"track_id": 1, "frames": [{"t": 0, "i": 0, "kp": [[1, 2, 0.9]] * 17}]}]}
            out.write_text(json.dumps(track))
            done, answer = run("--video", str(video), "--out", str(out), "--checkpoint", str(model))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(answer["result"], {"out": str(out), "persons": 1, "frames": 4, "cached": True})


if __name__ == "__main__":
    unittest.main()

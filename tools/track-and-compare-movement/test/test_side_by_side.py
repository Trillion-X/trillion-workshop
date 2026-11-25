"""side_by_side.py: a made side-by-side puts both contact frames on one output frame, and the check refuses what is not a
synced comparison of one stroke travelling one way. Sources are made-up ffmpeg test patterns (30 and 24 frames a second)."""
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "side_by_side.py"
spec = importlib.util.spec_from_file_location("side_by_side", SCRIPT)
M = importlib.util.module_from_spec(spec)
sys.modules["side_by_side"] = M
spec.loader.exec_module(M)


def side(**over):
    base = {"stroke": "forehand", "hand": "right", "camera": "behind", "mirror": False, "stroke_seen": "frames looked at"}
    return {**base, **over}


class Labels(unittest.TestCase):
    def test_direction_turns_with_hand_camera_and_mirror(self):
        self.assertEqual(M.screen_direction(side()), 1)
        self.assertEqual(M.screen_direction(side(hand="left")), -1)
        self.assertEqual(M.screen_direction(side(camera="facing")), -1)
        self.assertEqual(M.screen_direction(side(hand="left", mirror=True)), 1)

    def test_a_right_and_a_left_hand_need_one_mirror(self):
        unmirrored = M.labels({"top": side(), "bottom": side(hand="left")})
        self.assertFalse(unmirrored["same-hitting-direction"]["pass"])
        mirrored = M.labels({"top": side(mirror=True), "bottom": side(hand="left")})
        self.assertTrue(mirrored["same-hitting-direction"]["pass"])

    def test_different_strokes_or_an_unread_label_fail(self):
        self.assertFalse(M.labels({"top": side(), "bottom": side(stroke="backhand")})["same-stroke"]["pass"])
        self.assertFalse(M.labels({"top": side(), "bottom": side(stroke_seen="")})["same-stroke"]["pass"])
        self.assertTrue(M.labels({"top": side(), "bottom": side()})["same-stroke"]["pass"])

    def test_a_crop_smaller_than_the_cell_is_refused(self):
        with self.assertRaises(ValueError):
            M.cell_filter({"fps": 30, "contact_frame": 40, "crop": [320, 240, 0, 0]}, [640, 480], 30, 1.0, 1.0)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
class MakeAndCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="side-by-side-test-"))
        for name, pattern, rate in (("a.mp4", "testsrc", 30), ("b.mp4", "testsrc2", 24)):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"{pattern}=size=640x480:rate={rate}:duration=4",
                            "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(cls.dir / name)], check=True)
        cls.spec = {"top": side(source=str(cls.dir / "a.mp4"), fps=30, contact_frame=50, crop=[640, 480, 0, 0], mirror=True),
                    "bottom": side(source=str(cls.dir / "b.mp4"), fps=24, contact_frame=41, crop=[640, 480, 0, 0], hand="left"),
                    "cell": [640, 480], "fps": 30, "before_s": 1.0, "after_s": 1.0, "encode": {"crf": 12, "preset": "veryfast"}}
        cls.made = M.make(cls.spec, str(cls.dir / "clip.mp4"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir)

    def test_both_contacts_land_on_the_same_output_frame(self):
        self.assertEqual(self.made["contact_output_frame"], 30)
        result = M.check(self.spec, self.made["out"])
        self.assertTrue(result["pass"], json.dumps(result))
        self.assertEqual(result["checks"]["contact-in-sync"]["offset_frames"], 0)

    def test_a_contact_two_frames_off_fails_sync(self):
        moved = json.loads(json.dumps(self.spec))
        moved["bottom"]["contact_frame"] += 2
        self.assertFalse(M.check(moved, self.made["out"])["checks"]["contact-in-sync"]["pass"])

    def test_a_solo_clip_is_not_a_comparison(self):
        solo = json.loads(json.dumps(self.spec))
        solo["bottom"] = dict(solo["top"])
        result = M.check(solo, self.made["out"])
        self.assertFalse(result["checks"]["is-a-comparison"]["pass"])
        self.assertFalse(result["pass"])

    def test_the_sheet_holds_the_contact_and_its_neighbours(self):
        out = M.sheet(self.made["out"], self.made["contact_output_frame"], str(self.dir / "sheet.jpg"))
        self.assertEqual(out["frames"], [0, 15, 29, 30, 31, 42, 60])
        self.assertTrue(Path(out["sheet"]).stat().st_size > 0)


if __name__ == "__main__":
    unittest.main()

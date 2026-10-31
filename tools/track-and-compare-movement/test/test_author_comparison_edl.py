"""author_comparison_edl.py on synthetic pose tracks: the edit it writes, with every label, layout, flip and pass coming from the spec.

No ffmpeg and no video: a pose track and a spec are enough. The crops must be clamped into the source frame, because a
crop larger than the frame is an error in ffmpeg.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import importlib.util

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "author_comparison_edl.py"
spec = importlib.util.spec_from_file_location("author_comparison_edl", SCRIPT)
M = importlib.util.module_from_spec(spec)
sys.modules["author_comparison_edl"] = M
spec.loader.exec_module(M)


def write_track(path, width, height, cx, cy, track_id=1, ids=None):
    """Confident joints clustered around (cx, cy) in every frame, for one or more people."""
    people = []
    for person_id in ids or [track_id]:
        shift = 0 if person_id == track_id else 400
        frames = [{"t": round(i * 0.2, 2), "kp": [[cx - 30 + shift, cy - 40, 0.9], [cx + 30 + shift, cy + 40, 0.9], [cx + shift, cy, 0.95]]} for i in range(20)]
        people.append({"track_id": person_id, "frames": frames})
    path.write_text(json.dumps({"video": {"width": width, "height": height}, "persons": people}))


def base_spec(left, right):
    return {
        "encode": {"width": 1920, "height": 1080, "fps": 30},
        "layout": "h",
        "left": {"clip": "a.mp4", "kp": str(left), "peak": 2.0, "label": "ONE", "corner": "tl"},
        "right": {"clip": "b.mp4", "kp": str(right), "peak": 1.6, "label": "TWO", "corner": "tr", "flip": "h"},
        "passes": [{"id": "full", "half": 1.0}, {"id": "slow", "half": 0.5, "speed": 0.4, "label_suffix": " (slow)"}],
    }


class TheEdit(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.tmp = Path(self.folder.name)
        self.left, self.right = self.tmp / "left.json", self.tmp / "right.json"
        write_track(self.left, 1920, 1080, 960, 540)
        write_track(self.right, 1280, 720, 20, 20)           # a person at the frame's edge: the crop must clamp
        self.spec = base_spec(self.left, self.right)

    def tearDown(self):
        self.folder.cleanup()

    def test_two_passes_make_two_split_segments_with_everything_from_the_spec(self):
        edl = M.build_edl(self.spec)
        segments = edl["spine"]["segments"]
        self.assertEqual([s["id"] for s in segments], ["full", "slow"])
        self.assertTrue(all(s["kind"] == "split" and s["layout"] == "h" and len(s["sources"]) == 2 for s in segments))
        self.assertEqual((edl["encode"]["width"], edl["encode"]["height"], edl["encode"]["fps"]), (1920, 1080, 30))
        self.assertEqual(edl["base"], {"kind": "color", "color": "black"})
        left, right = segments[0]["sources"]
        self.assertEqual((left["label"]["text"], right["label"]["text"]), ("ONE", "TWO"))
        self.assertEqual((left["label"]["corner"], right["label"]["corner"]), ("tl", "tr"))
        self.assertNotIn("flip", left)
        self.assertEqual(right["flip"], "h")
        self.assertEqual((left["in"], left["out"], right["in"], right["out"]), (1.0, 3.0, 0.6, 2.6))
        self.assertNotIn("speed", segments[0])
        self.assertEqual(segments[1]["speed"], 0.4)
        self.assertTrue(segments[1]["sources"][0]["label"]["text"].endswith("(slow)"))

    def test_crops_stay_inside_the_source_frame_and_match_the_cell_aspect(self):
        segments = M.build_edl(self.spec)["spine"]["segments"]
        left, right = segments[0]["sources"]
        crop = right["crop"]
        self.assertTrue(0 <= crop["x"] and crop["x"] + crop["w"] <= 1280 and 0 <= crop["y"] and crop["y"] + crop["h"] <= 720, crop)
        self.assertAlmostEqual(left["crop"]["w"] / left["crop"]["h"], 960 / 1080, delta=0.02)

    def test_stacked_layout_uses_the_stacked_cell_aspect(self):
        self.spec["layout"] = "v"
        crop = M.build_edl(self.spec)["spine"]["segments"][0]["sources"][0]["crop"]
        self.assertAlmostEqual(crop["w"] / crop["h"], 1920 / 540, delta=0.05)

    def test_an_unknown_layout_is_refused(self):
        self.spec["layout"] = "diagonal"
        with self.assertRaisesRegex(ValueError, "'h' .side by side. or 'v'"):
            M.build_edl(self.spec)

    def test_the_half_window_is_cut_to_the_shorter_clip_so_both_cells_stay_in_phase(self):
        edl = M.build_edl(self.spec, {"a.mp4": 2.3, "b.mp4": 30.0})
        left, right = edl["spine"]["segments"][0]["sources"]
        self.assertAlmostEqual(left["out"] - left["in"], right["out"] - right["in"])
        self.assertLessEqual(left["out"], 2.3 - 0.05 + 1e-9)
        self.assertEqual(M.safe_half(5.0, 0.1, 10.0), 0.2)       # never below 0.2 seconds

    def test_a_clip_with_no_confident_joint_gets_a_centred_in_bounds_crop(self):
        empty = self.tmp / "empty.json"
        empty.write_text(json.dumps({"video": {"width": 1000, "height": 800}, "persons": [{"frames": []}]}))
        crop = M.player_crop(str(empty), 1.0, 1.0, 960 / 1080)
        self.assertTrue(0 <= crop["x"] and crop["x"] + crop["w"] <= 1000 and crop["h"] == 800, crop)

    def test_track_id_picks_the_person_and_an_unknown_one_is_refused(self):
        both = self.tmp / "both.json"
        write_track(both, 1920, 1080, 500, 500, track_id=1, ids=[1, 2])
        first = M.player_crop(str(both), 2.0, 1.0, 1.0, 1)
        second = M.player_crop(str(both), 2.0, 1.0, 1.0, 2)
        self.assertGreater(second["x"], first["x"])
        with self.assertRaisesRegex(ValueError, "track_id 9"):
            M.player_crop(str(both), 2.0, 1.0, 1.0, 9)

    def test_the_crop_padding_is_the_specs_to_change(self):
        tight = M.player_crop(str(self.left), 2.0, 1.0, 1.0, None, {"pad_height": 1.0, "pad_width": 1.0})
        wide = M.player_crop(str(self.left), 2.0, 1.0, 1.0, None, {"pad_height": 3.0, "pad_width": 3.0})
        self.assertLess(tight["h"], wide["h"])

    def test_a_voice_track_replaces_the_audio_only_when_given(self):
        self.assertNotIn("audio_graph", M.build_edl(self.spec))
        self.spec["voice_audio"] = "narration.wav"
        self.assertEqual(M.build_edl(self.spec)["audio_graph"], {"replace_audio": "narration.wav"})


class TheCommand(unittest.TestCase):
    def test_it_writes_the_edit_and_prints_the_result_line(self):
        with tempfile.TemporaryDirectory() as folder:
            tmp = Path(folder)
            write_track(tmp / "l.json", 1920, 1080, 960, 540)
            write_track(tmp / "r.json", 1920, 1080, 900, 500)
            (tmp / "spec.json").write_text(json.dumps(base_spec(tmp / "l.json", tmp / "r.json")))
            done = subprocess.run([sys.executable, str(SCRIPT), "--spec", str(tmp / "spec.json"), "--out", str(tmp / "out" / "edit.json")], capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(json.loads(done.stdout.strip().splitlines()[-1]), {"result": {"out": str(tmp / "out" / "edit.json"), "segments": 2}})
            self.assertEqual(len(json.loads((tmp / "out" / "edit.json").read_text())["spine"]["segments"]), 2)

    def test_a_spec_that_is_missing_a_side_says_what_to_check(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "spec.json").write_text(json.dumps({"passes": []}))
            done = subprocess.run([sys.executable, str(SCRIPT), "--spec", str(Path(folder) / "spec.json"), "--out", str(Path(folder) / "o.json")], capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 2)
            self.assertIn("KeyError", json.loads(done.stdout.strip().splitlines()[-1])["error"])
            self.assertFalse((Path(folder) / "o.json").exists())


if __name__ == "__main__":
    unittest.main()

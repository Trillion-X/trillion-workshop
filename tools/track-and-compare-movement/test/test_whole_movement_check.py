"""whole_movement_check.py on made-up inputs: synthetic boxes for the widening rules, and a lavfi video with a moving
white "body" box and a red "racket" box run through the real measure tool (its decoder and framing code) with a stand-in
detector in place of the segmentation model, so no model file and no real footage are needed.

Run: python3 test/test_whole_movement_check.py
"""
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

import importlib.util

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "whole_movement_check.py"
spec = importlib.util.spec_from_file_location("whole_movement_check", SCRIPT)
M = importlib.util.module_from_spec(spec)
sys.modules["whole_movement_check"] = M
spec.loader.exec_module(M)

SOURCE = [640, 360]


def frames(boxes):
    """Frames at 0.2 s steps; each box is the extent, the subject is its left 60 percent."""
    out = []
    for i, box in enumerate(boxes):
        subject = None if box is None else [box[0], box[1], box[0] + (box[2] - box[0]) * 0.6, box[3]]
        out.append({"t": round(i * 0.2, 3), "box": box, "subject": subject})
    return out


def edit_with(crop, layout="h", width=1280, height=720):
    return {"encode": {"width": width, "height": height, "fps": 30},
            "spine": {"segments": [{"id": "full", "kind": "split", "layout": layout,
                                    "sources": [{"source": "a.mp4", "in": 1.0, "out": 2.0, "crop": crop}]}]}}


def fixed_measure(boxes):
    return lambda video, start, end: {"source": SOURCE, "frames": frames(boxes)}


class Widen(unittest.TestCase):
    def test_crop_that_holds_everything_passes_and_is_left_alone(self):
        crop = {"x": 100, "y": 0, "w": 320, "h": 360}
        report = M.check_edit(edit_with(crop), fixed_measure([[150, 50, 300, 300]] * 5))
        self.assertTrue(report["passes"])
        cell = report["cells"][0]
        self.assertEqual((cell["ok"], cell["widened"], cell["refusal"], cell["extent_crossing_frames"]), (True, None, None, 0))
        self.assertEqual(report["fixed_edit"]["spine"]["segments"][0]["sources"][0]["crop"], crop)

    def test_racket_crossing_is_counted_apart_from_the_body(self):
        # extent runs past x=420 (the racket) while the body (left 60 percent) stays inside
        crop = {"x": 100, "y": 0, "w": 320, "h": 360}
        boxes = [[150, 50, 300, 300], [150, 50, 460, 300], [150, 50, 300, 300]]
        cell = M.check_edit(edit_with(crop), fixed_measure(boxes))["cells"][0]
        self.assertEqual((cell["extent_crossing_frames"], cell["subject_crossing_frames"]), (1, 0))
        self.assertEqual(cell["crossing_times"], [1.2])

    def test_widened_crop_has_zero_crossings_aspect_and_stays_in_the_source(self):
        crop = {"x": 100, "y": 60, "w": 160, "h": 180}  # aspect 640/720 * ... cell aspect for h is 640/720
        boxes = [[120, 80, 250, 230], [200, 40, 380, 280], [260, 70, 420, 250]]
        edit = edit_with(crop)
        report = M.check_edit(edit, fixed_measure(boxes))
        cell = report["cells"][0]
        self.assertFalse(cell["ok"])
        wide = cell["widened"]
        self.assertIsNone(cell["refusal"])
        self.assertEqual(M.crossings(frames(boxes), wide)["extent"], [])
        self.assertAlmostEqual(wide["w"] / wide["h"], 640 / 720, delta=0.01)
        self.assertGreaterEqual(wide["x"], 0)
        self.assertGreaterEqual(wide["y"], 0)
        self.assertLessEqual(wide["x"] + wide["w"], SOURCE[0])
        self.assertLessEqual(wide["y"] + wide["h"], SOURCE[1])
        self.assertGreaterEqual(wide["w"], crop["w"])
        self.assertGreaterEqual(wide["h"], crop["h"])
        self.assertEqual(report["fixed_edit"]["spine"]["segments"][0]["sources"][0]["crop"], wide)
        self.assertEqual(edit["spine"]["segments"][0]["sources"][0]["crop"], crop, "the input edit is not changed")

    def test_widened_crop_is_the_smallest_one_that_fits(self):
        # no margin: the movement is 50 wide by 300 tall; at aspect 0.5 the smallest crop is 150 by 300
        crop = {"x": 0, "y": 0, "w": 10, "h": 20}
        boxes = [[100, 50, 150, 350]]
        result = M.widen(crop, 0.5, frames(boxes), SOURCE, 0.0)["crop"]
        self.assertEqual((result["w"], result["h"]), (150, 300))
        self.assertEqual(result["y"], 50)

    def test_a_cell_at_the_source_edge_still_widens_without_leaving_the_frame(self):
        crop = {"x": 0, "y": 0, "w": 100, "h": 100}
        boxes = [[0, 0, 200, 300]]
        wide = M.widen(crop, 1.0, frames(boxes), SOURCE, 0.05)["crop"]
        self.assertEqual((wide["x"], wide["y"]), (0, 0))
        self.assertEqual(M.crossings(frames(boxes), wide)["extent"], [])

    def test_a_movement_wider_than_the_cell_aspect_allows_is_refused(self):
        # needs 620 px wide at aspect 1.0 -> 620 tall, but the source is 360 tall
        crop = {"x": 10, "y": 10, "w": 100, "h": 100}
        result = M.widen(crop, 1.0, frames([[5, 50, 625, 300]]), SOURCE, 0.0)
        self.assertNotIn("crop", result)
        self.assertIn("does not fit", result["refusal"])

    def test_refusal_keeps_the_old_crop_in_the_fixed_edit_and_exits_one(self):
        crop = {"x": 10, "y": 10, "w": 100, "h": 100}
        report = M.check_edit(edit_with(crop, layout="v", width=640, height=640), fixed_measure([[5, 0, 630, 350]]))
        cell = report["cells"][0]
        self.assertFalse(report["passes"])
        self.assertEqual((report["cells_refused"], cell["widened"]), (1, None))
        self.assertEqual(report["fixed_edit"]["spine"]["segments"][0]["sources"][0]["crop"], crop)

    def test_frames_without_a_subject_are_not_counted_as_crossing(self):
        crop = {"x": 100, "y": 0, "w": 320, "h": 360}
        cell = M.check_edit(edit_with(crop), fixed_measure([None, [150, 50, 300, 300], None]))["cells"][0]
        self.assertEqual((cell["ok"], cell["undetected_frames"]), (True, 2))

    def test_a_range_with_no_subject_at_all_and_a_crossing_crop_cannot_arise_but_widen_refuses_it(self):
        self.assertIn("nothing to fit", M.widen({"x": 0, "y": 0, "w": 10, "h": 10}, 1.0, frames([None]), SOURCE, 0.0)["refusal"])

    def test_aspect_comes_from_the_crop_when_the_edit_has_no_encode_or_layout(self):
        edit = {"spine": {"segments": [{"sources": [{"source": "a.mp4", "in": 0, "out": 1, "crop": {"x": 0, "y": 0, "w": 90, "h": 160}}]}]}}
        cell = M.check_edit(edit, fixed_measure([[50, 20, 200, 300]]))["cells"][0]
        self.assertAlmostEqual(cell["widened"]["w"] / cell["widened"]["h"], 90 / 160, delta=0.01)

    def test_measure_runs_once_for_a_repeated_source_range(self):
        seen = []
        two = {"encode": {"width": 1280, "height": 720}, "spine": {"segments": [
            {"id": "a", "layout": "h", "sources": [{"source": "a.mp4", "in": 1, "out": 2, "crop": {"x": 100, "y": 0, "w": 320, "h": 360}}]},
            {"id": "b", "layout": "h", "sources": [{"source": "a.mp4", "in": 1, "out": 2, "crop": {"x": 90, "y": 0, "w": 320, "h": 360}}]}]}}
        cached = M.make_measure({}, Path("unused"), tool=types.SimpleNamespace(measure=lambda request: seen.append(request["video"]) or {
            "source": SOURCE, "shots": [{"frames": frames([[150, 50, 300, 300]])}]}))
        report = M.check_edit(two, cached)
        self.assertEqual(len(report["cells"]), 2)
        self.assertEqual(seen, ["a.mp4"])


class Detector:
    """Stand-in for the segmentation model: white pixels are the body (class 0), red pixels the racket (class 38)."""

    def __init__(self, path):
        self.path = path

    def predict(self, frame, classes, verbose, imgsz, conf):
        import numpy as np
        found = []
        for cls, mask in ((0, (frame[:, :, 0] > 200) & (frame[:, :, 1] > 200) & (frame[:, :, 2] > 200)),
                          (38, (frame[:, :, 2] > 200) & (frame[:, :, 1] < 80))):
            ys, xs = np.nonzero(mask)
            if len(xs):
                found.append((cls, [xs.min(), ys.min(), xs.max() + 1, ys.max() + 1]))

        class Table:
            def __init__(self, values):
                self.values = np.array(values, dtype=float)

            def cpu(self):
                return self

            def numpy(self):
                return self.values

            def __len__(self):
                return len(self.values)

        class Boxes:
            cls = Table([c for c, _ in found])
            xyxy = Table([b for _, b in found])

            def __len__(self):
                return len(found)

        boxes = Boxes()
        return [types.SimpleNamespace(boxes=boxes if found else None)]


class RealMeasureOnLavfiVideo(unittest.TestCase):
    """A white body box (60 by 120) moves right 100 px a second with a red racket box (80 by 20) ahead of it, 2 s at 10 fps, 640 by 360."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.video = str(Path(cls.dir.name) / "moving.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=640x360:d=2:r=10",
                        "-f", "lavfi", "-i", "color=white:s=60x120:d=2:r=10", "-f", "lavfi", "-i", "color=red:s=80x20:d=2:r=10",
                        "-filter_complex", "[0][1]overlay=x='t*100':y=100:eval=frame[a];[a][2]overlay=x='t*100+60':y=120:eval=frame",
                        "-pix_fmt", "yuv420p", cls.video], check=True)
        cls.tool = M.load_measure_tool()
        fake = types.ModuleType("ultralytics")
        fake.YOLO = Detector
        sys.modules["ultralytics"] = fake

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("ultralytics", None)
        cls.dir.cleanup()

    def run_cli(self, crop, extra=()):
        edit_path = Path(self.dir.name) / "edit.json"
        edit_path.write_text(json.dumps({"encode": {"width": 640, "height": 360}, "spine": {"segments": [
            {"id": "full", "layout": "h", "sources": [{"source": self.video, "in": 0.0, "out": 1.0, "crop": crop}]}]}}))
        measure = M.make_measure({"command": "measure", "model": "unused.pt", "subject_class": 0, "implement_class": 38,
                                  "sample_fps": 5, "imgsz": 320, "conf": 0.2, "near_px": 400},
                                 Path(self.dir.name) / "work", tool=self.tool)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = M.main(["--edit", str(edit_path), "--model", "unused.pt", *extra], measure=measure)
        lines = out.getvalue().strip().splitlines()
        self.assertEqual(len(lines), 1, "one result line: " + out.getvalue())
        return code, json.loads(lines[0]), edit_path

    def test_racket_leaving_a_body_only_crop_is_found_and_widened(self):
        # sampled at 0.2 s steps to 0.8 s: the body reaches x 140 and the racket x 220; the crop ends at x 200, so only the racket crosses
        crop = {"x": 0, "y": 60, "w": 200, "h": 225}
        code, line, edit_path = self.run_cli(crop, ["--write-edit", str(Path(self.dir.name) / "fixed.json")])
        cell = line["result"]["cells"][0]
        self.assertGreater(cell["extent_crossing_frames"], 0)
        self.assertEqual(code, 0)
        wide = cell["widened"]
        self.assertEqual(cell["subject_crossing_frames"], 0)
        self.assertEqual(cell["crossing_times"], [0.8])
        self.assertGreaterEqual(wide["x"] + wide["w"], 220)
        fixed = json.loads((Path(self.dir.name) / "fixed.json").read_text())
        self.assertEqual(fixed["spine"]["segments"][0]["sources"][0]["crop"], wide)
        # the widened crop, fed back, passes
        code2, line2, _ = self.run_cli(wide)
        self.assertEqual((code2, line2["result"]["passes"]), (0, True))

    def test_a_crop_holding_the_whole_path_passes(self):
        code, line, _ = self.run_cli({"x": 0, "y": 0, "w": 640, "h": 360})
        self.assertEqual((code, line["result"]["passes"], line["result"]["cells"][0]["undetected_frames"]), (0, True, 0))

    def test_bad_edit_prints_one_error_line(self):
        out = io.StringIO()
        bad = Path(self.dir.name) / "bad.json"
        bad.write_text("{}")
        with contextlib.redirect_stdout(out):
            code = M.main(["--edit", str(bad), "--model", "m.pt"], measure=fixed_measure([]))
        self.assertEqual(code, 2)
        self.assertIn("error", json.loads(out.getvalue()))


if __name__ == "__main__":
    unittest.main()

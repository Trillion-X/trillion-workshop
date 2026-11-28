"""make_matched_clips check: the spec it hands side_by_side.py puts contact where the target's contact is in the first
pass, also when that pass shows the whole swing and is not centred on contact; a fitted cell is compared on the part
its crop is shown in."""
import json
import os
import sys
import tempfile
import unittest

DO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work")
sys.path.insert(0, DO)
import make_matched_clips as m  # noqa: E402

T = {"path": "/t.mp4", "identity": "1f:" + "a" * 64, "people": ["Ada Lane"], "date": "2026-09-10"}
R = {"path": "/r.mp4", "identity": "1f:" + "b" * 64, "people": ["Bo Reyes"], "year": "2019", "class": "forehand"}


class CheckStage(unittest.TestCase):
    def test_contact_sits_where_the_target_reaches_it_in_a_whole_swing_pass(self):
        work = tempfile.mkdtemp()
        for side, clip in (("targets", T), ("references", R)):
            os.makedirs(os.path.join(work, f"{side}-index", "_work"))
            with open(os.path.join(work, f"{side}-index", "_work", f"{m.key(clip)}.kp.json"), "w") as f:
                json.dump({"video": {"fps": 30}}, f)
        crop = {"w": 540, "h": 960, "x": 0, "y": 0}
        fit = {"fill": "blur", "cell": [1080, 960], "inner": {"w": 540, "h": 960, "x": 270, "y": 0}}
        edit = os.path.join(work, "a.edit.json")
        with open(edit, "w") as f:   # the whole swing: 1.4 s before contact, 0.7 s after; the target cell fitted
            json.dump({"spine": {"segments": [{"sources": [{"in": 0.2, "out": 2.4, "crop": crop},
                                                           {"in": 6.3, "out": 8.4, "crop": crop, "fit": fit}]}]}}, f)
        pair = {"target": m.key(T), "reference": m.key(R), "target_peak": 7.6, "reference_peak": 1.0}
        steps = {"contact": {"target": {"time": 7.7}, "reference": {"time": 1.26}}}
        with open(os.path.join(work, "rendered.json"), "w") as f:
            json.dump({"made": [{"file": os.path.join(work, "a.mp4"), "edit": edit, "pair": pair, "steps": steps}]}, f)
        saved = m.run_json
        m.run_json = lambda cmd, env=None: {"result": {"pass": True}}
        try:
            m.check({"work": work, "targets": [T], "references": [R], "movement": "forehand"})
        finally:
            m.run_json = saved
        spec = json.load(open(os.path.join(work, "a.check-spec.json")))
        self.assertAlmostEqual(spec["before_s"], 1.4, places=6)
        self.assertAlmostEqual(spec["after_s"], 0.7, places=6)
        self.assertEqual((spec["bottom"]["contact_frame"], spec["top"]["contact_frame"]), (231, 38))
        self.assertEqual(spec["bottom"]["inner"], [540, 960, 270, 0])     # compared only where its crop is shown
        self.assertNotIn("inner", spec["top"])


if __name__ == "__main__":
    unittest.main()

"""make_matched_clips measure: each perceived clip's swing windows become rows (camera angle, stroke reading, contact,
people, date) and one recording row; a person's mark inside a window is its contact; a clip with rows under the same
fingerprints is read, not measured; a refusal perceive met is kept; and a new mark changes the fingerprint so the clip
is measured again. contact_moment.py and the facts store are stood in for; the pose track and heading are made up."""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))
sys.path.insert(0, HERE)
import make_matched_clips as m  # noqa: E402
import measured_facts  # noqa: E402
from test_stroke_side import RIGHT_FOREHAND_FROM_BEHIND, track  # noqa: E402

T = {"path": "/t.mp4", "identity": "1f:" + "a" * 64, "people": ["Ada Lane"], "date": "2026-09-10", "hand": "right",
     "name": "/a/2026-09-10 back view.mp4"}
R = {"path": "/r.mp4", "identity": "1f:" + "b" * 64, "people": ["Bo Reyes"], "hand": "right", "name": "/b/forehand.mp4"}
WINDOW = {"t0": 0.0, "t1": 1.6, "peak_t": 29 / 30, "full_swing": True,
          "heading": {"traj": RIGHT_FOREHAND_FROM_BEHIND, "conf": [0.9] * 16, "n": 16},
          "elevation": {"value": -0.05, "conf": 0.9}}


class MeasureStage(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.mkdtemp()
        self.job = {"work": self.work, "models": self.work, "targets": [dict(T)], "references": [dict(R)],
                    "contact_audio_lag_s": {"target": 0.05, "reference": 0.09}}
        for side, clip in (("targets", T), ("references", R)):
            os.makedirs(os.path.join(self.work, f"{side}-index", "_work"))
            with open(os.path.join(self.work, f"{side}-index", f"{m.key(clip)}.desc.json"), "w") as f:
                json.dump({"salience_fp": "default", "windows": [WINDOW]}, f)
            with open(m.kp_of(self.job, side, m.key(clip)), "w") as f:
                json.dump(track(850), f)
        self.calls, self.written = [], []
        self.saved = (m.run_json, m.ensure_media, measured_facts.write_rows)
        m.run_json = self.fake_run_json
        m.ensure_media = lambda job, clip: clip["path"]
        measured_facts.write_rows = lambda facts, rows: self.written.extend(rows) or len(rows)

    def tearDown(self):
        m.run_json, m.ensure_media, measured_facts.write_rows = self.saved

    def fake_run_json(self, cmd, env=None, input_text=None):
        self.calls.append(os.path.basename(cmd[1]))
        return {"result": {"time": 0.95, "source": "hit", "hit": {"sound": 0.9}, "why": "the hit's sound less the lag"}}

    def measured(self):
        return m.read(os.path.join(self.work, "measured.json"))

    def test_each_window_is_measured_once_with_its_camera_reading_and_contact(self):
        got = m.measure(self.job)
        self.assertEqual((got["measured"], got["read"], self.calls), (2, 0, ["contact_moment.py"] * 2))
        swing = self.measured()["targets"][m.key(T)]["swings"]["0"]
        self.assertEqual(swing["camera"]["class"], "back")
        self.assertEqual((swing["reading"]["stroke"], swing["reading"]["forehand_side"]), ("forehand", 1))
        self.assertEqual(swing["contact"]["source"], "hit")
        self.assertEqual((swing["people"], swing["date"]), (["Ada Lane"], "2026-09-10"))
        record = self.measured()["targets"][m.key(T)]["recording"]
        self.assertEqual((record["forehand_side"], record["cameras"], record["windows"]), (1, ["back"], 1))
        self.assertEqual(sorted(r["fact"] for r in self.written), ["recording", "recording", "swing", "swing"])

    def test_a_mark_inside_the_window_is_the_contact(self):
        self.job["contact_marks"] = {T["identity"]: [0.9, 12.0]}   # 12.0 is another swing's
        m.measure(self.job)
        swing = self.measured()["targets"][m.key(T)]["swings"]["0"]
        self.assertEqual((swing["contact"]["time"], swing["contact"]["source"]), (0.9, "mark"))
        self.assertEqual(self.calls, ["contact_moment.py"])          # only the reference's

    def test_a_clip_measured_before_is_read_not_measured(self):
        m.measure(self.job)
        with open(os.path.join(self.work, "measured-rows.json"), "w") as f:
            json.dump(self.written, f)
        self.calls, self.written[:] = [], []
        got = m.measure(self.job)
        self.assertEqual((got["measured"], got["read"], self.calls, self.written), (0, 2, [], []))
        self.assertEqual(self.measured()["targets"][m.key(T)]["swings"]["0"]["contact"]["source"], "hit")

    def test_a_new_mark_measures_the_clip_again(self):
        m.measure(self.job)
        with open(os.path.join(self.work, "measured-rows.json"), "w") as f:
            json.dump(self.written, f)
        self.job["contact_marks"] = {T["identity"]: [0.9]}
        self.calls = []
        got = m.measure(self.job)
        self.assertEqual((got["measured"], got["read"]), (1, 1))

    def test_a_changed_rule_measures_again_and_keeps_the_old_rows(self):
        m.measure(self.job)
        old = {r["fingerprint"] for r in self.written if r["fact"] == "swing"}
        with open(os.path.join(self.work, "measured-rows.json"), "w") as f:
            json.dump(self.written, f)
        self.written[:] = []
        self.job["stroke_side_rules"] = {"camera_target_offset_deg": 80}
        got = m.measure(self.job)
        self.assertEqual((got["measured"], got["read"]), (2, 0))
        self.assertTrue({r["fingerprint"] for r in self.written if r["fact"] == "swing"}.isdisjoint(old))  # new rows beside

    def test_a_refusal_perceive_met_is_kept(self):
        self.job["targets"].append({"path": "/x.mp4", "identity": "1f:" + "c" * 64, "seconds": 4.2})
        with open(os.path.join(self.work, "targets-refused.json"), "w") as f:
            json.dump([{"clip": "/x.mp4", "identity": "1f:" + "c" * 64, "why": "no athlete track"}], f)
        got = m.measure(self.job)
        self.assertEqual(got["refused"], 1)
        refusal = next(r for r in self.written if r["fact"] == "perception")
        self.assertEqual(refusal["value"], {"refused": "no athlete track", "duration_s": 4.2})

    def test_the_fingerprint_is_blake3_of_the_canonical_settings(self):
        a, b = measured_facts.fingerprint({"x": 1, "y": [2]}), measured_facts.fingerprint({"y": [2], "x": 1})
        self.assertEqual(a, b)
        self.assertTrue(a.startswith("1f:") and len(a) == 67)
        self.assertNotEqual(a, measured_facts.fingerprint({"x": 2, "y": [2]}))

    def test_marks_come_from_the_rows(self):
        rows = [{"identity": "1f:a", "fact": "contact-mark", "part": "7.758", "fingerprint": "", "value": {"seconds": 7.758}},
                {"identity": "1f:a", "fact": "contact-mark", "part": "1.2", "fingerprint": "", "value": {"seconds": 1.2}},
                {"identity": "1f:a", "fact": "swing", "part": "0", "fingerprint": "f", "value": {}}]
        self.assertEqual(measured_facts.marks_of(rows), {"1f:a": [1.2, 7.758]})


if __name__ == "__main__":
    unittest.main()

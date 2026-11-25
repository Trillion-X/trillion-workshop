"""select_partner's labelled mode on a made-up index: the pose descriptors and the camera gates are stand-ins, and the
certified distances come from a table, so each case pins one rule of the class check."""
import json
import os
import sys
import tempfile
import unittest

MATCH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work", "process-scripts", "match")
sys.path.insert(0, MATCH)
import select_partner as sp  # noqa: E402
import viewpoint_index  # noqa: E402

WINDOW = {"t0": 0.5, "t1": 1.5, "peak_t": 1.0, "quality": 1.0, "full_swing": True, "viewpoint": {"vec": [0, 0, 0, 0]}}


def touch(path):
    with open(path, "w") as f:
        f.write("{}")


class Index:
    def __init__(self, folder, keys):
        self.rows = [(k, 0, os.path.join(folder, f"{k}.desc.json")) for k in keys]
        self.total_windows = len(keys)

    def query(self, _view, _radius):
        return self.rows


class LabelledMatch(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.refs = os.path.join(self.d, "refs")
        os.makedirs(os.path.join(self.refs, "_work"))
        self.target = os.path.join(self.d, "target.desc.json")
        self.target_kp = os.path.join(self.d, "target.kp.json")
        self.write(self.target, "target")
        touch(self.target_kp)
        self.saved = {n: getattr(sp, n) for n in ("_heading_blocks", "_elev_blocks", "_maybe_correspondence")}
        self.saved_mc = (sp.MC.descriptor_at, sp.MC.dist)
        self.saved_index, self.saved_compare = viewpoint_index.get_index, sp.swing_state.compare
        sp._heading_blocks = lambda *a: False
        sp._elev_blocks = lambda *a: False
        sp._maybe_correspondence = lambda: None
        sp.swing_state.compare = lambda a, b: {"channels": {}, "measured": 0, "met": 0, "score": None}
        sp.MC.descriptor_at = lambda kp, *a, **k: os.path.basename(kp).split(".")[0]
        sp.MC.dist = lambda a, b, **k: (self.table[b if a == "target" else a], "direct")

    def tearDown(self):
        for n, f in self.saved.items():
            setattr(sp, n, f)
        sp.MC.descriptor_at, sp.MC.dist = self.saved_mc
        viewpoint_index.get_index, sp.swing_state.compare = self.saved_index, self.saved_compare

    def write(self, path, src):
        with open(path, "w") as f:
            json.dump({"source": {"path": f"/{src}.mp4", "fingerprint": src}, "clip_t0": 0.0, "clip_t1": 2.0,
                       "windows": [WINDOW]}, f)

    def index(self, table):
        """table: {reference key: certified distance to the target}"""
        self.table = table
        for k in table:
            self.write(os.path.join(self.refs, f"{k}.desc.json"), k)
            touch(os.path.join(self.refs, "_work", f"{k}.kp.json"))
        viewpoint_index.get_index = lambda _dir: Index(self.refs, list(table))

    def select(self, labels=None, want="forehand", margin=0.05, admit=0.6):
        extra = {} if labels is None else {"labels": labels, "want": want, "class_margin": margin, "cert_admit": admit}
        return sp.select(self.target, self.target_kp, 0, self.refs, **extra)

    def test_clearly_the_wanted_class_is_admitted_with_its_nearest_partner(self):
        self.index({"fh1": 0.33, "fh2": 0.45, "bh1": 0.52})
        got = self.select({"fh1": "forehand", "fh2": "forehand", "bh1": "backhand"})
        self.assertFalse(got["no_match"])
        self.assertEqual(got["partner_clip"], "/fh1.mp4")
        self.assertEqual(got["class_check"]["other_class"], "backhand")

    def test_every_partner_clears_the_margin_not_only_the_best(self):
        self.index({"fh1": 0.33, "fh2": 0.49, "bh1": 0.52})
        got = self.select({"fh1": "forehand", "fh2": "forehand", "bh1": "backhand"})
        self.assertEqual([p["partner_clip"] for p in got["pairs"]], ["/fh1.mp4"])

    def test_a_window_near_another_class_is_refused(self):
        self.index({"fh1": 0.40, "bh1": 0.42})
        got = self.select({"fh1": "forehand", "bh1": "backhand"})
        self.assertEqual(got["reason"], "not_clearly_the_wanted_class")

    def test_no_contrast_class_in_view_fails_closed(self):
        self.index({"fh1": 0.30, "fh2": 0.35})
        got = self.select({"fh1": "forehand", "fh2": "forehand"})
        self.assertEqual(got["reason"], "no_contrast_class_in_view_family")

    def test_a_contrast_window_beyond_the_bound_still_refuses(self):
        self.index({"fh1": 0.58, "bh1": 0.61})
        self.assertEqual(self.select({"fh1": "forehand", "bh1": "backhand"})["reason"], "not_clearly_the_wanted_class")

    def test_an_unlabelled_reference_is_never_a_partner(self):
        self.index({"x": 0.10, "fh1": 0.33, "bh1": 0.60})
        got = self.select({"fh1": "forehand", "bh1": "backhand"})
        self.assertEqual(got["partner_clip"], "/fh1.mp4")
        self.assertEqual(got["gated_unlabelled"], 1)

    def test_beyond_the_bound_is_no_partner(self):
        self.index({"fh1": 0.70, "bh1": 0.90})
        self.assertEqual(self.select({"fh1": "forehand", "bh1": "backhand"})["reason"],
                         "no_admissible_motion_in_view_family")

    def test_a_run_that_admits_nothing_still_reports_every_class_distance(self):
        self.index({"fh1": 0.33, "fh2": 0.45, "bh1": 0.52, "sl1": 0.47})
        got = self.select({"fh1": "forehand", "fh2": "forehand", "bh1": "backhand", "sl1": "slice"}, admit=0.0)
        self.assertTrue(got["no_match"])
        self.assertEqual(got["class_check"]["same"], 0.33)
        self.assertEqual(got["class_check"]["by_class"], {"backhand": 0.52, "slice": 0.47})
        self.assertEqual(got["class_check"]["other_class"], "slice")

    def test_without_labels_the_label_free_gate_is_unchanged(self):
        self.index({"fh1": 0.33, "bh1": 0.52})
        self.assertEqual(self.select()["reason"], "no_admissible_motion_in_view_family")  # 0.33 > cert_admit 0.22

    def test_bad_labelled_settings_are_refused(self):
        self.index({"fh1": 0.33, "bh1": 0.52})
        labels = {"fh1": "forehand", "bh1": "backhand"}
        for kw in ({"want": "serve"}, {"want": ""}, {"margin": float("nan")}, {"admit": -1}):
            with self.assertRaises(ValueError):
                self.select(labels, **kw)


if __name__ == "__main__":
    unittest.main()

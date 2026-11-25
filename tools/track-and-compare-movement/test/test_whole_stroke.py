"""describe_clip.whole_stroke: a window clamped at a clip edge is a cut stroke unless the rules say the edge is quiet
and contact sits far enough inside. The cases are the shapes measured on a library of tightly cut one-swing clips."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
for copy in ("perception", "match"):
    sys.path.insert(0, os.path.join(HERE, "..", "do-work", "process-scripts", copy))
    sys.modules.pop("describe_clip", None)
    sys.modules.pop("pose_schema", None)
    import describe_clip  # noqa: E402
    globals()[f"dc_{copy}"] = describe_clip
    sys.path.pop(0)

RULES = {"quiet_edge_frac": 0.5, "min_lead_s": 0.7, "min_follow_s": 0.5}
FPS = 30


def signal(start, end, n=75, contact=None):
    """A salience series of n frames: `start` x peak at frame 0, `end` x peak at the last frame, peak 1.0 at contact."""
    s = [0.3] * n
    s[0], s[-1] = start, end
    s[contact if contact is not None else n // 2] = 1.0
    return s


class WholeStroke(unittest.TestCase):
    def run_both(self, sm, lo, hi, peak_t, t0, t1, rules):
        got = set()
        for dc in (dc_perception, dc_match):  # noqa: F821 - set in the import loop
            cfg = dc.salience_config_from_dict(rules)
            got.add(dc.whole_stroke(sm, lo, hi, peak_t, 0.0, (len(sm) - 1) / FPS, t0, t1, cfg))
        self.assertEqual(len(got), 1, "the two describe_clip copies disagree")
        return got.pop()

    def test_an_unclamped_window_is_whole_under_any_rules(self):
        sm = signal(0.1, 0.1)
        for rules in ({}, RULES):
            self.assertTrue(self.run_both(sm, 10, 60, 1.2, 10 / FPS, 60 / FPS, rules))

    def test_rules_off_keep_every_clamped_edge_a_cut(self):
        self.assertFalse(self.run_both(signal(0.1, 0.1), 0, 74, 1.2, 0.0, 74 / FPS, {}))

    def test_quiet_edges_with_contact_well_inside_are_whole(self):
        # measured: edges 0.10 / 0.35 of the peak, contact 1.47 s in and 0.87 s before the end
        self.assertTrue(self.run_both(signal(0.10, 0.35, contact=44), 0, 74, 44 / FPS, 0.0, 74 / FPS, RULES))

    def test_a_stroke_cut_mid_swing_stays_cut(self):
        # measured: the clip starts at 1.0 x the peak, contact 0.03 s in (only the finish is in the clip)
        self.assertFalse(self.run_both(signal(1.0, 0.19, contact=1), 0, 74, 1 / FPS, 0.0, 74 / FPS, RULES))

    def test_a_quiet_start_too_close_to_contact_is_the_load_dip_and_stays_cut(self):
        # measured: start edge 0.22 x the peak but contact only 0.27 s in: the dip between takeback and contact
        self.assertFalse(self.run_both(signal(0.22, 0.29, contact=8), 0, 74, 8 / FPS, 0.0, 74 / FPS, RULES))

    def test_a_loud_end_stays_cut(self):
        # measured: end edge 1.0 x the peak, 0.5 s after contact
        self.assertFalse(self.run_both(signal(0.18, 1.0, contact=59), 20, 74, 59 / FPS, 20 / FPS, 74 / FPS, RULES))

    def test_the_new_rules_are_checked_like_every_salience_knob(self):
        for dc in (dc_perception, dc_match):  # noqa: F821
            with self.assertRaises(ValueError):
                dc.salience_config_from_dict({"quiet_edge_frac": 1.5})
            with self.assertRaises(ValueError):
                dc.salience_config_from_dict({"min_lead_s": -0.1})


if __name__ == "__main__":
    unittest.main()

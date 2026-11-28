"""stroke_side.py on made-up pose tracks and heading trajectories: the takeback side is read in image space from the
fastest wrist whatever its left/right label; the forehand side is given or read from the heading and the playing hand;
the body's turn is read from the heading; and a stroke is called only when both readings agree."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work"))
import stroke_side as s  # noqa: E402
from pose_schema import COCO  # noqa: E402


def track(wrist_x, swinging="r_wrist", n=30):
    """A body 100 px wide at x 500..600; the swinging wrist goes back to wrist_x then whips through to contact."""
    frames = []
    for i in range(n):
        kp = [[550.0, 300.0, 0.9] for _ in COCO]
        for name, x in (("l_shoulder", 500), ("r_shoulder", 600), ("l_hip", 510), ("r_hip", 590)):
            kp[COCO.index(name)] = [float(x), 400.0, 0.9]
        back = i / (n - 8) if i < n - 8 else 1 - (i - (n - 8)) / 8 * 2
        kp[COCO.index(swinging)] = [550 + (wrist_x - 550) * back, 350.0 + (i % 2), 0.9]
        other = "l_wrist" if swinging == "r_wrist" else "r_wrist"
        kp[COCO.index(other)] = [550.0, 380.0, 0.9]
        frames.append({"t": i / 30, "kp": kp})
    return {"persons": [{"track_id": 1, "frames": frames}]}


class StrokeSide(unittest.TestCase):
    def test_a_takeback_to_screen_right_is_positive(self):
        side, wrist = s.takeback_side(track(850), 0.0, 29 / 30)
        self.assertGreater(side, 2)
        self.assertEqual(wrist, "r_wrist")

    def test_the_label_of_the_wrist_does_not_matter(self):
        side, wrist = s.takeback_side(track(850, swinging="l_wrist"), 0.0, 29 / 30)
        self.assertGreater(side, 2)
        self.assertEqual(wrist, "l_wrist")

    def test_the_forehand_side_decides_the_side_reading(self):
        self.assertEqual(s.stroke_of(3.0, 1, 2.0), "forehand")
        self.assertEqual(s.stroke_of(3.0, -1, 2.0), "backhand")
        self.assertEqual(s.stroke_of(-8.25, -1, 2.0), "forehand")

    def test_near_the_middle_is_unclear_and_refused(self):
        self.assertIsNone(s.stroke_of(1.2, 1, 2.0))
        self.assertIsNone(s.stroke_of(None, 1, 2.0))
        self.assertIsNone(s.stroke_of(5.0, 0, 2.0))

    def test_too_few_frames_say_nothing(self):
        self.assertEqual(s.takeback_side(track(850), 0.0, 0.0), (None, None))


# heading trajectories (degrees, 0 = back to the camera) shaped like measured swings: a takeback turn, then the
# forward turn through contact into the follow-through
RIGHT_FOREHAND_FROM_BEHIND = [351, 349, 348, 347, 325, 299, 283, 267, 252, 252, 301, 338, 6, 8, 26, 26]
RIGHT_BACKHAND_FROM_BEHIND = [39, 51, 63, 75, 86, 100, 121, 125, 125, 104, 88, 44, 22, 12, 12, 12]


def turned(traj, by):
    """The same swing seen from a camera `by` degrees round the player."""
    return [(h + by) % 360 for h in traj]


def window(traj):
    return {"t0": 0.0, "t1": 1.6, "peak_t": 29 / 30, "heading": {"traj": traj, "conf": [0.9] * len(traj), "n": len(traj)}}


class ForehandSideAndTurn(unittest.TestCase):
    rules = s.rules_of()

    def test_the_forward_turn_is_from_the_furthest_turned_point_to_the_end(self):
        self.assertEqual(s.forward_turn({"traj": RIGHT_FOREHAND_FROM_BEHIND}), 134.0)
        self.assertEqual(s.forward_turn({"traj": RIGHT_BACKHAND_FROM_BEHIND}), -113.0)

    def test_the_turn_is_the_same_from_every_camera_azimuth(self):
        for by in (0, 45, 90, 135, 180, 225, 270, 315):
            self.assertEqual(s.forward_turn({"traj": turned(RIGHT_FOREHAND_FROM_BEHIND, by)}), 134.0, by)

    def test_the_turn_reads_with_the_playing_hand(self):
        self.assertEqual(s.stroke_by_turn(134.0, "right", self.rules), "forehand")
        self.assertEqual(s.stroke_by_turn(134.0, "left", self.rules), "backhand")
        self.assertEqual(s.stroke_by_turn(-113.0, "right", self.rules), "backhand")
        self.assertIsNone(s.stroke_by_turn(20.0, "right", self.rules))
        self.assertIsNone(s.stroke_by_turn(134.0, None, self.rules))

    def test_the_forehand_side_follows_the_camera_and_the_hand(self):
        self.assertEqual(s.forehand_side_of({"traj": RIGHT_FOREHAND_FROM_BEHIND}, "right", self.rules), 1)
        self.assertEqual(s.forehand_side_of({"traj": RIGHT_FOREHAND_FROM_BEHIND}, "left", self.rules), -1)
        self.assertEqual(s.forehand_side_of({"traj": turned(RIGHT_FOREHAND_FROM_BEHIND, 180)}, "right", self.rules), -1)

    def test_a_camera_at_the_players_side_decides_no_forehand_side(self):
        self.assertIsNone(s.forehand_side_of({"traj": turned(RIGHT_FOREHAND_FROM_BEHIND, 70)}, "right", self.rules))
        self.assertIsNone(s.forehand_side_of({"traj": RIGHT_FOREHAND_FROM_BEHIND}, None, self.rules))
        self.assertIsNone(s.forehand_side_of({"traj": [1.0, float("nan"), 3.0]}, "right", self.rules))

    def test_a_stroke_is_called_only_when_both_readings_agree(self):
        got = s.read_stroke(track(850), window(RIGHT_FOREHAND_FROM_BEHIND), hand="right", rules=self.rules)
        self.assertEqual((got["forehand_side"], got["forehand_side_from"], got["by_side"], got["by_turn"], got["stroke"]),
                         (1, "heading", "forehand", "forehand", "forehand"))
        got = s.read_stroke(track(250), window(RIGHT_FOREHAND_FROM_BEHIND), hand="right", rules=self.rules)
        self.assertEqual((got["by_side"], got["by_turn"], got["stroke"]), ("backhand", "forehand", None))

    def test_seen_from_the_front_the_same_takeback_side_is_the_other_stroke(self):
        got = s.read_stroke(track(250), window(turned(RIGHT_FOREHAND_FROM_BEHIND, 180)), hand="right", rules=self.rules)
        self.assertEqual((got["forehand_side"], got["stroke"]), (-1, "forehand"))

    def test_a_side_view_is_unclear(self):
        got = s.read_stroke(track(850), window(turned(RIGHT_FOREHAND_FROM_BEHIND, 90)), hand="right", rules=self.rules)
        self.assertEqual((got["forehand_side"], got["by_turn"], got["stroke"]), (None, "forehand", None))

    def test_a_window_cut_at_the_clips_edge_gives_no_turn(self):
        cut = {**window(RIGHT_FOREHAND_FROM_BEHIND), "full_swing": False}
        got = s.read_stroke(track(850), cut, hand="right", rules=self.rules)
        self.assertEqual((got["by_side"], got["turn"], got["stroke"]), ("forehand", None, None))

    def test_a_given_forehand_side_overrides_the_heading(self):
        got = s.read_stroke(track(850), window(turned(RIGHT_FOREHAND_FROM_BEHIND, 180)), hand="right", forehand_side=1,
                            rules=self.rules)
        self.assertEqual((got["forehand_side"], got["forehand_side_from"], got["stroke"]), (1, "given", "forehand"))

    def test_a_given_forehand_side_without_a_hand_reads_by_side_alone(self):
        got = s.read_stroke(track(850), {"t0": 0.0, "peak_t": 29 / 30}, forehand_side=-1, rules=self.rules)
        self.assertEqual((got["by_turn"], got["stroke"]), (None, "backhand"))
        self.assertIsNone(s.read_stroke(track(850), {"t0": 0.0, "peak_t": 29 / 30}, rules=self.rules)["stroke"])

    def test_the_camera_angle_is_a_plain_class(self):
        cls = lambda traj, elevation=-0.05: s.camera_of({"heading": {"traj": traj}, "elevation": {"value": elevation, "conf": 0.9}}, self.rules)["class"]  # noqa: E731
        self.assertEqual(cls(RIGHT_FOREHAND_FROM_BEHIND), "back")
        self.assertEqual(cls(turned(RIGHT_FOREHAND_FROM_BEHIND, 180)), "front")
        self.assertEqual(cls(turned(RIGHT_FOREHAND_FROM_BEHIND, 270)), "side-right")   # a right forehand's takeback way
        self.assertEqual(cls(turned(RIGHT_FOREHAND_FROM_BEHIND, 90)), "side-left")
        self.assertEqual(cls(RIGHT_FOREHAND_FROM_BEHIND, elevation=0.02), "birdseye")
        self.assertEqual(s.camera_of({"heading": None}, self.rules)["class"], "unclear")

    def test_an_unclear_stroke_says_why(self):
        got = s.read_stroke(track(850), window(turned(RIGHT_FOREHAND_FROM_BEHIND, 90)), hand="right", rules=self.rules)
        self.assertIn("side", got["why"])
        got = s.read_stroke(track(250), window(RIGHT_FOREHAND_FROM_BEHIND), hand="right", rules=self.rules)
        self.assertEqual(got["why"], "the readings differ: the takeback side says backhand, the turn says forehand")
        got = s.read_stroke(track(850), window(RIGHT_FOREHAND_FROM_BEHIND), hand="right", rules=self.rules)
        self.assertIsNone(got["why"])

    def test_a_job_can_give_its_own_numbers(self):
        self.assertEqual(s.rules_of({"stroke_side_rules": {"turn_min_deg": 200}})["turn_min_deg"], 200)
        self.assertIsNone(s.stroke_by_turn(134.0, "right", s.rules_of({"stroke_side_rules": {"turn_min_deg": 200}})))


if __name__ == "__main__":
    unittest.main()

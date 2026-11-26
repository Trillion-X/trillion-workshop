"""stroke_side.py on made-up pose tracks: the takeback side is read in image space from the fastest wrist whatever
its left/right label, and the stroke follows from the recording's forehand side with a margin."""
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

    def test_the_recordings_forehand_side_decides_the_stroke(self):
        self.assertEqual(s.stroke_of(3.0, 1), "forehand")
        self.assertEqual(s.stroke_of(3.0, -1), "backhand")
        self.assertEqual(s.stroke_of(-8.25, -1), "forehand")

    def test_near_the_middle_is_unclear_and_refused(self):
        self.assertIsNone(s.stroke_of(1.2, 1))
        self.assertIsNone(s.stroke_of(None, 1))
        self.assertIsNone(s.stroke_of(5.0, 0))

    def test_too_few_frames_say_nothing(self):
        self.assertEqual(s.takeback_side(track(850), 0.0, 0.0), (None, None))


if __name__ == "__main__":
    unittest.main()

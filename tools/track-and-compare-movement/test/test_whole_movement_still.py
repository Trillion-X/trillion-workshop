"""whole_movement_check on an edit with a held-frame (still) pass: its cells carry `in` only and are measured on the
short span from that frame, never raising."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work"))
import whole_movement_check as w  # noqa: E402

CROP = {"x": 100, "y": 0, "w": 400, "h": 700}


class StillCells(unittest.TestCase):
    def test_a_still_cell_is_measured_at_its_held_frame(self):
        asked = []

        def measure(video, start, end):
            asked.append((video, start, end))
            return {"frames": [{"t": 0.0, "subject": [150, 50, 450, 650], "implement": None}], "source": [1280, 720]}
        edit = {"encode": {"width": 1080, "height": 1920}, "spine": {"segments": [
            {"id": "full", "layout": "v", "sources": [{"source": "/r.mp4", "in": 1.0, "out": 3.0, "crop": CROP},
                                                      {"source": "/t.mp4", "in": 39.6, "out": 41.6, "crop": CROP}]},
            {"id": "contact-still", "layout": "v", "still": {"duration": 1.5},
             "sources": [{"source": "/r.mp4", "in": 2.0, "crop": CROP}, {"source": "/t.mp4", "in": 40.6, "crop": CROP}]}]}}
        got = w.check_edit(edit, measure)
        self.assertEqual(len(got["cells"]), 4)
        self.assertIn(("/t.mp4", 40.6, 40.6 + w.HELD_SPAN_S), asked)
        self.assertEqual(got["cells"][3]["out"], 40.6 + w.HELD_SPAN_S)


if __name__ == "__main__":
    unittest.main()

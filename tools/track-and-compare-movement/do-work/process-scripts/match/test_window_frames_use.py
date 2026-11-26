"""match/ reads a window's frames through perception/window_frames.py (its one home): heading_for_window hands the model
the frames cv2's seek-and-read gives, in order, on a made-up clip."""
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import body_orientation  # noqa: E402


class HeadingFrames(unittest.TestCase):
    def test_model_gets_the_cv2_frames_in_order(self):
        import cv2
        clip = os.path.join(tempfile.mkdtemp(prefix="match-frames-"), "c.mp4")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=3",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], check=True)
        seen = []
        body_orientation._BUNDLE["b"] = {}
        body_orientation._heading_frame = lambda frame, bundle: seen.append(frame.copy()) or (0.0, 1.0)
        body_orientation.heading_for_window(clip, 0.5, 2.5, frames=4)
        cap = cv2.VideoCapture(clip)
        for got, number in zip(seen, [int(15 + 60 * (k + 0.5) / 4) for k in range(4)]):
            cap.set(cv2.CAP_PROP_POS_FRAMES, number)
            ok, expected = cap.read()
            self.assertTrue(ok and np.array_equal(got, expected), f"frame {number}")
        self.assertEqual(len(seen), 4)


if __name__ == "__main__":
    unittest.main()

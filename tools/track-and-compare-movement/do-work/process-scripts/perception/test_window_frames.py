"""Memory stays bounded by the window, not by the clip (Nov 25 2026: describe_clip on an 11-minute 1080p clip reached
85 GB). Made-up clips only (ffmpeg lavfi); the person-finding model is replaced by a stub, because the growth was in
reading frames, and a model run on the same frames stays flat (measured)."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import tracemalloc
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import body_orientation  # noqa: E402
import describe_clip  # noqa: E402
import window_frames  # noqa: E402

FOLDER = tempfile.mkdtemp(prefix="window-frames-")


def make_clip(name, seconds, size):
    path = os.path.join(FOLDER, name)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"testsrc2=size={size}:rate=30:duration={seconds}", "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", path], check=True)
    return path


def rss_mb():
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())])) / 1024


class WindowFrames(unittest.TestCase):
    def test_frames_equal_the_seek_and_read_pictures(self):
        import cv2
        clip = make_clip("short.mp4", 3, "320x240")
        cap = cv2.VideoCapture(clip)
        numbers = [0, 1, 7, 40, 89]
        got = window_frames.read_frames(clip, numbers)
        for number, frame in zip(numbers, got):
            cap.set(cv2.CAP_PROP_POS_FRAMES, number)
            ok, expected = cap.read()
            self.assertTrue(ok)
            self.assertTrue(np.array_equal(frame, expected), f"frame {number} differs")
        cap.release()

    def test_order_duplicates_and_missing_frames(self):
        clip = make_clip("order.mp4", 2, "160x120")
        a, b, c, d = window_frames.read_frames(clip, [30, 10, 30, 5000])
        self.assertTrue(np.array_equal(a, c))
        self.assertFalse(np.array_equal(a, b))
        self.assertIsNone(d)

    def test_a_rotated_clip_gives_the_turned_picture(self):
        import cv2
        flat = make_clip("flat.mp4", 1, "160x120")
        turned = os.path.join(FOLDER, "turned.mp4")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", flat,
                        "-c", "copy", turned], check=True)
        cap = cv2.VideoCapture(turned)
        cap.set(cv2.CAP_PROP_POS_FRAMES, 4)
        ok, expected = cap.read()
        cap.release()
        self.assertTrue(ok)
        self.assertTrue(np.array_equal(window_frames.read_frames(turned, [4])[0], expected))

    def test_memory_does_not_grow_with_the_number_of_windows(self):
        clip = make_clip("long.mp4", 80, "1920x1080")
        body_orientation._BUNDLE["b"] = {}
        body_orientation._heading_frame = lambda frame, bundle: (0.0, 1.0)
        for number in range(40):  # warm up: first capture, ffmpeg and allocator settling
            body_orientation.heading_for_window(clip, number, number + 1, frames=16)
        before = rss_mb()
        for number in range(40, 100):
            self.assertIsNotNone(body_orientation.heading_for_window(clip, number * 0.75, number * 0.75 + 1, frames=16))
        grown = rss_mb() - before
        self.assertLess(grown, 60, f"60 more windows grew the process by {grown:.0f} MB")

    def test_the_fingerprint_does_not_read_the_whole_recording_into_memory(self):
        path = os.path.join(FOLDER, "big.bin")
        with open(path, "wb") as f:
            f.write(os.urandom(1 << 20) * 40)
        tracemalloc.start()
        got = describe_clip._file_md5(path)
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
        self.assertEqual(got, hashlib.md5(open(path, "rb").read()).hexdigest())
        self.assertLess(peak, 8 << 20, f"peak {peak >> 20} MB")


if __name__ == "__main__":
    unittest.main()

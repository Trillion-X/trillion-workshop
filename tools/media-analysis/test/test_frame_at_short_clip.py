"""frame_at on a short clip whose only key frame is at its start: a sample past that key frame still yields a frame.

The clip is made here with ffmpeg (one key frame, at 0 s), in a temporary folder that is removed after. Needs ffmpeg;
the test is skipped, saying why, when ffmpeg is not on the path.
"""
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "meaning_index.py"
spec = importlib.util.spec_from_file_location("meaning_index", SCRIPT)
mi = importlib.util.module_from_spec(spec)
sys.modules["meaning_index"] = mi
spec.loader.exec_module(mi)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not on the path")
class FrameAtShortClip(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="frame-at-"))
        self.clip = self.folder / "one-key-frame.mp4"
        # 4 s of test pattern with the key frame interval longer than the clip: the only key frame is at 0 s.
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
             "-t", "4", "-g", "1000", "-pix_fmt", "yuv420p", str(self.clip)],
            check=True,
        )

    def tearDown(self):
        shutil.rmtree(self.folder, ignore_errors=True)

    def test_a_sample_past_the_only_key_frame_yields_a_frame(self):
        image = mi.frame_at(str(self.clip), 2.0)
        self.assertIsNotNone(image)
        self.assertEqual(image.size, (mi.FRAME_SIDE, mi.FRAME_SIDE))

    def test_a_sample_at_the_key_frame_still_yields_a_frame(self):
        self.assertIsNotNone(mi.frame_at(str(self.clip), 0.0))

    def test_a_sample_past_the_end_falls_back_to_the_first_frame(self):
        self.assertIsNotNone(mi.frame_at(str(self.clip), 999.0))

    def test_embed_picture_samples_a_short_clip_it_could_not_before(self):
        times = mi.sample_times(4.0, mi.DEFAULT_SAMPLING)
        images = [mi.frame_at(str(self.clip), t) for t in times]
        self.assertTrue(any(image is not None for image in images))


if __name__ == "__main__":
    unittest.main()

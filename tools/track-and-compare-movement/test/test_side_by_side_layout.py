"""side_by_side.py check reads a side-by-side clip (layout "h", left / right cells) as well as a stacked one. The clip
is two made-up ffmpeg test patterns put next to each other, each cell its whole source, contacts on one frame."""
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "side_by_side.py"
spec = importlib.util.spec_from_file_location("side_by_side_layout_under_test", SCRIPT)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

W, H, FPS = 160, 240, 30


def side(path, mirror=False):
    return {"source": path, "fps": FPS, "contact_frame": 30, "crop": [W, H, 0, 0], "mirror": mirror, "stroke": "forehand",
            "hand": "right", "camera": "behind", "stroke_seen": "frames looked at"}


class SideBySideLayout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        d = Path(tempfile.mkdtemp())
        cls.a, cls.b, cls.clip = str(d / "a.mp4"), str(d / "b.mp4"), str(d / "ab.mp4")
        for path, pattern in ((cls.a, "testsrc"), (cls.b, "testsrc2")):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"{pattern}=size={W}x{H}:rate={FPS}:duration=2",
                            "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", path], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", cls.a, "-i", cls.b, "-filter_complex",
                        "[0:v][1:v]hstack=2,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "12", cls.clip],
                       check=True)

    def check(self, layout):
        sp = {"top": side(self.a), "bottom": side(self.b), "cell": [W, H], "fps": FPS, "before_s": 1.0, "after_s": 0.9}
        if layout:
            sp["layout"] = layout
        return M.check(sp, self.clip)

    def test_a_side_by_side_clip_passes_when_read_left_and_right(self):
        got = self.check("h")
        self.assertTrue(got["checks"]["is-a-comparison"]["pass"], got)
        self.assertTrue(got["checks"]["contact-in-sync"]["pass"], got)

    def test_read_as_stacked_it_does_not_match(self):
        self.assertFalse(self.check(None)["checks"]["is-a-comparison"]["pass"])


if __name__ == "__main__":
    unittest.main()

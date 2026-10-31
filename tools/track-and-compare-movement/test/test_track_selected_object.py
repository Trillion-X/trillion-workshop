"""track_selected_object.py: its refusals, and (when ffmpeg, torch, transformers and the small SAM 2 model are in the
local cache) a real run on a made-up video of a white square moving across black."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "track_selected_object.py"
MODEL = "facebook/sam2.1-hiera-tiny"


def run(*args):
    done = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=900)
    lines = done.stdout.strip().splitlines()
    return done, (json.loads(lines[-1]) if lines else None)


def ask(folder, **override):
    values = {"video": str(Path(folder) / "none.mp4"), "output": str(Path(folder) / "out"), "start": "0", "end": "2", "time": "1",
              "points": json.dumps([{"x": 0.5, "y": 0.5, "include": True}]), "fps": "12", "model": MODEL}
    values.update(override)
    return [item for key, value in values.items() for item in (f"--{key}", str(value))]


class TheRefusals(unittest.TestCase):
    def check(self, message_part, **override):
        with tempfile.TemporaryDirectory() as folder:
            done, answer = run(*ask(folder, **override))
            self.assertEqual(done.returncode, 2, done.stderr)
            self.assertIn(message_part, answer["error"])
            self.assertFalse((Path(folder) / "out").exists())             # nothing was made

    def test_a_range_over_thirty_seconds(self):
        self.check("up to 30 seconds", end="45")

    def test_a_selected_time_outside_the_range(self):
        self.check("containing the selected frame", time="3")

    def test_a_frame_rate_outside_one_to_thirty(self):
        self.check("containing the selected frame", fps="60")

    def test_no_point_inside_the_object(self):
        self.check("at least one point inside", points=json.dumps([{"x": 0.5, "y": 0.5, "include": False}]))

    def test_a_point_outside_the_picture(self):
        self.check("points inside the picture", points=json.dumps([{"x": 1.5, "y": 0.5, "include": True}]))

    def test_an_output_folder_that_already_exists(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "out").mkdir()
            done, answer = run(*ask(folder))
            self.assertEqual(done.returncode, 2)
            self.assertIn("must be new", answer["error"])


def ready():
    hub = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub"
    packages = all(importlib.util.find_spec(name) for name in ("torch", "transformers", "PIL", "numpy"))
    return packages and (hub / "models--facebook--sam2.1-hiera-tiny").exists() and subprocess.run(["ffmpeg", "-version"], capture_output=True).returncode == 0


@unittest.skipUnless(ready(), "needs ffmpeg, torch, transformers, pillow and the facebook/sam2.1-hiera-tiny model in the local Hugging Face cache")
class TheRealModel(unittest.TestCase):
    def test_the_square_is_followed_forwards_and_backwards_from_the_selected_frame(self):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / "square.mp4"
            made = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=12:d=3", "-f", "lavfi", "-i", "color=c=white:s=60x60:r=12:d=3",
                                   "-filter_complex", "[0][1]overlay=x='20+t*60':y=90", "-pix_fmt", "yuv420p", str(video)], capture_output=True, text=True)
            self.assertEqual(made.returncode, 0, made.stderr)
            points = json.dumps([{"x": 110 / 320, "y": 120 / 240, "include": True}, {"x": 0.9, "y": 0.1, "include": False}])
            done, answer = run("--video", str(video), "--output", str(Path(folder) / "out"), "--start", "0", "--end", "3", "--time", "1", "--points", points,
                               "--fps", "12", "--model", MODEL, "--device", "cpu")
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            result = answer["result"]
            self.assertEqual((result["frames"], result["selected_frame"], result["model"]), (36, 12, MODEL))
            pixels = result["pixels"]
            area = 3600 * (result["width"] / 320) ** 2                    # the 60 x 60 square, at the masks' own size
            self.assertGreater(pixels[12], 0.8 * area)
            self.assertLess(pixels[12], 1.3 * area)
            self.assertGreater(sum(1 for count in pixels if count > 0.5 * area), 24)   # it is followed across most of the clip
            out = Path(folder) / "out"
            self.assertTrue((out / "mask.mkv").exists())
            self.assertEqual(len(list((out / "masks").glob("*.png"))), 36)
            self.assertEqual(json.loads((out / "result.json").read_text())["pixels"], pixels)
            self.assertFalse((out / "source-frames").exists())            # the disposable frames are gone


if __name__ == "__main__":
    unittest.main()

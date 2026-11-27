"""A synced comparison rendered for real: made-up swings -> phase_sync.py -> author_comparison_edl.py -> the
media-composition renderer (render-an-edit.mjs), read back frame by frame.

Each test video is a grey whose brightness is its own frame number, so the frame each cell shows can be read from the
rendered picture, with a moving bar so smooth slow motion has motion to make in-between frames of. The reference is played through the sync's speed ramp; at every output frame of the 1x
pass the reference must show the source second the sync names (within 1.5 output frames, see that test), the target must play as
recorded, and every pass must come out exactly as many frames long as planned. Skips, saying why, without ffmpeg or node.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import importlib.util

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent.parent
RENDER = TOOLS / "media-composition" / "do-work" / "render-an-edit.mjs"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


SWINGS = load("test_phase_sync", HERE / "test_phase_sync.py")
AUTHOR = load("author_comparison_edl", HERE.parent / "do-work" / "author_comparison_edl.py")
FPS = 30
WIDTH, HEIGHT = 360, 640                      # 9:16, stacked: the reference cell on top, the target below
STEP = 2.5                                   # grey levels per frame, so one frame is told from the next


def numbered_video(path, seconds, first_frame):
    """A grey video whose brightness says its frame number (from `first_frame` up) and whose white bar near the top
    moves 6 pixels a frame, at the size of the made-up pose tracks."""
    grey = f"clip(16+(N-{first_frame})*{STEP}\\,16\\,235)"
    bar = "between(Y\\,20\\,40)*between(X\\,mod(N*6\\,360)\\,mod(N*6\\,360)+24)"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=gray:s=400x400:r={FPS}:d={seconds}",
                    "-vf", f"geq=lum='if({bar}\\,250\\,{grey})':cb=128:cr=128", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", str(path)], check=True)


def grey_patch(video, y):
    """The mean grey of a 16x16 patch centred at (middle, y) in every frame of `video`."""
    width = int(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width", "-of", "csv=p=0", str(video)],
                               check=True, capture_output=True, text=True).stdout.strip())
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video), "-vf", f"crop=16:16:{width // 2 - 8}:{y - 8},format=gray",
                          "-f", "rawvideo", "-"], check=True, capture_output=True).stdout
    return [sum(raw[i:i + 256]) / 256 for i in range(0, len(raw), 256)]


def frame_reader(source):
    """Grey -> source frame number, read off the source video itself (so the grey levels need no assumption)."""
    levels = grey_patch(source, 200)
    def frame_of(grey):
        for n in range(len(levels) - 1):
            low, high = levels[n], levels[n + 1]
            if low <= grey <= high and high > low:
                return n + (grey - low) / (high - low)
        return min(range(len(levels)), key=lambda n: abs(levels[n] - grey))
    return frame_of


def shown_frames(video, top, frame_of):
    """The source frame number each output frame shows in one cell (read in the cell's middle)."""
    return [frame_of(grey) for grey in grey_patch(video, HEIGHT // 4 if top else 3 * HEIGHT // 4)]


def bar_positions(video, top):
    """Where the moving bar is (the mean x of its bright pixels) in each output frame of one cell."""
    y = 18 if top else HEIGHT // 2 + 18
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video), "-vf", f"crop={WIDTH}:4:0:{y},format=gray",
                          "-f", "rawvideo", "-"], check=True, capture_output=True).stdout
    size = WIDTH * 4
    positions = []
    for start in range(0, len(raw), size):
        row = raw[start:start + size]
        bright = [i % WIDTH for i, value in enumerate(row) if value > 200]
        positions.append(sum(bright) / len(bright) if bright else None)
    return positions


def frame_count(video):
    done = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames",
                           "-of", "csv=p=0", str(video)], check=True, capture_output=True, text=True)
    return int(done.stdout.strip())


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe") and shutil.which("node"), "ffmpeg, ffprobe and node are needed")
class TheRenderedSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        tmp = Path(cls.folder.name)
        swing = {**SWINGS.write_pair(tmp), "settings": SWINGS.LANDMARKS_ONLY}  # the renderer's fidelity to known pieces
        cls.sync = SWINGS.M.phase_sync(swing)
        numbered_video(tmp / "target.mp4", 3, 25)
        numbered_video(tmp / "reference.mp4", 8, 145)
        cls.target_frame = staticmethod(frame_reader(tmp / "target.mp4"))
        cls.reference_frame = staticmethod(frame_reader(tmp / "reference.mp4"))
        cls.passes = [{"id": "full", "half": 0.6}, {"id": "slow", "half": 0.2, "speed": 0.25, "smooth": True}, {"id": "contact", "still": 0.5}]
        spec = {"encode": {"width": WIDTH, "height": HEIGHT, "fps": FPS, "crf": 1, "preset": "ultrafast"}, "layout": "v",
                "left": {"clip": str(tmp / "reference.mp4"), "kp": swing["reference"]["kp"], "peak": SWINGS.CONTACT_REFERENCE, "sync": cls.sync},
                "right": {"clip": str(tmp / "target.mp4"), "kp": swing["target"]["kp"], "peak": SWINGS.CONTACT_TARGET},
                "passes": cls.passes}
        cls.edl = AUTHOR.build_edl(spec, {str(tmp / "reference.mp4"): 8.0, str(tmp / "target.mp4"): 3.0})
        cls.pieces = []
        for segment in cls.edl["spine"]["segments"]:
            one = {**cls.edl, "spine": {"segments": [segment]}}
            out = tmp / f"{segment['id']}.mp4"
            done = subprocess.run(["node", str(RENDER), "--edl", json.dumps(one), "--output", str(out), "--workdir", str(tmp)], capture_output=True, text=True, timeout=600)
            if done.returncode != 0:
                raise AssertionError(done.stdout + done.stderr)
            cls.pieces.append((segment, out, json.loads(done.stdout.strip().splitlines()[-1])))
        whole = tmp / "whole.mp4"
        done = subprocess.run(["node", str(RENDER), "--edl", json.dumps(cls.edl), "--output", str(whole), "--workdir", str(tmp)], capture_output=True, text=True, timeout=600)
        if done.returncode != 0:
            raise AssertionError(done.stdout + done.stderr)
        cls.whole = (whole, json.loads(done.stdout.strip().splitlines()[-1]))

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def test_every_pass_is_exactly_as_many_frames_as_planned(self):
        planned = {"full": 36, "slow": 48, "contact": 15}         # 1.2 s at 1x, 0.4 s at 0.25x, a 0.5 s hold
        for segment, out, measured in self.pieces:
            self.assertEqual(frame_count(out), planned[segment["id"]], segment["id"])
            self.assertAlmostEqual(measured["duration_seconds"], planned[segment["id"]] / FPS, delta=1 / FPS + 0.07)
        whole, measured = self.whole
        self.assertEqual(frame_count(whole), sum(planned.values()))
        self.assertEqual((measured["width"], measured["height"]), (WIDTH, HEIGHT))

    def test_at_1x_the_reference_shows_the_synced_second_and_the_target_plays_as_recorded(self):
        segment, out, _ = self.pieces[0]
        reference, target = segment["sources"]
        tops, bottoms = shown_frames(out, True, self.reference_frame), shown_frames(out, False, self.target_frame)
        for frame, (top, bottom) in enumerate(zip(tops, bottoms)):
            self.assertLessEqual(abs(bottom - (target["in"] * FPS + frame)), 1.0, (frame, bottom))
            wanted = SWINGS.M.reference_second(self.sync, target["in"] + frame / FPS)
            plays = target["in"] + frame / FPS - self.sync["target"]["in"]
            speed = next((p["speed"] for p in self.sync["pieces"] if p["plays_from"] - 1e-9 <= plays < p["plays_to"] - 1e-9), self.sync["pieces"][-1]["speed"])
            # How many OUTPUT frames early or late the reference is: its source frames off, divided by its speed. The
            # renderer starts a cell at the first source frame at or after its `in` (ffmpeg's accurate seek drops the
            # frame on screen at `in`), so an `in` between two frames can show the reference up to one source frame
            # early on top of the fps filter's half-frame rounding: 1.5 output frames, not 1 (measured 1.39 at 0.96x).
            self.assertLessEqual(abs(top - wanted * FPS) / speed, 1.5, (frame, top, wanted * FPS, speed))

    def test_contact_meets_contact_and_the_still_holds_both_contacts(self):
        segment, out, _ = self.pieces[0]
        at_contact = round((SWINGS.CONTACT_TARGET - segment["sources"][1]["in"]) * FPS)
        self.assertLessEqual(abs(shown_frames(out, True, self.reference_frame)[at_contact] - SWINGS.CONTACT_REFERENCE * FPS), 1.0)
        self.assertLessEqual(abs(shown_frames(out, False, self.target_frame)[at_contact] - SWINGS.CONTACT_TARGET * FPS), 1.0)
        _, held, _ = self.pieces[2]
        self.assertTrue(all(abs(top - SWINGS.CONTACT_REFERENCE * FPS) <= 0.5 for top in shown_frames(held, True, self.reference_frame)))
        self.assertTrue(all(abs(bottom - SWINGS.CONTACT_TARGET * FPS) <= 0.5 for bottom in shown_frames(held, False, self.target_frame)))

    def test_smooth_slow_motion_makes_in_between_frames_instead_of_repeating_them(self):
        _, out, _ = self.pieces[1]
        for top in (True, False):
            moves = [b - a for a, b in zip(bar_positions(out, top), bar_positions(out, top)[1:]) if a is not None and b is not None]
            # At 0.25x a repeated frame leaves the bar still for three frames in four; made in-between frames move it every frame.
            still = sum(1 for move in moves if abs(move) < 0.25)
            self.assertLess(still, len(moves) // 4, (top, moves))

if __name__ == "__main__":
    unittest.main()

"""contact_moment on made-up clips: a test pattern plus a short noise click at a known second (the hit), and one clip
with no audio. A hit within one frame of the click is found; a click far from the wrist peak is ignored; no audio and
a failing finder fall back to the wrist peak."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))
import contact_moment as cm  # noqa: E402

MEDIA = os.environ.get("MEDIA_COMPOSITION_DIR") or os.path.join(HERE, "..", "..", "media-composition")
FPS = 30
CLICK_AT = 2.0


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


class ContactMoment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="contact-moment-")
        pattern = ["-f", "lavfi", "-i", f"testsrc=size=160x120:rate={FPS}:duration=4"]
        cls.with_click = os.path.join(cls.dir, "click.mp4")
        # quiet bed of very low noise, one 40 ms loud burst at CLICK_AT
        audio = (f"anoisesrc=color=white:amplitude=0.002:duration=4:sample_rate=44100[n];sine=frequency=1800:duration=0.04:sample_rate=44100,volume=1,"
                 f"adelay={int(CLICK_AT * 1000)}|{int(CLICK_AT * 1000)},apad=whole_dur=4[b];[n][b]amix=inputs=2:duration=longest:normalize=0[a]")
        ffmpeg(*pattern, "-filter_complex", audio, "-map", "0:v", "-map", "[a]", "-t", "4",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", cls.with_click)
        cls.silent = os.path.join(cls.dir, "silent.mp4")
        ffmpeg(*pattern, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", cls.silent)

    def test_hit_found_within_one_frame_of_the_click(self):
        got = cm.contact(self.with_click, 0.5, 3.5, CLICK_AT - 0.1, MEDIA)
        self.assertEqual(got["source"], "hit", got)
        self.assertLessEqual(abs(got["time"] - CLICK_AT), 1 / FPS, got)
        self.assertIsNotNone(got["hit"])
        self.assertTrue(0.5 <= got["time"] <= 3.5)

    def test_the_recordings_audio_lag_is_taken_off_the_sound(self):
        got = cm.contact(self.with_click, 0.5, 3.5, CLICK_AT - 0.1, MEDIA, audio_lag_s=0.09)
        self.assertEqual(got["source"], "hit", got)
        self.assertLessEqual(abs(got["time"] - (CLICK_AT - 0.09)), 1.0 / FPS, got)
        self.assertLessEqual(abs(got["hit"]["time"] - CLICK_AT), 1.0 / FPS, got)

    def test_far_click_is_ignored(self):
        got = cm.contact(self.with_click, 0.5, 3.5, 0.8, MEDIA)
        self.assertEqual(got["source"], "wrist", got)
        self.assertEqual(got["time"], 0.8)
        self.assertIsNone(got["hit"])
        self.assertIn("tolerance", got["why"])

    def test_no_audio_falls_back_to_wrist(self):
        got = cm.contact(self.silent, 0.5, 3.5, 2.0, MEDIA)
        self.assertEqual(got["source"], "wrist", got)
        self.assertEqual(got["time"], 2.0)
        self.assertIn("no sharp sound", got["why"])

    def test_wrist_peak_outside_window_is_clamped(self):
        got = cm.contact(self.silent, 0.5, 3.5, 9.0, MEDIA)
        self.assertEqual(got["time"], 3.5)

    def test_missing_finder_is_refused_by_name(self):
        with self.assertRaises(FileNotFoundError):
            cm.contact(self.with_click, 0.5, 3.5, 2.0, self.dir)

    def test_cli_prints_one_result_line(self):
        ran = subprocess.run([sys.executable, os.path.join(HERE, "..", "do-work", "contact_moment.py"), "--clip", self.with_click,
                              "--t0", "0.5", "--t1", "3.5", "--wrist-peak", "1.95", "--media-composition", MEDIA],
                             capture_output=True, text=True, check=True)
        out = json.loads(ran.stdout.strip().splitlines()[-1])
        self.assertEqual(out["result"]["source"], "hit")

    def test_cli_error_line(self):
        ran = subprocess.run([sys.executable, os.path.join(HERE, "..", "do-work", "contact_moment.py"), "--clip", self.silent,
                              "--t0", "3", "--t1", "1", "--wrist-peak", "2", "--media-composition", MEDIA],
                             capture_output=True, text=True)
        self.assertEqual(ran.returncode, 1)
        self.assertIn("error", json.loads(ran.stdout.strip().splitlines()[-1]))


if __name__ == "__main__":
    unittest.main()

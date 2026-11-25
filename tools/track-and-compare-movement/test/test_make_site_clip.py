"""make_site_clip.py: the cut and encode it asks ffmpeg for, the place input it answers, and a real cut on a made-up video.

The Files road is replaced by a stand-in that checks the bytes it is asked to keep; no engine and no account are used.
"""
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "make_site_clip.py"
spec = importlib.util.spec_from_file_location("make_site_clip", SCRIPT)
M = importlib.util.module_from_spec(spec)
sys.modules["make_site_clip"] = M
spec.loader.exec_module(M)


class CutAndEncode(unittest.TestCase):
    def test_stretches_join_in_order_with_and_without_sound(self):
        with_sound = M.cut_filter([[0, 1], [2.5, 3]], True)
        self.assertIn("[0:v]trim=start=0:end=1,setpts=PTS-STARTPTS[v0]", with_sound)
        self.assertIn("[0:a]atrim=start=2.5:end=3,asetpts=PTS-STARTPTS[a1]", with_sound)
        self.assertTrue(with_sound.endswith("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"))
        silent = M.cut_filter([[0, 1]], False)
        self.assertNotIn("[0:a]", silent)
        self.assertTrue(silent.endswith("[v0]concat=n=1:v=1:a=0[v]"))

    def test_a_stretch_that_runs_backward_is_refused(self):
        with self.assertRaises(ValueError):
            M.cut_filter([[3, 2]], False)

    def test_sound_is_left_out_unless_asked(self):
        self.assertFalse(M.ENCODE["sound"])
        args = M.encode_args(None, M.ENCODE, False)
        self.assertIn("-an", args)
        self.assertNotIn("0:a:0", args)
        self.assertEqual(args[args.index("-crf") + 1], "18")

    def test_place_input_names_the_material_the_fence_reads(self):
        clip = {"piece": "site-clip:x", "stills": {"cover": {"at": 1}}, "extra": {"kind": "reel", "aspect": "9x16"}}
        place = M.place_input(clip, "1f:" + "a" * 64)
        self.assertEqual(place["material"], "recording/1f:" + "a" * 64)
        self.assertEqual(place["value"], {"material": "recording/1f:" + "a" * 64, "piece": "site-clip:x"})
        self.assertEqual(place["extra"]["kind"], "reel")

    def test_a_clip_or_still_without_a_why_is_refused(self):
        clip = {"piece": "site-clip:x", "stills": {"left": {"at": 1, "why": "the first day"}, "right": {"at": 2}},
                "extra": {"why": "a transformation"}}
        with self.assertRaisesRegex(ValueError, "still right has no why"):
            M.make(clip, "unused", ["no-engine"], M.ENCODE)
        with self.assertRaisesRegex(ValueError, "extra.why is missing"):
            M.make(dict(clip, stills={}, extra={}), "unused", ["no-engine"], M.ENCODE)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("b3sum"), "needs ffmpeg and b3sum")
class RealCut(unittest.TestCase):
    def test_a_made_up_video_is_cut_silent_and_kept_by_its_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = folder / "source.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=108x192:rate=24:duration=4",
                            "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-pix_fmt", "yuv420p", str(source)], check=True)
            identity = M.files_road.blake3_identity(str(source))
            kept = {}

            def keep(call, path, name, media_type):
                kept[name] = M.files_road.blake3_identity(path)
                return kept[name]

            original = M.files_road.keep
            M.files_road.keep = keep
            try:
                made = M.make({"piece": "site-clip:made-up", "source": {"identity": identity, "local": str(source)},
                               "keep": [[0.5, 1.5], [2, 3]], "files_name": "/Exports/made-up.mp4",
                               "stills": {"cover": {"at": 0.5, "why": "the contact frame"}},
                               "extra": {"kind": "reel", "why": "a made-up clip"}}, str(folder), ["no-engine"], M.ENCODE)
            finally:
                M.files_road.keep = original
            probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
                                               "-of", "json", made["local"]], capture_output=True, text=True, check=True).stdout)
            self.assertEqual([s["codec_type"] for s in probe["streams"]], ["video"])
            self.assertAlmostEqual(float(probe["format"]["duration"]), 2.0, delta=0.1)
            self.assertEqual(kept["/Exports/made-up.mp4"], made["identity"])
            self.assertEqual(made["place"]["material"], "recording/" + made["identity"])

    def test_bytes_that_are_not_the_named_identity_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.mp4"
            source.write_bytes(b"not the clip")
            with self.assertRaises(RuntimeError):
                M.make({"piece": "site-clip:wrong", "source": {"identity": "1f:" + "0" * 64, "local": str(source)},
                        "files_name": "/x.mp4", "stills": {}, "extra": {"why": "a made-up clip"}}, folder, ["no-engine"], M.ENCODE)


if __name__ == "__main__":
    unittest.main()

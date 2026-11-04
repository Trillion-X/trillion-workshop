"""probe_duration in do-work/audio_transcription.py: when ffprobe cannot start (a computer run is granted only ffmpeg and
whisper-cli), the length is read from the ffmpeg the person gave; with no ffmpeg given the failure stands."""
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work"))
import audio_transcription as seam  # noqa: E402


class ProbeDurationTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.path = os.environ.get("PATH", "")
        os.environ["PATH"] = self.folder  # no ffprobe here
        self.ffmpeg = os.path.join(self.folder, "granted-ffmpeg")
        with open(self.ffmpeg, "w") as handle:
            handle.write("#!/bin/sh\necho '  Duration: 01:02:03.50, start: 0.000000, bitrate: 64 kb/s' >&2\nexit 1\n")
        os.chmod(self.ffmpeg, stat.S_IRWXU)

    def tearDown(self):
        os.environ["PATH"] = self.path

    def test_length_from_the_granted_ffmpeg(self):
        self.assertEqual(seam.probe_duration("a.wav", self.ffmpeg), 3723.5)

    def test_no_ffmpeg_given_keeps_the_failure(self):
        with self.assertRaises(OSError):
            seam.probe_duration("a.wav")


if __name__ == "__main__":
    unittest.main()

"""Media probe guards used before a clip can be classified as sound-only."""
import json
import sys
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / 'do-work'), str(HERE.parent / 'read-data')]

import media  # noqa: E402
from fill import Refused  # noqa: E402


class MediaProbe(unittest.TestCase):
    def test_failed_ffprobe_with_partial_audio_json_refuses_instead_of_looking_sound_only(self):
        partial = json.dumps({'streams': [{'codec_type': 'audio'}]})
        failed = CompletedProcess(['ffprobe'], 1, partial, 'missing input')
        with patch('media.subprocess.run', return_value=failed):
            with self.assertRaisesRegex(Refused, r'ffprobe failed for missing-source\.mp4 \(1\): missing input'):
                media.has_picture('missing-source.mp4')

    def test_successful_audio_only_probe_still_allows_sound_only_media(self):
        audio = CompletedProcess(['ffprobe'], 0, json.dumps({'streams': [{'codec_type': 'audio'}]}), '')
        with patch('media.subprocess.run', return_value=audio):
            self.assertFalse(media.has_picture('voice-only.wav'))

    def test_successful_video_probe_still_reports_picture(self):
        video = CompletedProcess(['ffprobe'], 0, json.dumps({'streams': [
            {'codec_type': 'video', 'disposition': {'attached_pic': 0}},
        ]}), '')
        with patch('media.subprocess.run', return_value=video):
            self.assertTrue(media.has_picture('source-video.mp4'))


if __name__ == '__main__':
    unittest.main()

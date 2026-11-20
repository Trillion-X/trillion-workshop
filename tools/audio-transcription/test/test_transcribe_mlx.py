# tools/audio-transcription/test/test_transcribe_mlx.py
# Run: python3 -m unittest tools/audio-transcription/test/test_transcribe_mlx.py
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))
sys.modules.setdefault("whisper_here", types.SimpleNamespace(transcribe=lambda *a, **k: {}))

import transcribe_mlx  # noqa: E402


class Shape(unittest.TestCase):
    def test_untimed_words_and_segments_are_dropped(self):
        heard = {
            "text": " Hi there ",
            "language": "en",
            "engine": "mlx_whisper",
            "segments": [
                {"start": 0.0, "end": 1.0, "text": " Hi there ", "words": [
                    {"word": " Hi", "start": 0.0, "end": 0.4},
                    {"word": " there", "start": None, "end": 0.9},
                    {"word": " there", "start": 0.5, "end": float("inf")},
                ]},
                {"start": "0", "end": 2.0, "text": "lost", "words": []},
            ],
        }
        answer = transcribe_mlx.shape(heard)
        self.assertEqual(answer["full_text"], "Hi there")
        self.assertEqual(answer["engine"], "mlx_whisper")
        self.assertEqual(len(answer["segments"]), 1)
        self.assertEqual([w["word"] for w in answer["segments"][0]["words"]], ["Hi"])


if __name__ == "__main__":
    unittest.main()

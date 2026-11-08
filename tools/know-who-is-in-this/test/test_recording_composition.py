"""Exercise the real composition with explicit model stand-ins; no model or person is contacted."""
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


who = load("recording_composition", ROOT / "do-work/who-is-in-this.py")
measure = load("recording_measure", ROOT / "do-work/measure.py")


class RecordingComposition(unittest.TestCase):
    def setUp(self):
        self.segments = [{"start": 1.25, "end": 4.75, "text": "Actual adapter words."}]
        self.vector = [1.0] + [0.0] * 191
        self.measuring = SimpleNamespace(transcript_segments=Mock(return_value=self.segments),
                                         voice_vectors=Mock(return_value=[self.vector]))
        self.modules = patch.dict(sys.modules, {"measure": self.measuring})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def test_file_only_uses_heard_times_words_and_keeps_unknown_session(self):
        result = who.analyse({"file": "recording.mp4", "max_seconds": 60, "listening": "call"})
        self.measuring.transcript_segments.assert_called_once_with("recording.mp4", 60)
        self.measuring.voice_vectors.assert_called_once_with("recording.mp4", self.segments, 60)
        self.assertEqual([(turn["start"], turn["end"], turn["text"]) for turn in result["speakers"]],
                         [(1.25, 4.75, "Actual adapter words.")])
        self.assertEqual(result["voices_heard"], ["voice-1"])
        self.assertEqual(result["records"][0]["listening"], "call")
        self.assertFalse(result["speakers"][0]["me"])

    def test_supplied_transcript_bypasses_hearing_and_keeps_naming(self):
        person = {"id": "voice-print:ann", "person": "person:ann", "name": "Ann", "me": True, "samples": [self.vector]}
        result = who.analyse({"file": "recording.wav", "segments": self.segments,
                              "voice_prints": [{"payload": person}], "max_seconds": 90})
        self.measuring.transcript_segments.assert_not_called()
        self.measuring.voice_vectors.assert_called_once_with("recording.wav", self.segments, 90)
        self.assertEqual(result["speakers"][0]["who"], "Ann")
        self.assertTrue(result["speakers"][0]["me"])
        self.assertEqual(result["speakers"][0]["text"], self.segments[0]["text"])
        self.assertEqual(result["voices_heard"], [])

    def test_invalid_explicit_transcript_refuses_before_loading_models(self):
        invalid = [None, [], {}, [None], [{"start": True, "end": 2}],
                   [{"start": 0, "end": float("nan")}], [{"start": 0, "end": float("inf")}],
                   [{"start": -1, "end": 2}], [{"start": 2, "end": 1}],
                   [{"start": 0, "end": 2, "text": 2}],
                   [{"start": 3, "end": 4}, {"start": 1, "end": 2}]]
        for segments in invalid:
            with self.subTest(segments=segments), patch.dict(sys.modules, {"measure": None}):
                with self.assertRaises(who.who_is_in.Refused):
                    who.analyse({"file": "recording.wav", "segments": segments})
        self.measuring.transcript_segments.assert_not_called()
        self.measuring.voice_vectors.assert_not_called()

    def test_missing_file_refuses_before_loading_models(self):
        for request in (None, {}, {"file": None}, {"file": ""}):
            with self.subTest(request=request), patch.dict(sys.modules, {"measure": None}):
                with self.assertRaises(who.who_is_in.Refused):
                    who.analyse(request)

    def test_model_failure_remains_failure(self):
        self.measuring.transcript_segments.side_effect = SystemExit("No installed speech engine")
        with self.assertRaisesRegex(SystemExit, "No installed speech engine"):
            who.analyse({"file": "recording.wav"})
        self.measuring.voice_vectors.assert_not_called()

    def test_empty_or_blank_hearing_creates_no_voice_or_record(self):
        for segments in ([], [{"start": 0, "end": 3, "text": "  "}]):
            with self.subTest(segments=segments):
                self.measuring.transcript_segments.return_value = segments
                self.assertEqual(who.analyse({"file": "recording.wav"}),
                                 {"speakers": [], "voices_heard": [], "records": []})
        self.measuring.voice_vectors.assert_not_called()

    def test_malformed_hearing_refuses_before_voice_measurement(self):
        self.measuring.transcript_segments.return_value = [{"start": 2, "end": 1, "text": "words"}]
        with self.assertRaises(who.who_is_in.Refused):
            who.analyse({"file": "recording.wav"})
        self.measuring.voice_vectors.assert_not_called()


class SharedTranscriptionAdapter(unittest.TestCase):
    def setUp(self):
        self.pcm = np.array([0, 1200, -2300, 32767, -32768], dtype="<i2")
        self.audio_from = Mock(return_value=self.pcm)
        self.voices = patch.object(measure, "voices", return_value=SimpleNamespace(audio_from=self.audio_from))
        self.voices.start()
        self.addCleanup(self.voices.stop)
        self.recordings = []

    def provider(self, path, **options):
        self.recordings.append(path)
        options.pop("path_or_hf_repo", None)
        self.assertEqual(options, {"word_timestamps": True})
        with wave.open(path, "rb") as recording:
            self.assertEqual((recording.getnchannels(), recording.getsampwidth(), recording.getframerate()), (1, 2, 16000))
            self.assertEqual(recording.readframes(10), self.pcm.tobytes())
        return {"text": "Heard words", "segments": [{"start": 0.5, "end": 2, "text": "Heard words"}]}

    def test_real_shared_chooser_receives_bounded_wav_and_returns_its_segments(self):
        # Execute the actual shared adapter; only its external inference module is a test stand-in.
        transcribe = Mock(side_effect=self.provider)
        with patch.dict(os.environ, {"WHISPER_BACKEND": "mlx"}), \
             patch.dict(sys.modules, {"mlx_whisper": SimpleNamespace(transcribe=transcribe)}):
            result = measure.transcript_segments("input.mp4", 45)
        self.audio_from.assert_called_once_with("input.mp4", 45)
        self.assertEqual(result, [{"start": 0.5, "end": 2, "text": "Heard words"}])
        self.assertEqual(transcribe.call_args.kwargs["path_or_hf_repo"], "mlx-community/whisper-large-v3-turbo")
        self.assertTrue(all(not Path(path).exists() for path in self.recordings))

    def test_provider_failure_cleans_wav_and_propagates(self):
        def fail(path, **options):
            self.provider(path, **options)
            raise RuntimeError("weights unavailable")
        with patch.object(measure, "module", return_value=SimpleNamespace(transcribe=fail)):
            with self.assertRaisesRegex(RuntimeError, "weights unavailable"):
                measure.transcript_segments("input.mp4", 45)
        self.assertTrue(all(not Path(path).exists() for path in self.recordings))

    def test_provider_must_return_timed_segments(self):
        with patch.object(measure, "module", return_value=SimpleNamespace(transcribe=lambda *args, **kwargs: {"text": "words"})):
            with self.assertRaisesRegex(ValueError, "timed segments"):
                measure.transcript_segments("input.mp4", 45)


if __name__ == "__main__":
    unittest.main()

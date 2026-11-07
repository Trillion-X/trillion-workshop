"""Provider-shaped JSON through the real normalizer and word-record consumer."""
import json
from pathlib import Path
import runpy
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "do-work" / "process-scripts"
PRODUCER = runpy.run_path(str(SCRIPTS / "transcribe-audio.py"))
CONSUMER = runpy.run_path(str(SCRIPTS / "make-audio-transcription-records-from-command-output.py"))
NORMALIZE = PRODUCER["normalize_whisper_json"]


class ProviderWordTiming(unittest.TestCase):
    def test_cpp_offsets_subwords_and_special_tokens_reach_record_consumer(self):
        result = NORMALIZE({"transcription": [{
            "text": "Hello, there", "offsets": {"from": 500, "to": 9000},
            "tokens": [
                {"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}},
                {"text": " Hel", "offsets": {"from": 500, "to": 650}},
                {"text": "lo", "offsets": {"from": 650, "to": 800}},
                {"text": ",", "offsets": {"from": 800, "to": 800}},
                {"text": " there", "offsets": {"from": 1100, "to": 1500}},
                {"text": "[_TT_150_]", "offsets": {"from": -1, "to": -1}},
            ],
        }]}, "synthetic")
        self.assertEqual(result["words"], [
            {"t": "Hello,", "start": 0.5, "end": 0.8, "timing_source": "engine_token_timestamps"},
            {"t": "there", "start": 1.1, "end": 1.5, "timing_source": "engine_token_timestamps"},
        ])
        self.assertEqual(CONSUMER["word_records_from_command_output"](result["words"]), result["words"])

    def test_timestamp_shape_zero_and_invalid_boundaries_remain_honest(self):
        result = NORMALIZE({"transcription": [{
            "text": "Zero then unknown", "start": 0, "end": 9,
            "tokens": [
                {"text": " Zero", "timestamps": {"from": "00:00:00,000", "to": "00:00:00,300"}},
                {"text": " then", "start": 1, "end": 1.5},
                {"text": " unknown", "offsets": {"from": -1, "to": -1}},
            ],
        }]}, "synthetic")
        self.assertEqual([(w["t"], w["start"], w["end"]) for w in result["words"]], [
            ("Zero", 0, 0.3), ("then", 1, 1.5), ("unknown", 0, 9),
        ])
        self.assertEqual(result["words"][-1]["timing_source"], "segment_bounds_fallback")
        self.assertIsNone(PRODUCER["token_span"]({"start": "nan", "end": "inf"}))
        estimated = NORMALIZE({"segments": [{"text": "One two", "start": 3, "end": 5}]}, "estimate")
        self.assertEqual([w["timing_source"] for w in estimated["words"]], ["segment_uniform_estimate"] * 2)

    def test_real_command_requests_word_timestamps_and_normalizes_its_answer(self):
        with tempfile.TemporaryDirectory() as folder:
            output = str(Path(folder) / "answer.json")
            def run(command, **_):
                self.assertEqual(command[command.index("-ml") + 1], "1")
                self.assertIn("-sow", command)
                Path(command[command.index("-of") + 1] + ".json").write_text(json.dumps({
                    "transcription": [{"text": "Word", "offsets": {"from": 0, "to": 500},
                                       "tokens": [{"text": " Word", "offsets": {"from": 0, "to": 500}}]}],
                }))
                return types.SimpleNamespace(returncode=0, stdout="", stderr="")
            globals_ = PRODUCER["run_whisper"].__globals__
            with patch.dict(globals_, {
                "find_executable": lambda *_: ("synthetic-whisper", []),
                "normalize_audio": lambda *_: "synthetic.wav",
                "ensure_model": lambda *_: None,
            }), patch.object(PRODUCER["subprocess"], "run", side_effect=run):
                self.assertEqual(PRODUCER["run_whisper"]("synthetic.wav", "synthetic", output), 0)
            self.assertEqual(json.loads(Path(output).read_text())["words"][0], {
                "t": "Word", "start": 0, "end": 0.5, "timing_source": "engine_token_timestamps",
            })


if __name__ == "__main__":
    unittest.main()

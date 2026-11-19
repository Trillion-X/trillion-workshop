import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

FOLDER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FOLDER / "do-work"))
import wordtime  # noqa: E402


class WordtimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    @staticmethod
    def provider_result():
        return {"segments": [{"words": [
            {"word": " Hello ", "start": 0.123, "end": 0.456},
            {"word": " there! ", "start": 0.5, "end": 1.25},
        ]}]}

    def test_legacy_positional_command_keeps_window_provider_and_output_shape(self):
        out = str(Path(self.temp.name) / "words.json")
        provider = {}
        commands = []

        def transcribe(audio, **options):
            provider.update(audio=audio, **options)
            return self.provider_result()

        stdout = io.StringIO()
        with mock.patch.object(wordtime.subprocess, "run", side_effect=lambda command, **kw: commands.append((command, kw))), \
             mock.patch.object(wordtime.whisper_here, "transcribe", side_effect=transcribe), \
             contextlib.redirect_stdout(stdout):
            status = wordtime.main(["recording.mov", out, "10.25", "12.5"])

        self.assertEqual(status, 0)
        command, options = commands[0]
        self.assertEqual(command[0:12], ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", "10.25",
                                         "-to", "12.50", "-i", "recording.mov", "-vn"])
        self.assertEqual(command[12:16], ["-ac", "1", "-ar", "16000"])
        self.assertTrue(options["check"])
        self.assertEqual(provider["language"], "en")
        self.assertTrue(provider["word_timestamps"])
        self.assertIs(provider["condition_on_previous_text"], False, "a window is not prompted with the one before, so Whisper cannot loop to the end")
        self.assertEqual(provider["path_or_hf_repo"], wordtime.DEFAULT_MODEL)
        self.assertTrue(provider["audio"].endswith("/a.wav"))
        self.assertEqual(json.loads(Path(out).read_text()), {
            "source": "recording.mov",
            "timing": "word",
            "words": [
                {"text": "Hello", "start": 10.37, "end": 10.71},
                {"text": "there!", "start": 10.75, "end": 11.5},
            ],
        })
        self.assertEqual(stdout.getvalue(), f"2 words -> {out}\n")

    def test_stdin_json_request_selects_model_and_emits_one_result_line(self):
        out = str(Path(self.temp.name) / "request.words.json")
        request = {"source": "recording.mp4", "out": out, "from": 2.5, "to": 3.25,
                   "model": "mlx-community/whisper-small"}
        provider = {}
        commands = []

        def transcribe(audio, **options):
            provider.update(audio=audio, **options)
            return self.provider_result()

        stdout = io.StringIO()
        with mock.patch.object(wordtime.sys, "stdin", io.StringIO(json.dumps(request))), \
             mock.patch.object(wordtime.subprocess, "run", side_effect=lambda command, **kw: commands.append(command)), \
             mock.patch.object(wordtime.whisper_here, "transcribe", side_effect=transcribe), \
             contextlib.redirect_stdout(stdout):
            status = wordtime.main([])

        lines = stdout.getvalue().splitlines()
        self.assertEqual(status, 0)
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0]), {"result": {"out": out, "words": 2}})
        self.assertEqual(provider["path_or_hf_repo"], "mlx-community/whisper-small")
        self.assertTrue(provider["word_timestamps"])
        self.assertEqual(commands[0][5:9], ["-ss", "2.50", "-to", "3.25"])
        self.assertEqual(json.loads(Path(out).read_text())["words"][0]["start"], 2.62)

    def test_legacy_single_start_keeps_unwindowed_decode_and_offsets_words(self):
        out = str(Path(self.temp.name) / "start-only.words.json")
        commands = []
        with mock.patch.object(wordtime.subprocess, "run", side_effect=lambda command, **kw: commands.append(command)), \
             mock.patch.object(wordtime.whisper_here, "transcribe", return_value=self.provider_result()):
            result = wordtime.run(wordtime.parse_cli(["recording.wav", out, "4.2"]))

        self.assertEqual(result, {"out": out, "words": 2})
        self.assertNotIn("-ss", commands[0])
        self.assertEqual(json.loads(Path(out).read_text())["words"][0]["start"], 4.32)

    def test_request_requires_source_and_destination(self):
        with self.assertRaisesRegex(ValueError, '"source"'):
            wordtime.run({"out": "words.json"})

    def test_json_mode_serializes_invalid_and_missing_provider_errors(self):
        request = {"source": "recording.wav", "out": str(Path(self.temp.name) / "unused.json")}
        cases = [
            ({"WHISPER_BACKEND": "cloud"}, False, "WHISPER_BACKEND=cloud"),
            ({}, True, "This computer has no speech-to-text engine"),
        ]
        for environment, missing, message in cases:
            with self.subTest(message=message):
                stdout = io.StringIO()
                with contextlib.ExitStack() as stack:
                    stack.enter_context(mock.patch.object(wordtime.sys, "stdin", io.StringIO(json.dumps(request))))
                    stack.enter_context(mock.patch.object(wordtime.subprocess, "run"))
                    stack.enter_context(mock.patch.dict(os.environ, environment, clear=True))
                    if missing:
                        stack.enter_context(mock.patch.object(wordtime.whisper_here.importlib.util, "find_spec", return_value=None))
                    stack.enter_context(contextlib.redirect_stdout(stdout))
                    status = wordtime.main([])

                self.assertEqual(status, 2)
                lines = stdout.getvalue().splitlines()
                self.assertEqual(len(lines), 1)
                self.assertIn(message, json.loads(lines[0])["error"])


if __name__ == "__main__":
    unittest.main()

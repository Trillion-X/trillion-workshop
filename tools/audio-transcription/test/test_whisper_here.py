"""whisper_here picks the engine the computer has and returns mlx_whisper's shape from each.
Run: python3 -m unittest discover -s tools/audio-transcription/test -p 'test_whisper_here.py'

Ported from trillion-launch-video tools/place-capabilities/tests/test_whisper_here.py@5a9ba39: its five tests, their
assertions kept. One changed: the callers the shim guards are this folder's Python (the launch-video repository's whole
tree there), since a Workshop tool imports only from its own folder. Added: the mlx and openai engines through stand-ins,
an unknown WHISPER_BACKEND refused, and faster-whisper's segments without words when word times were not asked for.
No engine needs to be installed: every engine is a stand-in module."""
import os
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

FOLDER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FOLDER / "do-work"))
import whisper_here  # noqa: E402


def fake_faster():
    class Word:
        def __init__(self, w, s, e): self.word, self.start, self.end, self.probability = w, s, e, 0.9

    class Seg:
        seek, tokens, temperature, avg_logprob, compression_ratio, no_speech_prob = 0, [1, 2], 0.0, -0.2, 1.1, 0.01
        def __init__(self, s, e, text, words): self.start, self.end, self.text, self.words = s, e, text, words

    class WhisperModel:
        seen = {}
        def __init__(self, name, device, compute_type): WhisperModel.seen.update(name=name, device=device)
        def transcribe(self, path, **opts):
            WhisperModel.seen.update(opts)
            return iter([Seg(0.0, 1.0, " Density is", [Word(" Density", 0.0, 0.5), Word(" is", 0.5, 1.0)])]), types.SimpleNamespace(language="en")

    return types.SimpleNamespace(WhisperModel=WhisperModel)


class WhisperHere(unittest.TestCase):
    def test_model_names_map_to_the_plain_whisper_names(self):
        self.assertEqual(whisper_here.model_name("mlx-community/whisper-large-v3-turbo"), "large-v3-turbo")
        self.assertEqual(whisper_here.model_name("mlx-community/whisper-small-mlx"), "small")

    def test_a_place_without_mlx_gets_faster_whisper_in_mlx_whispers_shape(self):
        fw = fake_faster()
        with mock.patch.dict(sys.modules, {"faster_whisper": fw}), mock.patch.dict(os.environ, {"WHISPER_BACKEND": "faster"}):
            r = whisper_here.transcribe("a.wav", path_or_hf_repo="mlx-community/whisper-large-v3-turbo", word_timestamps=True,
                                        language="en", verbose=False, temperature=(0.0, 0.2))
        self.assertEqual(r["engine"], "faster-whisper")
        self.assertEqual(r["text"], " Density is")
        self.assertEqual([w["word"] for w in r["segments"][0]["words"]], [" Density", " is"])
        self.assertEqual(r["segments"][0]["words"][1]["end"], 1.0)
        self.assertEqual(fw.WhisperModel.seen["name"], "large-v3-turbo")
        self.assertEqual(fw.WhisperModel.seen["temperature"], [0.0, 0.2])
        self.assertNotIn("verbose", fw.WhisperModel.seen)

    def test_the_first_engine_the_place_has_is_chosen(self):
        have = {"mlx_whisper": None, "faster_whisper": object(), "whisper": object()}
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch("importlib.util.find_spec", side_effect=lambda n: have.get(n)):
            os.environ.pop("WHISPER_BACKEND", None)
            self.assertEqual(whisper_here.engine(), "faster")

    def test_a_place_with_no_engine_is_told_so(self):
        with mock.patch("importlib.util.find_spec", return_value=None), mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("WHISPER_BACKEND", None)
            with self.assertRaises(SystemExit) as e:
                whisper_here.engine()
        self.assertIn("faster-whisper", str(e.exception))

    def test_callers_import_the_shim_not_mlx_whisper(self):
        hits = subprocess.run(["git", "-C", str(FOLDER), "grep", "-l", "-E", r"^\s*import mlx_whisper\b", "--", "*.py",
                               ":!do-work/whisper_here.py"], capture_output=True, text=True).stdout.split()
        self.assertEqual(hits, [])

    # Added in the Workshop.

    def test_an_unknown_backend_is_refused_with_the_ones_to_use(self):
        with mock.patch.dict(os.environ, {"WHISPER_BACKEND": "cloud"}):
            with self.assertRaises(SystemExit) as e:
                whisper_here.engine()
        self.assertIn("mlx, faster, openai", str(e.exception))

    def test_mlx_gets_every_option_and_the_repo_unchanged(self):
        seen = {}
        def transcribe(audio, path_or_hf_repo, **options):
            seen.update(audio=audio, repo=path_or_hf_repo, **options)
            return {"text": " hi", "segments": [], "language": "en"}
        mlx = types.SimpleNamespace(transcribe=transcribe)
        with mock.patch.dict(sys.modules, {"mlx_whisper": mlx}), mock.patch.dict(os.environ, {"WHISPER_BACKEND": "mlx"}):
            r = whisper_here.transcribe("a.wav", path_or_hf_repo="mlx-community/whisper-small-mlx", word_timestamps=True,
                                        verbose=True, hallucination_silence_threshold=2.0)
        self.assertEqual(r["engine"], "mlx_whisper")
        self.assertEqual(seen["repo"], "mlx-community/whisper-small-mlx")
        self.assertEqual(seen["hallucination_silence_threshold"], 2.0)
        self.assertNotIn("verbose", seen)

    def test_openai_whisper_gets_the_plain_model_name_and_only_the_options_it_takes(self):
        seen = {}
        class Model:
            def transcribe(self, path, **opts):
                seen.update(path=path, **opts)
                return {"text": " hi", "segments": [], "language": "en"}
        def load_model(name):
            seen["name"] = name
            return Model()
        whisper = types.SimpleNamespace(load_model=load_model)
        with mock.patch.dict(sys.modules, {"whisper": whisper}), mock.patch.dict(os.environ, {"WHISPER_BACKEND": "openai"}):
            r = whisper_here.transcribe(Path("a.wav"), word_timestamps=True, language="en", hallucination_silence_threshold=2.0)
        self.assertEqual(r["engine"], "openai-whisper")
        self.assertEqual(seen["name"], "large-v3-turbo")
        self.assertEqual(seen["path"], "a.wav")
        self.assertTrue(seen["word_timestamps"])
        self.assertNotIn("hallucination_silence_threshold", seen)

    def test_faster_whisper_segments_carry_no_words_unless_word_times_were_asked(self):
        fw = fake_faster()
        with mock.patch.dict(sys.modules, {"faster_whisper": fw}), mock.patch.dict(os.environ, {"WHISPER_BACKEND": "faster", "WHISPER_DEVICE": "cpu"}):
            r = whisper_here.transcribe("a.wav")
        self.assertNotIn("words", r["segments"][0])
        self.assertEqual(r["language"], "en")
        self.assertEqual(fw.WhisperModel.seen["device"], "cpu")


if __name__ == "__main__":
    unittest.main()

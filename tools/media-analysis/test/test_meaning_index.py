"""meaning_index.py: the index, the search and the line protocol on synthetic vectors, then the real local models.

The first group needs only numpy: no model, no video. The last group runs the real CLIP and sentence models from the
local Hugging Face cache and is skipped, saying why, when they are not cached.
"""
import base64
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "meaning_index.py"
spec = importlib.util.spec_from_file_location("meaning_index", SCRIPT)
mi = importlib.util.module_from_spec(spec)
sys.modules["meaning_index"] = mi
spec.loader.exec_module(mi)


def b64(vector):
    return base64.b64encode(np.asarray(vector, dtype="<f2").tobytes()).decode("ascii")


def picture_value(rows):
    """rows: [(t, vector)] as a kept picture value."""
    return {"dtype": "float16", "frames": [{"t": t, "v": b64(v)} for t, v in rows]}


def run_with_config(config, lines):
    """Runs the script with the config written to a file, as the row does, and the request lines on standard input."""
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "config.json"
        path.write_text(json.dumps(config))
        return subprocess.run([sys.executable, str(SCRIPT), str(path)], input=lines, capture_output=True, text=True, timeout=600)


def run_script(requests, config=None):
    lines = "".join(json.dumps(r) + "\n" for r in requests)
    done = run_with_config(config or {"in_order": True}, lines)
    return done, [json.loads(line) for line in done.stdout.splitlines() if line.strip()]


class TheIndex(unittest.TestCase):
    def test_best_row_per_recording_wins_and_a_replaced_recording_is_retired(self):
        lane = mi.Lane()
        lane.put("a", np.array([[1, 0], [0, 1]], dtype="float32"), [{"t": 1}, {"t": 2}])
        lane.put("b", np.array([[0.6, 0.8]], dtype="float32"), [{"t": 9}])
        found = lane.best(np.array([0, 1], dtype="float32"), 5)
        self.assertEqual([(identity, moment) for identity, _score, moment in found], [("a", {"t": 2}), ("b", {"t": 9})])
        self.assertAlmostEqual(found[0][1], 1.0, places=5)
        lane.put("a", np.array([[1, 0]], dtype="float32"), [{"t": 7}])   # a newer value for the same recording
        found = lane.best(np.array([0, 1], dtype="float32"), 5)
        self.assertEqual([identity for identity, _s, _m in found], ["b", "a"])
        self.assertEqual(dict((i, m) for i, _s, m in found)["a"], {"t": 7})

    def test_an_empty_lane_finds_nothing(self):
        self.assertEqual(mi.Lane().best(np.array([1, 0], dtype="float32"), 3), [])

    def test_a_kept_value_comes_back_in_through_add_and_is_found(self):
        mi.LANES["picture"] = mi.Lane()
        rows = mi.add_value("picture", "clip-1", picture_value([(3.0, [1, 0, 0]), (9.0, [0, 1, 0])]))
        self.assertEqual(rows, 2)
        found = mi.LANES["picture"].best(np.array([0, 1, 0], dtype="float32"), 3)
        self.assertEqual(found[0][0], "clip-1")
        self.assertEqual(found[0][2], {"t": 9.0})

    def test_a_speech_value_keeps_its_words_and_times(self):
        mi.LANES["speech"] = mi.Lane()
        value = {"dtype": "float16", "chunks": [{"start": 1.0, "end": 2.5, "text": "we open at six", "v": b64([1, 0])}]}
        self.assertEqual(mi.add_value("speech", "talk-1", value), 1)
        found = mi.LANES["speech"].best(np.array([1, 0], dtype="float32"), 1)
        self.assertEqual(found[0][2], {"start": 1.0, "end": 2.5, "text": "we open at six"})

    def test_an_unknown_kind_is_refused_with_what_to_use(self):
        with self.assertRaisesRegex(ValueError, "picture' or 'speech"):
            mi.add_value("sound", "x", {})

    def test_sample_times_are_the_middle_of_equal_stretches_and_capped(self):
        self.assertEqual(mi.sample_times(12, {"interval_seconds": 6, "max_frames": 20}), [3.0, 9.0])
        self.assertEqual(len(mi.sample_times(10000, {"interval_seconds": 6, "max_frames": 20})), 20)
        self.assertEqual(mi.sample_times(0, {"interval_seconds": 6, "max_frames": 20}), [0.0])


class TheLineProtocol(unittest.TestCase):
    def test_replies_echo_ids_failures_say_what_to_do_and_the_last_line_is_the_tally(self):
        value = picture_value([(1.0, [1, 0])])
        done, replies = run_script([
            {"id": 1, "op": "add", "kind": "picture", "identity": "r1", "value": value},
            {"id": 2, "op": "add", "kind": "sound", "identity": "r1", "value": value},
            {"id": 3, "op": "nothing"},
            {"id": 4, "op": "embed_picture", "identity": "r2", "file": "/no/such/file.mp4"},
            {"id": 5, "op": "embed_speech", "identity": "r3", "chunks": [{"text": "  "}]},
        ])
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(replies[0], {"id": None, "ok": True, "ready": True})
        by_id = {r["id"]: r for r in replies if r.get("id") is not None}
        self.assertEqual(by_id[1], {"id": 1, "ok": True, "rows": 1})
        self.assertIn("'picture' or 'speech'", by_id[2]["error"])
        self.assertIn("use one of", by_id[3]["error"])
        self.assertIn("not on this computer", by_id[4]["error"])
        self.assertIn("no transcript text", by_id[5]["error"])
        self.assertEqual(replies[-1], {"result": {"answered": 1, "failed": 4}})

    def test_a_line_that_is_not_json_is_skipped_not_fatal(self):
        done = run_with_config({}, "not json\n" + json.dumps({"id": 7, "op": "nothing"}) + "\n")
        self.assertEqual(done.returncode, 0, done.stderr)
        replies = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual(replies[-1], {"result": {"answered": 0, "failed": 1}})


def torch_available():
    return all(importlib.util.find_spec(name) for name in ("torch", "open_clip", "sentence_transformers", "tokenizers", "PIL"))


def models_cached():
    hub = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub"
    return all((hub / name).exists() for name in ("models--timm--vit_base_patch32_clip_224.openai", "models--BAAI--bge-small-en-v1.5"))


@unittest.skipUnless(torch_available() and models_cached(), "needs torch, open_clip, sentence_transformers and the default CLIP and sentence models in the local Hugging Face cache")
class TheRealModels(unittest.TestCase):
    PHRASES = ["a person drawing on a whiteboard", "red car parked outside", "a loaf of bread"]
    LANES = (("picture", mi.DEFAULT_PICTURE_MODEL), ("speech", mi.DEFAULT_SPEECH_MODEL))

    def test_a_later_start_answers_from_saved_encoders_without_the_full_models(self):
        def refuse(*_args, **_kwargs):
            raise AssertionError("a later start loaded the full model")

        with tempfile.TemporaryDirectory() as folder:
            first = mi.QueryEncoders()
            first.folder = Path(folder)
            expected = {lane: [first.encode(lane, config, phrase) for phrase in self.PHRASES] for lane, config in self.LANES}
            saved = sorted(path.name for path in Path(folder).iterdir())
            self.assertTrue(any(n.startswith("picture-") and n.endswith(".pt") for n in saved), saved)
            self.assertTrue(any(n.startswith("speech-") and n.endswith(".tokenizer.json") for n in saved), saved)
            full_picture, full_speech = mi.MODELS.picture, mi.MODELS.speech_model
            mi.MODELS.picture, mi.MODELS.speech_model = refuse, refuse
            try:
                later = mi.QueryEncoders()
                later.folder = Path(folder)
                for lane, config in self.LANES:
                    for phrase, vector in zip(self.PHRASES, expected[lane]):
                        again = later.encode(lane, config, phrase)
                        self.assertEqual(again.shape, vector.shape)
                        self.assertGreater(float(np.dot(again, vector)), 0.999, (lane, phrase))
            finally:
                mi.MODELS.picture, mi.MODELS.speech_model = full_picture, full_speech
            picture_file = next(Path(folder).glob("picture-*.pt"))
            self.assertLess(picture_file.stat().st_size, 300 * 1024 * 1024)   # only the text side is kept

    def test_a_picture_is_found_by_its_own_vector_and_a_transcript_by_its_words(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as folder:
            red, blue = Path(folder) / "red.png", Path(folder) / "blue.png"
            Image.new("RGB", (320, 240), (200, 20, 20)).save(red)
            Image.new("RGB", (320, 240), (20, 20, 200)).save(blue)
            requests = [
                {"id": "r", "op": "embed_picture", "identity": "red", "file": str(red), "media_kind": "image"},
                {"id": "b", "op": "embed_picture", "identity": "blue", "file": str(blue), "media_kind": "image"},
                {"id": "s1", "op": "embed_speech", "identity": "talk-bread", "chunks": [{"start": 0, "end": 4, "text": "We bake sourdough bread every morning before the shop opens."}]},
                {"id": "s2", "op": "embed_speech", "identity": "talk-tax", "chunks": [{"start": 0, "end": 4, "text": "The quarterly tax filing is due at the end of the month."}]},
                {"id": "q", "op": "search", "query": "baking bread in the morning", "lanes": ["speech"], "limit": 2},
            ]
            done, replies = run_script(requests, {"in_order": True, "query_encoders": str(Path(folder) / "encoders")})
            self.assertEqual(done.returncode, 0, done.stderr)
            by_id = {r["id"]: r for r in replies if r.get("id") is not None}
            self.assertEqual(by_id["r"]["frames"], 1)
            self.assertEqual(by_id["r"]["value"]["dims"], 512)
            self.assertEqual(by_id["q"]["speech"][0]["identity"], "talk-bread")
            self.assertEqual(replies[-1], {"result": {"answered": 5, "failed": 0}})
            # The kept picture value goes into a later run through add, and the same picture is found there.
            kept = by_id["r"]["value"]
            again = [{"id": 1, "op": "add", "kind": "picture", "identity": "red", "value": kept},
                     {"id": 2, "op": "add", "kind": "picture", "identity": "blue", "value": by_id["b"]["value"]},
                     {"id": 3, "op": "search", "query": "a red picture", "lanes": ["picture"], "limit": 2}]
            done, replies = run_script(again, {"in_order": True, "query_encoders": str(Path(folder) / "encoders")})
            self.assertEqual(done.returncode, 0, done.stderr)
            hits = {r["id"]: r for r in replies if r.get("id") is not None}[3]["picture"]
            self.assertEqual({h["identity"] for h in hits}, {"red", "blue"})


if __name__ == "__main__":
    unittest.main()

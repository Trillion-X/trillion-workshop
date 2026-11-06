"""A whole run through the real worker: run_in_engine.answer over a stand-in records door starts worker.py under this
Python (standing in for the one granted to start-a-program) on a made-up model folder in a made-up kept folder: a tiny
random Qwen3.5-shaped model saved as safetensors, a word-level tokenizer.json built here (capital pairs and single
characters), and a decider_config.json. Needs mlx, numpy and tokenizers."""
import importlib.util, json, os, string, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DO_WORK = os.path.join(HERE, "..", "do-work")
sys.path.insert(0, HERE)
sys.path.insert(0, DO_WORK)
READY = all(importlib.util.find_spec(m) is not None for m in ("mlx", "numpy", "tokenizers"))


def write(path, value):
    with open(path, "w") as f:
        json.dump(value, f)


def made_up_folder(path):
    import mlx.core as mx
    from tokenizers import Regex, Tokenizer, models, pre_tokenizers
    from questions_first.backbone import Backbone, Config
    from test_questions_first import TINY
    U = string.ascii_uppercase
    pieces = ["<unk>", "<pad>"] + list(U) + [a + b for a in U for b in U] + [chr(c) for c in range(32, 127) if chr(c) not in U] + ["\n"]
    vocab = {p: i for i, p in enumerate(dict.fromkeys(pieces))}
    tk = Tokenizer(models.WordLevel(vocab, unk_token="<unk>"))
    tk.pre_tokenizer = pre_tokenizers.Split(Regex(r"[A-Z]{1,2}|[\s\S]"), behavior="isolated")
    tk.save(os.path.join(path, "tokenizer.json"))
    write(os.path.join(path, "tokenizer_config.json"), {"pad_token": "<pad>"})
    cfg = dict(TINY, vocab_size=len(vocab) + 8)
    write(os.path.join(path, "config.json"), cfg)
    write(os.path.join(path, "decider_config.json"), {"temperature_schema_first": 1.18, "isolated_levels": True, "version": "made-up"})
    bb = Backbone.random(Config(cfg), mx.float32, seed=5, std=0.2)
    mx.save_safetensors(os.path.join(path, "model.safetensors"), {"model." + k: v for k, v in bb.w.items()})


REQUEST = {"classifier": "made-up", "questions": "lamps", "states": "evening", "settings": "exact"}


@unittest.skipUnless(READY, "needs mlx, numpy and tokenizers (the Python granted to start-a-program has them)")
class WorkerEndToEnd(unittest.TestCase):
    def test_a_run_through_the_real_worker_keeps_its_answers_as_rows(self):
        import run_in_engine as R
        from door_stand_in import StandInDoor
        from test_engine_rows import seeded, C, SET, ANS, RUN
        with tempfile.TemporaryDirectory() as kept:
            folder = os.path.join(kept, "models", "someone--made-up", "0" * 40)
            os.makedirs(folder)
            made_up_folder(folder)
            records = seeded()
            records[f"{SET}:exact"] = (SET, {"label": "Exact", "layout": "independent", "dtype": "float32", "tokens_per_batch": 2048, "max_state_tokens": 512})
            records["record:classifier-question:how"] = ("record:classifier-question", {"set": "lamps", "order": 3, "type": "score", "instructions": "How heavy is it?", "criteria": '["light", "heavy"]'})
            std = StandInDoor(records)
            out = R.answer(dict(REQUEST), std.door(), kept, sys.executable)
            self.assertEqual((out["status"], out["states_done"]), ("finished", 5), out)
            answers = {i: json.loads(v["answers"]) for i, (t, v) in std.records.items() if t == ANS}
            self.assertEqual(len(answers), 5)
            first = answers[f"{ANS}:{out['run']}:s0"]
            self.assertEqual(set(first), {"warm", "which", "how"})
            self.assertAlmostEqual(sum(first["which"]["probabilities"].values()), 1.0, places=3)
            self.assertIn("level_fit", first["how"])
            run = [v for t, v in std.records.values() if t == RUN][0]
            self.assertIn("mlx", run["machine"])
            self.assertGreater(run["padded_suffix_tokens"], 0)


if __name__ == "__main__":
    unittest.main()

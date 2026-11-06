"""The whole command on a made-up model folder: get-ready, start (a real background process), read until finished,
page the answers. The folder holds a tiny random Qwen3.5-shaped model saved as safetensors, a word-level
tokenizer.json built here (capital pairs and single characters), and a decider_config.json. Needs mlx, tokenizers
and blake3."""
import base64, importlib.util, json, os, string, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DO_WORK = os.path.join(HERE, "..", "do-work")
sys.path.insert(0, HERE)
sys.path.insert(0, DO_WORK)
READY = all(importlib.util.find_spec(m) is not None for m in ("mlx", "tokenizers", "blake3"))


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


def call(action, request):
    r = subprocess.run([sys.executable, "-I", os.path.join(DO_WORK, "answer_many_states.py"), action],
                       input=json.dumps(request), capture_output=True, text=True, timeout=600)
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(READY, "needs mlx, tokenizers and blake3 (the row's get_it commands)")
class EndToEnd(unittest.TestCase):
    def test_a_run_from_start_to_its_last_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = os.path.join(tmp, "model")
            os.makedirs(folder)
            made_up_folder(folder)
            model = {"id": "made-up-decider", "classifier": "questions-first-decider", "weights": {"folder": folder}}
            ready = call("get-ready", {"model": model})["result"]
            self.assertTrue(ready["identity"].startswith("1f:"))
            request = {"model": model, "jobs_folder": os.path.join(tmp, "jobs"),
                       "questions": {"warm": {"type": "noul", "instructions": "Is the lamp warm?"},
                                     "late": {"type": "choice", "instructions": "Which thing is late?", "criteria": ["parcel", "river", "kettle"]},
                                     "how": {"type": "score", "instructions": "How heavy is it?", "criteria": ["light", "heavy"]}},
                       "states": ["The warm lamp glowed.", {"item": "parcel", "state": "late"}, "The river grew."],
                       "settings": {"layout": "independent", "dtype": "float32", "tokens_per_batch": 2048,
                                    "max_state_tokens": 512, "page_bytes": 400}}
            job = call("start", request)["result"]["job_id"]
            for _ in range(600):
                got = call("read", {"job_id": job, "jobs_folder": request["jobs_folder"]})["result"]
                if got["status"] not in ("queued", "running"):
                    break
                time.sleep(0.5)
            self.assertEqual(got["status"], "finished", got)
            parts, page = [], got["byte_page"]
            while True:
                parts.append(base64.b64decode(page["base64"]))
                if page["next_after_byte"] is None:
                    break
                page = call("read", {"job_id": job, "jobs_folder": request["jobs_folder"], "after_byte": page["next_after_byte"]})["result"]["byte_page"]
            answers = json.loads(b"".join(parts))
            self.assertEqual(len(answers["answers"]), 3)
            first = answers["answers"][0]["answers"]
            self.assertEqual(set(first), {"warm", "late", "how"})
            self.assertAlmostEqual(sum(first["late"]["probabilities"].values()), 1.0, places=3)
            self.assertIn("level_fit", first["how"])
            self.assertEqual(answers["classifier_answers_as"], "decider-made-up")


if __name__ == "__main__":
    unittest.main()

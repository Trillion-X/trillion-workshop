"""The engine rows' program (do-work/run_in_engine.py) over a stand-in records door and a stand-in worker: lists made
once, inputs read from list rows, every answer and the run's measurements written as list rows, a run named by what it
asks, resumed where it stopped, stopped by its row's Stop, and every refusal. Standard library only, made-up records."""
import hashlib, io, json, os, sys, tempfile, unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))

import run_in_engine as R  # noqa: E402
from door_stand_in import StandInDoor  # noqa: E402

Q, S_, C, SET, RUN, ANS = ("record:classifier-question", "record:classifier-state", "record:classifier",
                          "record:classifier-setting", "record:classifier-run", "record:classifier-answer")


def seeded(identity="1f:" + "ab" * 32):
    r = {f"{C}:made-up": (C, {"label": "Made-up", "classifier": "questions-first-decider", "repo": "someone/made-up", "revision": "0" * 40, "identity": identity}),
         f"{SET}:quick": (SET, {"label": "Quick", "layout": "independent", "dtype": "bfloat16", "tokens_per_batch": 4096, "max_state_tokens": 512})}
    r[f"{Q}:warm"] = (Q, {"set": "lamps", "order": 1, "type": "noul", "instructions": "Is the lamp warm?"})
    r[f"{Q}:which"] = (Q, {"set": "lamps", "order": 2, "type": "choice", "instructions": "Which thing is late?", "criteria": '["parcel", "river"]'})
    r[f"{Q}:other"] = (Q, {"set": "other set", "order": 1, "type": "noul", "instructions": "Not asked"})
    for i in range(5):
        r[f"{S_}:s{i}"] = (S_, {"set": "evening", "order": i, "text": f"The lamp {i} glowed."})
    r[f"{S_}:s9"] = (S_, {"set": "morning", "order": 0, "text": "Not asked"})
    return r


class Worker:
    """Answers two states per batch with fixed answers; before_batch(n) runs before batch n is printed."""
    def __init__(self, job, before_batch=None, fail=None):
        self.job, self.before, self.fail, self.terminated = job, before_batch, fail, False

    @property
    def stdout(self):
        yield json.dumps({"loaded": {"load_seconds": 1.5, "prepare_seconds": 0.5, "machine": "made-up"}}) + "\n"
        if self.fail:
            yield json.dumps({"error": self.fail}) + "\n"
            return
        sts = self.job["states"]
        for n, i in enumerate(range(0, len(sts), 2)):
            if self.before:
                self.before(n)
            yield json.dumps({"answered": [{"id": s["id"], "answers": {q: {"type": "noul", "noul": 0.5} for q in self.job["questions"]}} for s in sts[i:i + 2]]}) + "\n"
        yield json.dumps({"finished": {"answer_seconds": 2.0, "padded_suffix_tokens": 99, "batches": 3}}) + "\n"

    def terminate(self):
        self.terminated = True

    def wait(self):
        return 0


REQUEST = {"classifier": "made-up", "questions": "lamps", "states": "evening", "settings": "quick"}


class Rows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.kept = self.tmp.name
        os.makedirs(os.path.join(self.kept, "models", "someone--made-up", "0" * 40))
        self.std = StandInDoor(seeded())
        self.door = self.std.door()
        self.jobs = []

    def tearDown(self):
        self.tmp.cleanup()

    def spawn(self, **kw):
        def go(program, job):
            self.jobs.append(job)
            self.worker = Worker(job, **kw)
            return self.worker
        return go

    def answers(self):
        return {i: v for i, (t, v) in self.std.records.items() if t == ANS}

    def run_row(self):
        return [v for t, v in self.std.records.values() if t == RUN][0]

    def test_a_run_reads_its_rows_and_keeps_every_answer_and_measurement_as_rows(self):
        out = R.answer(dict(REQUEST), self.door, self.kept, "/made/up/python", spawn=self.spawn())
        job = self.jobs[0]
        self.assertEqual(list(job["questions"]), ["warm", "which"])
        self.assertEqual(job["questions"]["which"]["criteria"], ["parcel", "river"])
        self.assertEqual([s["id"] for s in job["states"]], [f"s{i}" for i in range(5)])
        self.assertTrue(job["folder"].endswith(os.path.join("someone--made-up", "0" * 40)))
        self.assertEqual(len(self.answers()), 5)
        a = self.answers()[f"{ANS}:{out['run']}:s3"]
        self.assertEqual(json.loads(a["answers"])["warm"], {"type": "noul", "noul": 0.5})
        run = self.run_row()
        self.assertEqual((run["status"], run["states_done"], run["decisions"], run["prepare_seconds"]), ("finished", 5, 10, 0.5))
        self.assertGreater(run["wall_seconds"], 0)
        for name in R.DATA["lists"].values():
            self.assertIn(f"list:{name['id']}", self.std.records)

    def test_the_same_rows_name_the_same_run_and_a_finished_run_is_not_run_again(self):
        a = R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn())
        b = R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn())
        self.assertEqual(a["run"], b["run"])
        self.assertTrue(b["already"])
        self.assertEqual(len(self.jobs), 1)
        self.std.records[f"{Q}:warm"][1]["instructions"] = "Is the lamp warm now?"
        c = R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn())
        self.assertNotEqual(a["run"], c["run"])

    def test_stop_ends_the_run_after_the_batch_in_hand_and_a_new_run_goes_on_from_there(self):
        def set_stop(n):
            if n == 1:
                R.stop({"run": self.run_id()}, self.door)
        out = R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn(before_batch=set_stop))
        self.assertTrue(self.worker.terminated)
        self.assertEqual((out["status"], out["states_done"]), ("stopped", 4))
        run = self.run_row()
        run.pop("stop")
        R.Lists(self.door).put("runs", [(out["run"], {**run, "status": "stopped"})], key="clear")
        again = R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn())
        self.assertEqual([s["id"] for s in self.jobs[-1]["states"]], ["s4"])
        self.assertEqual((again["status"], again["states_done"]), ("finished", 5))

    def run_id(self):
        return [i for i, (t, _) in self.std.records.items() if t == RUN][0].split(":", 2)[2]

    def test_read_pages_the_answers(self):
        out = R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn())
        page = R.read({"run": out["run"], "answers": True, "limit": 2}, self.door)
        self.assertEqual([a["state"] for a in page["answers"]], ["s0", "s1"])
        page2 = R.read({"run": out["run"], "answers": True, "limit": 2, "after": page["next_after"]}, self.door)
        self.assertEqual([a["state"] for a in page2["answers"]], ["s2", "s3"])
        self.assertEqual(page["status"], "finished")

    def test_a_worker_error_is_kept_on_the_run_row(self):
        with self.assertRaises(R.Refusal):
            R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn(fail="the granted Python cannot run the model"))
        self.assertEqual(self.run_row()["status"], "failed")
        self.assertIn("cannot run the model", self.run_row()["error"])

    def test_refusals_name_what_to_change(self):
        cases = [
            ({**REQUEST, "classifier": "nope"}, "no row nope"),
            ({**REQUEST, "questions": "empty"}, "has no questions"),
            ({**REQUEST, "states": "empty"}, "has no states"),
            ({**REQUEST, "settings": "nope"}, "no row nope"),
        ]
        for req, words in cases:
            with self.assertRaises(R.Refusal) as e:
                R.answer(req, self.door, self.kept, "/p", spawn=self.spawn())
            self.assertIn(words, str(e.exception))
        with self.assertRaises(R.Refusal) as e:
            R.answer(dict(REQUEST), self.door, self.kept, None, spawn=self.spawn())
        self.assertIn("start-a-program", str(e.exception))
        self.std.records[f"{SET}:quick"][1].pop("max_state_tokens")
        with self.assertRaises(R.Refusal) as e:
            R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn())
        self.assertIn("max_state_tokens", str(e.exception))

    def test_not_ready_and_bad_questions(self):
        self.std.records[f"{C}:made-up"][1].pop("identity")
        with self.assertRaises(R.Refusal) as e:
            R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn())
        self.assertIn("get-a-classifier-ready", str(e.exception))
        self.std.records[f"{C}:made-up"][1]["identity"] = "1f:" + "cd" * 32
        self.std.records[f"{Q}:which"][1]["criteria"] = '["only one"]'
        with self.assertRaises(R.Refusal) as e:
            R.answer(dict(REQUEST), self.door, self.kept, "/p", spawn=self.spawn())
        self.assertIn("Question which", str(e.exception))


class GetReady(unittest.TestCase):
    def test_fetches_each_file_once_checks_it_and_writes_the_identity_back(self):
        files = {"config.json": b'{"model_type": "qwen3_5_text"}', "decider_config.json": b"{}", "tokenizer.json": b"{}",
                 "tokenizer_config.json": b"{}", "model.safetensors": b"made-up weights", "README.md": b"not fetched"}
        tree = [{"type": "file", "path": n, "size": len(b), **({"lfs": {"oid": hashlib.sha256(b).hexdigest(), "size": len(b)}} if n.endswith(".safetensors") else {})}
                for n, b in files.items()]
        fetched = []

        def fetch(url, path):
            name = url.rsplit("/", 1)[1]
            fetched.append(name)
            with open(path, "wb") as f:
                f.write(files[name])
        std = StandInDoor(seeded(identity=None))
        with tempfile.TemporaryDirectory() as kept:
            r = R.get_ready({"classifier": "made-up"}, std.door(), kept, fetch=fetch, tree_of=lambda url: tree)
            self.assertTrue(r["identity"].startswith("1f:"))
            self.assertNotIn("README.md", fetched)
            self.assertEqual(std.records[f"{C}:made-up"][1]["identity"], r["identity"])
            again = R.get_ready({"classifier": "made-up"}, std.door(), kept, fetch=fetch, tree_of=lambda url: tree)
            self.assertEqual(again["identity"], r["identity"])
            self.assertEqual(len(fetched), 5)                   # nothing fetched twice
            files["model.safetensors"] = b"changed in transit"
            os.remove(os.path.join(kept, "models", "someone--made-up", "0" * 40, "model.safetensors"))
            with self.assertRaises(R.Refusal) as e:
                R.get_ready({"classifier": "made-up"}, std.door(), kept, fetch=fetch, tree_of=lambda url: tree)
            self.assertIn("did not arrive", str(e.exception))


class Door(unittest.TestCase):
    def test_byte_pages_are_joined_and_checked_and_a_busy_door_is_asked_again(self):
        big = {"text": "x" * 5000}
        std = StandInDoor({"record:thing:a": ("record:thing", big)}, page_bytes=700, busy=2)
        self.assertEqual(std.door().read("record:thing", "record:thing:a"), big)
        self.assertGreater(std.calls.count("records:read"), 5)

    def test_the_command_answers_one_json_line(self):
        std = StandInDoor(seeded())
        old = sys.stdin
        sys.stdin = io.StringIO(json.dumps({"run": "run-none"}))
        out = io.StringIO()
        try:
            with redirect_stdout(out):
                code = R.main(["x", "read"], door=std.door())
        finally:
            sys.stdin = old
        self.assertEqual(code, 1)
        self.assertIn("no run run-none", json.loads(out.getvalue().strip().splitlines()[-1])["error"])


if __name__ == "__main__":
    unittest.main()

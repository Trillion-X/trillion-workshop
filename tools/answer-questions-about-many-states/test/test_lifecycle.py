"""The tool's lifecycle (get-ready, start, read in byte pages, cancel) and its refusals, with a made-up classifier
family in place of a model: no weights, no MLX, no network. Needs the blake3 module."""
import base64, importlib.util, io, json, os, sys, tempfile, threading, unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))
HAS_BLAKE3 = importlib.util.find_spec("blake3") is not None

import answer_many_states as A  # noqa: E402

SETTINGS = {"layout": "independent", "dtype": "bfloat16", "tokens_per_batch": 4096, "max_state_tokens": 512, "page_bytes": 300}
QUESTIONS = {"warm": {"type": "noul", "instructions": "Is the lamp warm?"},
             "which": {"type": "choice", "instructions": "Which thing is late?", "criteria": ["parcel", "river"]}}


class MadeUp:
    """Answers every question with fixed probabilities, a batch of two states at a time; stops when asked."""
    seen_stop = False

    @staticmethod
    def check(folder):
        return ["config.json"]

    @staticmethod
    def answer(folder, questions, states, settings, on_batch, should_stop, timings):
        done = []
        for i in range(0, len(states), 2):
            if should_stop():
                MadeUp.seen_stop = True
                break
            done += list(range(i, min(i + 2, len(states))))
            on_batch(list(done), len(states))
        timings["answer"] = 0.01
        return "made-up", lambda s: {k: {"type": "noul", "noul": 0.25} for k in questions}


@unittest.skipUnless(HAS_BLAKE3, "needs the blake3 module (python3 -m pip install blake3)")
class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.model_dir = os.path.join(self.tmp.name, "model")
        os.makedirs(self.model_dir)
        with open(os.path.join(self.model_dir, "config.json"), "w") as f:
            f.write('{"model_type": "made-up"}')
        A.FAMILIES["made-up"] = MadeUp
        self.model = {"id": "made-up-model", "classifier": "made-up", "weights": {"folder": self.model_dir}}
        self.jobs = os.path.join(self.tmp.name, "jobs")

    def tearDown(self):
        A.FAMILIES.pop("made-up", None)
        self.tmp.cleanup()

    def request(self, **kw):
        return {"model": self.model, "questions": QUESTIONS, "states": [f"state {i}" for i in range(7)],
                "settings": SETTINGS, "jobs_folder": self.jobs, **kw}

    def run_inline(self, path):
        A.work(path, families={"made-up": MadeUp})
        return os.getpid()

    def whole(self, job):
        """Read every byte page and check them as tools/records-door/read-data/byte-pages.mjs does."""
        parts, after = [], 0
        first = None
        while True:
            page = A.read({"job_id": job, "jobs_folder": self.jobs, "after_byte": after})["byte_page"]
            first = first or page
            self.assertEqual((page["offset"], page["total"], page["blake3"]), (after, first["total"], first["blake3"]))
            parts.append(base64.b64decode(page["base64"]))
            self.assertLessEqual(page["length"], SETTINGS["page_bytes"])
            if page["next_after_byte"] is None:
                break
            after = page["next_after_byte"]
        data = b"".join(parts)
        self.assertEqual(len(data), first["total"])
        self.assertEqual(A.identity_of_bytes(data), "1f:" + first["blake3"])
        return json.loads(data)

    def test_get_ready_names_the_weights(self):
        r = A.get_ready({"model": self.model})
        self.assertTrue(r["ready"])
        self.assertTrue(r["identity"].startswith("1f:"))
        self.assertEqual([f["name"] for f in r["files"]], ["config.json"])

    def test_start_read_and_page_every_answer(self):
        started = A.start(self.request(), spawn=self.run_inline)
        self.assertTrue(started["job_id"].startswith("1f:"))
        got = A.read({"job_id": started["job_id"], "jobs_folder": self.jobs})
        self.assertEqual((got["status"], got["states_done"], got["states"]), ("finished", 7, 7))
        answers = self.whole(started["job_id"])
        self.assertEqual([a["state"] for a in answers["answers"]], list(range(7)))
        self.assertEqual(answers["answers"][3]["answers"]["warm"], {"type": "noul", "noul": 0.25})
        self.assertGreater(answers["seconds"]["wall"], 0)

    def test_the_same_request_names_the_same_run(self):
        a = A.start(self.request(), spawn=self.run_inline)
        b = A.start(self.request(), spawn=self.run_inline)
        self.assertEqual(a["job_id"], b["job_id"])
        self.assertTrue(b["already"])
        c = A.start(self.request(states=["another"]), spawn=self.run_inline)
        self.assertNotEqual(a["job_id"], c["job_id"])

    def test_cancel_keeps_what_finished(self):
        gate = threading.Event()

        class Slow(MadeUp):
            @staticmethod
            def answer(folder, questions, states, settings, on_batch, should_stop, timings):
                on_batch([0, 1], len(states))
                gate.wait(5)
                return MadeUp.answer(folder, questions, states[:0], settings, on_batch, should_stop, timings) if should_stop() else \
                    MadeUp.answer(folder, questions, states, settings, on_batch, should_stop, timings)
        A.FAMILIES["made-up"] = Slow
        holder = {}

        def spawn(path):
            t = threading.Thread(target=A.work, args=(path, {"made-up": Slow}))
            t.start()
            holder["t"] = t
            return os.getpid()
        started = A.start(self.request(), spawn=spawn)
        c = A.cancel({"job_id": started["job_id"], "jobs_folder": self.jobs})
        self.assertEqual(c["status"], "cancelling")
        gate.set()
        holder["t"].join(5)
        got = A.read({"job_id": started["job_id"], "jobs_folder": self.jobs})
        self.assertEqual(got["status"], "cancelled")
        self.assertIn("byte_page", got)


@unittest.skipUnless(HAS_BLAKE3, "needs the blake3 module (python3 -m pip install blake3)")
class Refusals(unittest.TestCase):
    def call(self, action, request):
        old = sys.stdin
        sys.stdin = io.StringIO(json.dumps(request))
        out = io.StringIO()
        try:
            with redirect_stdout(out):
                A.main(["x", action])
        finally:
            sys.stdin = old
        return json.loads(out.getvalue().strip().splitlines()[-1])

    def test_each_missing_setting_is_named(self):
        with tempfile.TemporaryDirectory() as d:
            model = {"id": "m", "classifier": "questions-first-decider", "weights": {"folder": d}}
            for field in A.SETTINGS:
                s = {k: v for k, v in SETTINGS.items() if k != field}
                r = self.call("start", {"model": model, "questions": QUESTIONS, "states": ["x"], "settings": s, "jobs_folder": d})
                self.assertIn(f"settings.{field}", r["error"])

    def test_unknown_family_and_unpinned_weights(self):
        r = self.call("get-ready", {"model": {"classifier": "nope", "weights": {"folder": "/"}}})
        self.assertIn("classifier families", r["error"])
        r = self.call("get-ready", {"model": {"classifier": "questions-first-decider", "weights": {"hugging_face": {"repo": "x/y"}}}})
        self.assertIn("pinned revision", r["error"])

    def test_bad_questions_and_job_ids(self):
        with tempfile.TemporaryDirectory() as d:
            model = {"id": "m", "classifier": "questions-first-decider", "weights": {"folder": d}}
            r = self.call("start", {"model": model, "questions": {"q": {"type": "choice", "instructions": "Which?", "criteria": ["one"]}},
                                    "states": ["x"], "settings": SETTINGS, "jobs_folder": d})
            self.assertIn("question 'q'", r["error"])
            r = self.call("read", {"job_id": "abc", "jobs_folder": d})
            self.assertIn("1f:<64 hex>", r["error"])
        self.assertIn("name one action", self.call_bad())

    def call_bad(self):
        out = io.StringIO()
        with redirect_stdout(out):
            A.main(["x", "explode"])
        return out.getvalue()


if __name__ == "__main__":
    unittest.main()

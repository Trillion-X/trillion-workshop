"""The classifier program's two actions and its refusals, with a made-up classifier family instead of a model (no
weights, no MLX, no network): get-ready names the weights; work reads one request on standard input, says it was
checked, prints each batch's answers as a JSON line as soon as they are known, and ends with its result line; a stop,
asked by the run or by SIGTERM from the run that started it, keeps what finished. It never writes a file. Needs the
blake3 module for get-ready."""
import importlib.util, io, json, os, signal, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))
HAS_BLAKE3 = importlib.util.find_spec("blake3") is not None

import answer_many_states as A  # noqa: E402
import made_up_worker  # noqa: E402,F401 - registers the made-up family

SETTINGS = {"layout": "independent", "dtype": "bfloat16", "tokens_per_batch": 4096, "max_state_tokens": 512, "page_bytes": 300}
QUESTIONS = {"warm": {"type": "noul", "instructions": "Is the lamp warm?"},
             "which": {"type": "choice", "instructions": "Which thing is late?", "criteria": ["parcel", "river"]}}


def lines(text):
    return [json.loads(line) for line in text.strip().splitlines()]


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.model_dir = os.path.join(self.tmp.name, "model")
        os.makedirs(self.model_dir)
        with open(os.path.join(self.model_dir, "config.json"), "w") as f:
            f.write('{"model_type": "made-up"}')
        self.model = {"id": "made-up-model", "classifier": "made-up", "weights": {"folder": self.model_dir}}

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, **kw):
        return {"model": self.model, "questions": QUESTIONS, "states": [f"state {i}" for i in range(7)], "settings": SETTINGS, **kw}

    def call(self, action, request):
        out = io.StringIO()
        code = A.main(["x", action], stdin=io.StringIO(json.dumps(request)), out=out)
        return code, lines(out.getvalue())

    @unittest.skipUnless(HAS_BLAKE3, "needs the blake3 module (python3 -m pip install blake3)")
    def test_get_ready_names_the_weights(self):
        code, said = self.call("get-ready", {"model": self.model})
        r = said[-1]["result"]
        self.assertEqual(code, 0)
        self.assertTrue(r["ready"])
        self.assertTrue(r["identity"].startswith("1f:"))
        self.assertEqual([f["name"] for f in r["files"]], ["config.json"])
        self.assertNotIn("folder", r)                     # a folder is this Mac's; the naming is any computer's

    def test_work_prints_every_answer_once_and_keeps_no_file(self):
        before = sorted(os.listdir(self.tmp.name))
        code, said = self.call("work", self.request())
        self.assertEqual(code, 0)
        self.assertEqual(said[0], {"checked": {"states": 7}})
        answered = [a for line in said[1:-1] for a in line["answered"]]
        self.assertEqual([a["state"] for a in answered], list(range(7)))
        self.assertEqual(answered[3]["answers"]["warm"], {"type": "noul", "noul": 0.253})
        result = said[-1]["result"]
        self.assertEqual((result["status"], result["states_done"], result["states"], result["classifier_answers_as"]), ("finished", 7, 7, "made-up"))
        self.assertGreaterEqual(result["seconds"]["wall"], result["seconds"]["answer"] - 0.01)
        self.assertEqual(sorted(os.listdir(self.tmp.name)), before)

    def test_a_stop_keeps_what_finished(self):
        out = io.StringIO()
        result = A.work(self.request(), out, stop=lambda: len(out.getvalue().splitlines()) >= 2)
        said = lines(out.getvalue())
        self.assertEqual([a["state"] for line in said[1:] for a in line["answered"]], [0, 1])
        self.assertEqual((result["status"], result["states_done"], result["states"]), ("cancelled", 2, 7))

    def test_sigterm_stops_the_running_program_after_its_batch(self):
        request = self.request(settings={**SETTINGS, "made_up_seconds": 0.3})
        p = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "made_up_worker.py"), "work"], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, text=True)
        p.stdin.write(json.dumps(request))
        p.stdin.close()
        said = [json.loads(p.stdout.readline()), json.loads(p.stdout.readline())]
        p.send_signal(signal.SIGTERM)
        said += lines(p.stdout.read())
        p.stdout.close()
        self.assertEqual(p.wait(10), 0)
        self.assertIn("answered", said[1])
        result = said[-1]["result"]
        self.assertEqual(result["status"], "cancelled")
        self.assertLess(result["states_done"], 7)
        self.assertEqual(result["states_done"], sum(len(line["answered"]) for line in said if "answered" in line))


class Refusals(unittest.TestCase):
    def call(self, action, request):
        out = io.StringIO()
        A.main(["x", action], stdin=io.StringIO(json.dumps(request)), out=out)
        return lines(out.getvalue())[-1]

    def test_each_missing_setting_is_named(self):
        with tempfile.TemporaryDirectory() as d:
            model = {"id": "m", "classifier": "questions-first-decider", "weights": {"folder": d}}
            for field in A.SETTINGS:
                s = {k: v for k, v in SETTINGS.items() if k != field}
                r = self.call("work", {"model": model, "questions": QUESTIONS, "states": ["x"], "settings": s})
                self.assertIn(f"settings.{field}", r["error"])

    def test_unknown_family_and_unpinned_weights(self):
        r = self.call("get-ready", {"model": {"classifier": "nope", "weights": {"folder": "/"}}})
        self.assertIn("classifier families", r["error"])
        r = self.call("get-ready", {"model": {"classifier": "questions-first-decider", "weights": {"hugging_face": {"repo": "x/y"}}}})
        self.assertIn("pinned revision", r["error"])

    def test_bad_questions_pages_states_and_actions(self):
        with tempfile.TemporaryDirectory() as d:
            model = {"id": "m", "classifier": "questions-first-decider", "weights": {"folder": d}}
            r = self.call("work", {"model": model, "questions": {"q": {"type": "choice", "instructions": "Which?", "criteria": ["one"]}},
                                   "states": ["x"], "settings": SETTINGS})
            self.assertIn("question 'q'", r["error"])
            r = self.call("work", {"model": model, "questions": QUESTIONS, "states": ["x"], "settings": {**SETTINGS, "page_bytes": 56001}})
            self.assertIn("at most 56000", r["error"])
            r = self.call("work", {"model": model, "questions": QUESTIONS, "states": [], "settings": SETTINGS})
            self.assertIn("at least one state", r["error"])
        self.assertIn("name one action", self.call("start", {})["error"])


if __name__ == "__main__":
    unittest.main()

"""The quote check finds a principle's quote in the caption source its row names: the corpus, or caption files outside it, and tells a
wrong quote from a video with no captions. Ported from the launch-video tests of verify.py, on made-up captions."""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cite_principles", os.path.join(HERE, "..", "do-work", "cite_principles.py"))
cite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cite)


def json3(events):
    return {"events": [{"tStartMs": int(t * 1000), "segs": [{"utf8": s}]} for t, s in events]}


class VerifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        folder = os.path.join(self.tmp.name, "formats", "fam", "captions")
        os.makedirs(folder)
        with open(os.path.join(folder, "vidF.en-orig.json3"), "w") as f:
            json.dump(json3([(0, "hello there"), (12.5, "Next one here, it's the Riley’s case"), (30, "end")]), f)
        self.corpus = {"vidC": {"id": "vidC", "segs": [[3.0, "corpus line one"], [9.0, "corpus line two"]]}}
        self.v = cite.Verifier(self.corpus, [os.path.join(self.tmp.name, "formats", "*", "captions", "{video}.*json3")])

    def tearDown(self):
        self.tmp.cleanup()

    def test_corpus_quote_found_with_second(self):
        self.assertEqual(self.v.find("vidC", "line two"), 9)

    def test_caption_file_quote_found_with_second(self):
        self.assertEqual(self.v.find("vidF", "Next one here"), 12)

    def test_curly_apostrophe_on_either_side(self):
        self.assertEqual(self.v.find("vidF", "it's the Riley's case"), 12)
        self.assertEqual(self.v.find("vidF", "it’s the Riley’s case"), 12)

    def test_wrong_quote_is_bad_not_missing(self):
        self.assertIsNone(self.v.find("vidF", "not said anywhere"))

    def test_unknown_video_is_missing_not_bad(self):
        self.assertEqual(self.v.find("nope", "anything"), "MISSING")

    def test_run_counts_rows(self):
        rows = os.path.join(self.tmp.name, "rows.jsonl")
        with open(rows, "w") as f:
            for r in [{"id": "P-1", "sources": [{"video": "vidF", "quote": "hello there", "t": 0}]},
                      {"id": "P-2", "sources": [{"video": "vidC", "quote": "no such", "t": 3}]},
                      {"id": "P-3", "sources": [{"video": "gone", "quote": "x", "t": 0}]}]:
                f.write(json.dumps(r) + "\n")
        lines = []
        self.assertEqual(cite.verify_rows(rows, self.v, out=lines.append), (3, 3, 1, 1))
        self.assertTrue(any(line.startswith("BAD P-2") for line in lines))
        self.assertTrue(any(line.startswith("MISSING P-3") for line in lines))


if __name__ == "__main__":
    unittest.main()

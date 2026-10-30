"""Events bound to words, not seconds. Run: python3 -I -m unittest discover -s test -v (from the tool folder)"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
READ_DATA = TOOL / "read-data"
DO_WORK = TOOL / "do-work"
sys.path.insert(0, str(READ_DATA))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import sample_registry  # noqa: E402,F401
import wt_ops as ops  # noqa: E402
from wt_core import READERS, Registry, WTError  # noqa: E402

REG = Registry.load()


def timed(words, start=0.0, step=0.3):
    return [{"id": f"w{i}", "t0": round(start + i * step, 3), "t1": round(start + i * step + 0.2, 3),
             "fields": {"text": w}, "one_word": True} for i, w in enumerate(words)]


def piece_with_events():
    p = ops.new_piece("events", "any")
    p["slots"] = {"s-thing": {"type": "TEXT"}}
    p["tokens"] = [
        {"id": "ev-reveal", "unit": "u", "region": "graphic", "t": 2.0, "t1": 3.5, "dims": {"graphic.kind": "reveal"}, "mark": "KEEP"},
        {"id": "ev-break", "unit": "u", "region": "breaks", "t": 5.0, "dims": {"break.kind": "hard"}, "mark": "KEEP"},
        {"id": "ev-free", "unit": "u", "region": "breaks", "t": 9.0, "dims": {"break.kind": "hard"}, "mark": "KEEP"},
    ]
    return p


class BoundToWords(unittest.TestCase):
    def setUp(self):
        p = piece_with_events()
        p = ops.bind(p, ["ev-reveal"], "launch day", edge="start", offset_s=-0.1)
        p = ops.bind(p, ["ev-break"], "the first one", edge="end", slot="s-thing")
        self.piece = p

    def test_event_moves_to_its_words_and_keeps_its_length(self):
        words = timed("we picked launch day for everyone".split())
        out = ops.retime(self.piece, words, REG)
        idx = ops.tok_index(out)
        start = words[2]["t0"]
        self.assertEqual(idx["ev-reveal"]["t"], round(start - 0.1, 3))
        self.assertEqual(round(idx["ev-reveal"]["t1"] - idx["ev-reveal"]["t"], 3), 1.5)
        self.assertEqual(idx["ev-free"]["t"], 9.0)
        self.assertEqual([r["status"] for r in out["notes"]["retime"]], ["moved", "unmatched"])

    def test_a_bound_slot_follows_its_filled_words(self):
        self.piece["fills"]["s-thing"] = {"status": "sourced", "value": "second invoice"}
        words = timed("send the second invoice today".split())
        out = ops.retime(self.piece, words, REG)
        self.assertEqual(ops.tok_index(out)["ev-break"]["t"], words[3]["t1"])

    def test_unmatched_words_keep_their_time_and_are_listed(self):
        out = ops.retime(self.piece, timed("nothing relevant here".split()), REG)
        self.assertEqual(ops.tok_index(out)["ev-reveal"]["t"], 2.0)
        self.assertTrue(all(r["status"] == "unmatched" and r["why"] for r in out["notes"]["retime"]))

    def test_occurrence_picks_the_nth_repeat(self):
        p = ops.bind(piece_with_events(), ["ev-break"], "again", occurrence=2)
        words = timed("again and again then stop".split())
        self.assertEqual(ops.tok_index(ops.retime(p, words, REG))["ev-break"]["t"], words[2]["t0"])

    def test_bad_binding_is_refused_with_a_fix(self):
        for kw in ({"words": " "}, {"words": "x", "edge": "middle"}, {"words": "x", "offset_s": "1"},
                   {"words": "x", "occurrence": 0}):
            with self.assertRaises(WTError):
                ops.bind(piece_with_events(), ["ev-break"], **kw)
        with self.assertRaises(WTError):
            ops.bind(piece_with_events(), ["nope"], "x")
        with self.assertRaises(WTError):
            ops.bind(piece_with_events(), ["ev-break"], "x", slot="not-a-slot")

    def test_validate_flags_a_malformed_binding(self):
        self.piece["tokens"][0]["bound_to"] = {"words": "", "edge": "start"}
        errs, _ = ops.validate(self.piece, REG)
        self.assertTrue(any("bound_to" in e["what"] for e in errs))

    def test_the_input_piece_is_not_changed(self):
        before = json.dumps(self.piece, sort_keys=True)
        ops.retime(self.piece, timed("launch day".split()), REG)
        self.assertEqual(json.dumps(self.piece, sort_keys=True), before)


class SpecBinds(unittest.TestCase):
    def test_a_spec_binds_tokens_and_a_rewrite_moves_them(self):
        records = [{"id": "w0", "t0": 1.0, "t1": 1.2, "fields": {"text": "Meet"}, "one_word": True},
                   {"id": "w1", "t0": 1.3, "t1": 1.5, "fields": {"text": "Ada"}, "one_word": True}]
        spec = {"piece": {"id": "bound", "medium": "video"}, "auto_slot_rules": False,
                "records": {"transcript_words": records},
                "binds": [{"tokens": ["w1"], "words": "Ada", "offset_s": 0.5}]}
        piece = ops.tokenize(spec)
        self.assertEqual(ops.tok_index(piece)["w1"]["bound_to"]['words'], "Ada")
        self.assertEqual(ops.validate(piece, REG)[0], [])
        out = ops.retime(piece, timed("so meet Ada now".split()), REG)
        self.assertEqual(ops.tok_index(out)["w1"]["t"], round(0.6 + 0.5, 3))


class RetimeCli(unittest.TestCase):
    def test_cli_retimes_from_a_word_timed_transcript(self):
        p = ops.bind(piece_with_events(), ["ev-reveal"], "launch day")
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "piece.json").write_text(json.dumps(p))
            words = [{"id": f"w{i}", "text": w, "start": 1.0 + i * 0.5, "end": 1.3 + i * 0.5, "type": "word"}
                     for i, w in enumerate("then launch day came".split())]
            (d / "t.json").write_text(json.dumps({"words": words}))
            r = subprocess.run([sys.executable, "-I", str(DO_WORK / "retime.py"), str(d / "piece.json"), str(d / "t.json"),
                                str(d / "out.json")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("1 of 1 bound tokens re-timed", r.stdout)
            out = json.loads((d / "out.json").read_text())
            self.assertEqual(ops.tok_index(out)["ev-reveal"]["t"], 1.5)
        self.assertIn("transcript_words", READERS)


if __name__ == "__main__":
    unittest.main()

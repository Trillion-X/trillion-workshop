"""do-work/cut_text_into_moments.py on a made-up cloud-results copy and store."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work", "cut_text_into_moments.py")
LIVE = 9223372036854775807
LONG = " ".join(f"Sentence number {i} says a few plain words." for i in range(40))


def results(path):
    db = sqlite3.connect(path)
    db.execute("create table results (identity text, kind text, value text)")
    rows = [("1f:" + "a" * 64, "transcript", {"text": LONG}), ("1f:" + "b" * 64, "transcript", {"text": "Short and real. Two sentences."}),
            ("1f:" + "c" * 64, "transcript", {"text": "Short and real. Two sentences."}), ("1f:" + "d" * 64, "transcript", {"text": "too short"}),
            ("1f:" + "e" * 64, "transcript", {"text": "A store we do not hold."}),
            ("1f:" + "a" * 64, "library-entry", {"name": "walk.mp4", "path": "./walks/walk.mp4", "media_kind": "video"}),
            ("1f:" + "b" * 64, "library-entry", {"name": "note.m4a", "path": "./notes/note.m4a", "media_kind": "audio"}),
            ("1f:" + "a" * 64, "facts", {"duration": 1800.0})]
    db.executemany("insert into results values (?, ?, ?)", [(i, k, json.dumps(v)) for i, k, v in rows])
    db.commit()
    db.close()


HELD = {"aliases": {"a" * 64: "1f:fileA"}, "files": {"1f:fileA": {"origin": "backblaze-b2"}, "1f:" + "b" * 64: {"origin": "cloudflare-r2"}}}


def run(*argv):
    out = subprocess.run([sys.executable, "-I", SCRIPT, *argv], capture_output=True, text=True)
    if out.returncode:
        raise AssertionError(out.stderr)
    return out.stdout, json.loads(out.stdout.strip().split("\n")[-1])["result"]


class CutText(unittest.TestCase):
    def cut(self, work, *store):
        results(os.path.join(work, "results.sqlite"))
        out = os.path.join(work, "out", "moments.jsonl")
        printed, result = run("--results-sqlite", os.path.join(work, "results.sqlite"), "--out", out, *store)
        with open(out, encoding="utf-8") as handle:
            return printed, result, [json.loads(line) for line in handle]

    def test_moments_sources_duplicates_and_coverage(self):
        with tempfile.TemporaryDirectory() as work:
            held = os.path.join(work, "held.json")
            with open(held, "w") as handle:
                json.dump(HELD, handle)
            printed, result, moments = self.cut(work, "--held", held)
            a = [m for m in moments if m["identity"] == "1f:" + "a" * 64]
            self.assertEqual([m["id"] for m in a], ["xaaaaaaaaaaaa#0", "xaaaaaaaaaaaa#1", "xaaaaaaaaaaaa#2"])
            self.assertTrue(all(len(m["text"].split()) <= 120 for m in a))
            self.assertEqual((a[0]["frac_start"], a[-1]["frac_end"], a[0]["est_start"], a[-1]["est_end"]), (0.0, 1.0, 0.0, 1800.0))
            self.assertEqual((a[0]["source"], a[0]["name"], a[0]["timing"]), ("b2", "walk.mp4", "estimated-from-text-position"))
            b = [m for m in moments if m["identity"] == "1f:" + "b" * 64]
            self.assertEqual((b[0]["source"], b[0]["duplicates"], b[0]["est_start"]), ("r2", ["1f:" + "c" * 64], None))
            e = [m for m in moments if m["identity"] == "1f:" + "e" * 64]
            self.assertEqual(e[0]["source"], "drive-only")
            self.assertEqual(result["transcripts"], 3)
            self.assertEqual(result["duplicates_dropped"], 1)
            self.assertEqual(result["moments_by_source"], {"b2": 3, "r2": 1, "drive-only": 1})
            self.assertEqual(result["transcripts_by_source_and_kind"], {"b2 video": 1, "drive-only None": 1, "r2 audio": 1})
            self.assertEqual(result["hours_with_known_length"], 0.5)
            self.assertIn("{'b2': 3, 'r2': 1, 'drive-only': 1} 0.5 hours of media with known duration", printed)

    def test_a_namespace_copy_gives_the_same_sources(self):
        with tempfile.TemporaryDirectory() as work:
            store = os.path.join(work, "a folder", "namespace.sqlite")
            os.makedirs(os.path.dirname(store))
            db = sqlite3.connect(store)
            db.execute("create table versions (id text, resource text, body text, valid_to integer, deleted integer)")
            db.execute("insert into versions values (?, '@namespace/aliases', ?, ?, 0)", ("12:" + "a" * 64, json.dumps({"identity": "1f:fileA"}), LIVE))
            for ident, body in HELD["files"].items():
                db.execute("insert into versions values (?, '@namespace/files', ?, ?, 0)", (ident, json.dumps(body), LIVE))
            db.commit()
            db.close()
            _, result, _ = self.cut(work, "--namespace-sqlite", store)
            self.assertEqual(result["by_source"], {"b2": 1, "r2": 1, "drive-only": 1})


if __name__ == "__main__":
    unittest.main()

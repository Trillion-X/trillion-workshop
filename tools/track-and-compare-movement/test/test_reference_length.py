"""prepare leaves out a reference clip longer than reference_max_seconds and says which, with its length; a length it
probes is kept as a row, and a kept length rules a long reference out without fetching it."""
import os
import subprocess
import sys
import tempfile
import unittest

DO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work")
sys.path.insert(0, DO)
import make_matched_clips as m  # noqa: E402


def video(path, seconds):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size=64x64:rate=10:duration={seconds}", path], check=True)


class ReferenceLength(unittest.TestCase):
    def test_a_long_reference_is_left_out_and_named(self):
        d = tempfile.mkdtemp()
        short, long_ = os.path.join(d, "short.mp4"), os.path.join(d, "long.mp4")
        video(short, 2)
        video(long_, 12)
        files = {"1f:" + "a" * 64: short, "1f:" + "b" * 64: long_, "1f:" + "c" * 64: short}

        class Road:
            @staticmethod
            def fetch(call, identity, path):
                with open(files[identity], "rb") as src, open(path, "wb") as dst:
                    dst.write(src.read())
        sys.modules["files_road"] = Road
        try:
            got = m.prepare({"work": d, "call": ["x"], "models": [], "reference_max_seconds": 8,
                             "targets": [{"name": "/t/one.mp4", "identity": "1f:" + "c" * 64}],
                             "references": [{"name": "/r/short.mp4", "identity": "1f:" + "a" * 64, "class": "forehand"},
                                            {"name": "/r/long practice.mp4", "identity": "1f:" + "b" * 64, "class": "backhand"}]})
        finally:
            sys.modules.pop("files_road", None)
        self.assertEqual(got["references"], 1)
        self.assertEqual([x["name"] for x in got["references_left_out"]], ["/r/long practice.mp4"])
        self.assertGreater(got["references_left_out"][0]["seconds"], 11)

    def test_a_kept_length_rules_a_reference_out_without_fetching_it(self):
        import measured_facts
        d = tempfile.mkdtemp()
        short = os.path.join(d, "short.mp4")
        video(short, 2)
        fetched, written = [], []

        class Road:
            @staticmethod
            def fetch(call, identity, path):
                fetched.append(identity)
                with open(short, "rb") as src, open(path, "wb") as dst:
                    dst.write(src.read())
        long_row = {"identity": "1f:" + "b" * 64, "fact": "length", "part": "", "fingerprint": "", "value": {"seconds": 640.0},
                    "measured_by": {}}
        saved = (measured_facts.read_rows, measured_facts.write_rows)
        measured_facts.read_rows = lambda facts, identities: [long_row]
        measured_facts.write_rows = lambda facts, rows: written.extend(rows) or len(rows)
        sys.modules["files_road"] = Road
        try:
            got = m.prepare({"work": d, "call": ["x"], "models": [], "reference_max_seconds": 8, "facts": {"table": "t"},
                             "targets": [], "references": [{"name": "/r/short.mp4", "identity": "1f:" + "a" * 64},
                                                           {"name": "/r/long.mov", "identity": "1f:" + "b" * 64}]})
        finally:
            sys.modules.pop("files_road", None)
            measured_facts.read_rows, measured_facts.write_rows = saved
        self.assertEqual(fetched, ["1f:" + "a" * 64])                  # the long one is known long: never fetched
        self.assertEqual([x["name"] for x in got["references_left_out"]], ["/r/long.mov"])
        self.assertEqual([(r["identity"], r["fact"]) for r in written], [("1f:" + "a" * 64, "length")])  # probed once, kept

    def test_an_unreadable_file_has_no_length(self):
        self.assertIsNone(m.duration("/no/such/file.mp4"))


if __name__ == "__main__":
    unittest.main()

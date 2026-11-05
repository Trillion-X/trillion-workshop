"""The person's registry and discovery read from their list:settings row (--settings-record), through tools/settings.

Made-up data only: an invented tasting-note registry and an invented launch line.
Run: python3 -I test/test_settings_record.py (from the tool folder).
"""
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
DO_WORK = TOOL / "do-work"
READ_DATA = TOOL / "read-data"
sys.path.insert(0, str(READ_DATA))
sys.path.insert(0, str(TOOL.parent / "settings" / "read-data"))

import settings  # noqa: E402
from wt_core import Registry, WTError, registry_for, tool_settings  # noqa: E402

FOLDER = TOOL.name
WORDS = "we poured three cups of the new roast and everyone smiled".split()


def transcript(words):
    return {"language": "en", "words": [{"id": f"w{i}", "text": w, "start": round(i * 0.3, 3), "end": round(i * 0.3 + 0.2, 3),
                                         "type": "word", "speaker": "S0"} for i, w in enumerate(words)]}


def own_registry():
    """The shipped registry plus one invented dimension, as a person would keep it in their settings row."""
    data = json.loads((READ_DATA / "dimensions.json").read_text(encoding="utf-8"))
    data["dimensions"].append({"id": "taste.note", "name": "tasting note", "media": ["podcast"], "region": "speech",
                               "value_kind": "category", "measure": [{"method": "a taster writes it down"}],
                               "drift": {"threshold": 1.0}})
    return data


def row(scope_kind="account", scope_id="main", values=None, status="active"):
    return settings.make_record(FOLDER, scope_kind, scope_id, values if values is not None else {"registry": own_registry()},
                                name="made-up registry", tool="tool:make-a-word-template", source="test@0000000", status=status)


class Tmp:
    def __init__(self):
        self.td = tempfile.TemporaryDirectory(prefix="wt-settings-")
        self.dir = Path(self.td.name)

    def write(self, name, data):
        p = self.dir / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
        return p


def run(*args):
    return subprocess.run([sys.executable, "-I", *map(str, args)], capture_output=True, text=True)


class SettingsRecord(unittest.TestCase):
    def setUp(self):
        self.tmp = Tmp()
        self.addCleanup(self.tmp.td.cleanup)
        t = self.tmp
        self.transcript = t.write("transcript.json", transcript(WORDS))
        self.spec = t.write("spec.json", {"schema": "word-template-spec@1", "piece": {"id": "roast", "medium": "podcast"},
                                          "sources": {"transcript_words": str(self.transcript)},
                                          "slots": [{"id": "count", "type": "NUMBER", "note": "how many", "rule": "R1-number", "tokens": ["w2"]}]})
        self.record = t.write("setting.json", row())

    def make(self, *extra, name="TEMPLATE.json"):
        out = self.tmp.dir / name
        r = run(DO_WORK / "make_template.py", self.spec, out, *extra)
        self.assertEqual(r.returncode, 0, r.stderr)
        return out, json.loads(out.read_text())

    def test_registry_comes_from_the_row_and_the_template_remembers_it(self):
        out, tpl = self.make("--settings-record", self.record)
        self.assertEqual(tpl["registry"], f"setting:record:setting:{FOLDER}~account~main")
        self.assertIn("taste.note", [p["dim"] for p in tpl["pending"]], "the row's own dimension was not used")
        self.assertNotIn("taste.note", [p["dim"] for p in self.make(name="SHIPPED.json")[1]["pending"]], "the shipped registry knows no tasting note")

        source = self.tmp.write("notes.txt", "we poured four cups\n")
        fills = self.tmp.write("fills.json", {"fills": {"count": {"value": "four", "sources": [f"{source}:1"]}}})
        md = self.tmp.dir / "fill.md"
        refused = run(DO_WORK / "fill.py", out, fills, md)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("--settings-record", refused.stderr)
        filled = run(DO_WORK / "fill.py", out, fills, md, "--settings-record", self.record)
        self.assertEqual(filled.returncode, 0, filled.stderr)
        self.assertIn("1 slots filled", filled.stdout)
        drift = run(DO_WORK / "drift.py", out, md, "--check", "--settings-record", self.record)
        self.assertEqual(drift.returncode, 0, drift.stdout + drift.stderr)

    def test_a_registry_file_beats_the_row(self):
        own = self.tmp.write("own.json", own_registry())
        _, tpl = self.make("--settings-record", self.record, "--registry", own)
        self.assertEqual(Path(tpl["registry"]), own)

    def test_scope_picks_the_most_specific_row(self):
        values = own_registry()
        values["dimensions"][-1]["id"] = "taste.finish"
        both = self.tmp.write("both.json", [row(), row("film", "roast-film", {"registry": values})])
        many = run(DO_WORK / "make_template.py", self.spec, self.tmp.dir / "T.json", "--settings-record", both)
        self.assertEqual(many.returncode, 2)
        self.assertIn("no scope", many.stderr)
        _, tpl = self.make("--settings-record", both, "--scope", "film:roast-film", "--scope", "account:main")
        self.assertIn("taste.finish", [p["dim"] for p in tpl["pending"]])
        _, tpl = self.make("--settings-record", both, "--scope", "film:other", "--scope", "account:main")
        self.assertIn("taste.note", [p["dim"] for p in tpl["pending"]])

    def test_refusals_say_how_to_fix(self):
        retired = self.tmp.write("retired.json", row(status="retired"))
        r = run(DO_WORK / "make_template.py", self.spec, self.tmp.dir / "T.json", "--settings-record", retired)
        self.assertEqual(r.returncode, 2)
        self.assertIn("retired", r.stderr)
        other = settings.make_record("some-other-tool", "account", "main", {"registry": {}}, name="x", tool="tool:x", source="x")
        with self.assertRaises(WTError):
            tool_settings([other], [("account", "main")])
        with self.assertRaises(WTError):
            registry_for(None, None, ({"registry": []}, "record:setting:x~account~main"))
        bad = run(DO_WORK / "make_template.py", self.spec, self.tmp.dir / "T.json", "--settings-record", self.record, "--scope", "account")
        self.assertEqual(bad.returncode, 2)
        self.assertIn("KIND:ID", bad.stderr)
        with self.assertRaises(WTError):
            Registry.load(f"setting:record:setting:{FOLDER}~account~main")

    def test_build_reads_discovery_and_films_from_the_row(self):
        t = self.tmp
        item = t.dir / "library/pieces/roast"
        item.mkdir(parents=True)
        t.write("library/transcripts/roast.json", transcript(WORDS))
        t.write("library/fills/roast/a.md", "```dim:speech.word\n" + " ".join(WORDS) + "\n```\n")
        discovery = {"root": str(t.dir),
                     "references": {"glob": "library/pieces/*/", "medium": "podcast", "out": "{dir}TEMPLATE.json",
                                    "sources": {"transcript_words": "library/transcripts/{id}.json"}},
                     "fills": {"glob": "library/fills/*/*.md", "template": "library/pieces/{fill_dir}/TEMPLATE.json",
                               "out": "out/{fill_dir}.{stem}"},
                     "films": {"films": [{"film": "own", "reference_template": "library/pieces/roast/TEMPLATE.json",
                                          "why": "nothing measured yet"}]},
                     "manifest": "out/manifest.json", "index": "out/INDEX.md"}
        record = t.write("build-setting.json", row(values={"registry": own_registry(), "discovery": discovery}))

        def build():
            r = run(DO_WORK / "build.py", "--settings-record", record)
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout.strip().splitlines()[-1])

        first = build()
        self.assertEqual((first["templates_built"], first["drifts_built"]), (1, 1))
        tpl = json.loads((item / "TEMPLATE.json").read_text())
        self.assertTrue(tpl["registry"].startswith("setting:"))
        self.assertIn("film:own", json.loads((t.dir / "out/manifest.json").read_text()))
        self.assertIn("--settings-record", (t.dir / "out/INDEX.md").read_text())
        again = build()
        self.assertEqual((again["templates_built"], again["drifts_built"]), (0, 0))
        time.sleep(0.01)
        changed = own_registry()
        changed["dimensions"][-1]["name"] = "tasting note, renamed"
        t.write("build-setting.json", row(values={"registry": changed, "discovery": discovery}))
        self.assertEqual(build()["templates_built"], 1, "a changed registry in the row did not rebuild")
        none = run(DO_WORK / "build.py", "--settings-record", self.record)
        self.assertEqual(none.returncode, 2)
        self.assertIn("no discovery", none.stderr)


if __name__ == "__main__":
    unittest.main()

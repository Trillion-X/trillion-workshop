import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("listing", Path(__file__).resolve().parents[1] / "read-data" / "list_inputs.py")
listing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(listing)

class ListingTests(unittest.TestCase):
    def fixture(self, root):
        files = {"worker.py": 'os.environ.get("SCAN_EXAMPLE")\nos.environ["WHISPER_BACKEND"]\nos.environ["HOME"]\n',
                 "with space.mjs": 'process.env.SCAN_EXAMPLE; placeReports("REPORTED_EXAMPLE"); place.reported("OTHER_EXAMPLE");',
                 "setup.sh": 'echo "${SHELL_EXAMPLE:?set it}"',
                 "gone.py": None}
        for name, text in files.items():
            if text is not None: (root / name).write_text(text)
        return types.SimpleNamespace(stdout="\n".join(files)+"\n")

    def test_scans_all_original_input_forms_and_keeps_spaces_in_filenames(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = self.fixture(root)
            with mock.patch.object(listing.subprocess, "run", return_value=output) as run:
                found = listing.inputs(root)
            self.assertEqual(set(found), {"SCAN_EXAMPLE", "WHISPER_BACKEND", "REPORTED_EXAMPLE", "OTHER_EXAMPLE", "SHELL_EXAMPLE"})
            self.assertEqual(found["SCAN_EXAMPLE"], {"worker.py", "with space.mjs"})
            argv = run.call_args.args[0]
            self.assertEqual(argv[:4], ["git", "-C", str(root), "ls-files"])
            self.assertIn(":!**/tests/**", argv)
            self.assertIn(":!tools/list-a-repositorys-place-inputs/read-data/list_inputs.py", argv)
            self.assertTrue(run.call_args.kwargs["check"])

    def invoke(self, root, args):
        out = io.StringIO()
        with mock.patch.object(listing.subprocess, "run", return_value=self.fixture(root)), mock.patch("sys.stdout", out):
            self.assertEqual(listing.main(["--root", str(root), *args]), 0)
        return out.getvalue()

    def test_json_reports_presence_without_environment_values(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SCAN_EXAMPLE":"private-example-value"}):
            out = self.invoke(Path(tmp), ["--json"])
        self.assertNotIn("private-example-value", out)
        rows = {r["name"]:r for r in json.loads(out)["inputs"]}
        self.assertTrue(rows["SCAN_EXAMPLE"]["set"])
        self.assertTrue(rows["WHISPER_BACKEND"]["run_switch"])
        self.assertFalse(rows["SCAN_EXAMPLE"]["run_switch"])

    def test_missing_omits_set_values_and_run_switches_in_both_formats(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SCAN_EXAMPLE":"set"}, clear=True):
            plain = self.invoke(Path(tmp), ["--missing"])
            rows = json.loads(self.invoke(Path(tmp), ["--json", "--missing"]))["inputs"]
        self.assertNotIn("SCAN_EXAMPLE", plain)
        self.assertNotIn("WHISPER_BACKEND", plain)
        self.assertEqual([r["name"] for r in rows], ["OTHER_EXAMPLE", "REPORTED_EXAMPLE", "SHELL_EXAMPLE"])
        self.assertIn("SHELL_EXAMPLE", plain)

    def test_original_markdown_and_run_switch_section_remain(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = self.invoke(Path(tmp), [])
        self.assertTrue(out.startswith("| Input | Files | Read in |"))
        self.assertIn("| `SCAN_EXAMPLE` | 2 |", out)
        self.assertIn("Run switches, set by one run and not by the place: `WHISPER_BACKEND`.", out)

if __name__ == "__main__": unittest.main()

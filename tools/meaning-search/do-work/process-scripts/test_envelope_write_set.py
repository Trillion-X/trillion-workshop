"""Adversarial proof for the generic process Envelope write-set leaf."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
SCRIPT = HERE / "envelope_write_set.py"
spec = importlib.util.spec_from_file_location("envelope_write_set", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_manifest_contains_only_routes_and_payload_files_preserve_exact_bytes() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        destination = Path(temporary) / "writes.json"
        manifest = mod.write_envelope_write_set([
            {"address": "record::one", "path": ["current-item", "published-record"],
             "payload": {"message": "héllo", "nested": [1, True]}},
            {"address": "record::two", "path": ["current-item"], "remove": True},
        ], str(destination))
        assert manifest == json.loads(destination.read_text(encoding="utf-8"))
        assert manifest["version"] == 1
        assert manifest["writes"] == [
            {"address_label": "record::one", "address_mode": "identity_text",
             "path_labels": ["current-item", "published-record"],
             "content_path": "payloads/0.json"},
            {"address_label": "record::two", "address_mode": "identity_text",
             "path_labels": ["current-item"], "remove": True},
        ]
        manifest_text = destination.read_text(encoding="utf-8")
        assert "héllo" not in manifest_text and "message" not in manifest_text
        assert (destination.parent / "payloads/0.json").read_bytes() == (
            b'{"message":"h\xc3\xa9llo","nested":[1,true]}'
        )


def test_rejects_malformed_duplicate_and_empty_rows() -> None:
    invalid_rows = [
        [{"address": "", "path": ["path"], "payload": {}}],
        [{"address": "a", "path": [], "payload": {}}],
        [{"address": "a", "path": ["p"], "payload": [],}],
        [{"address": "a", "path": ["p"], "payload": {}, "remove": True}],
        [{"address": "a", "path": ["p"], "remove": False}],
        [{"address": "a", "path": ["p"], "remove": True},
         {"address": "a", "path": ["p"], "payload": {}}],
    ]
    for rows in invalid_rows:
        with unittest.TestCase().assertRaises(ValueError):
            mod.manifest_and_payloads(rows)


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for name, candidate in sorted(globals().items()):
        if name.startswith("test_") and callable(candidate):
            suite.addTest(unittest.FunctionTestCase(candidate))
    return suite

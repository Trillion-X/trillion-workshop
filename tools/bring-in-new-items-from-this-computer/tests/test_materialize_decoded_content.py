#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "do-work/process-scripts/materialize-decoded-content.py"
SPEC = importlib.util.spec_from_file_location("materialize_decoded_content", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


ATOM_REF = "atom:1f:" + "a" * 64
THREAD_REF = "thread:source:resend-agent-inbox:message-1"


def request():
    return {
        "event_id": "msg_123",
        "source_ref": "source:resend-agent-inbox",
        "observed_at": "2026-08-11T00:00:00Z",
        "decoded": {
            "threads": [{"thread_ref": THREAD_REF}],
            "atoms": [{
                "atom_ref": ATOM_REF,
                "thread_ref": THREAD_REF,
                "source_ref": "source:resend-agent-inbox",
                "kind": "utterance",
                "content": {"text": "hello"},
            }],
            "rejections": [],
        },
    }


class MaterializeDecodedContentTest(unittest.TestCase):
    def test_input_ceiling_matches_the_rfc5322_decoder_ceiling(self):
        self.assertEqual(MODULE.MAX_INPUT_BYTES, 25 * 1024 * 1024)

    def test_emits_one_atom_and_one_deterministic_receipt(self):
        first = MODULE.materialize(request())
        second = MODULE.materialize(request())
        self.assertTrue(first["accepted"])
        self.assertEqual(first, second)
        self.assertEqual(first["writes"][0]["address"], ATOM_REF)
        self.assertEqual(first["writes"][0]["payload"]["kind"], "observed-content.content-atom")
        self.assertEqual(first["writes"][1]["payload"]["atom_count"], 1)

    def test_decoder_rejection_writes_nothing(self):
        value = request()
        value["decoded"]["rejections"] = [{"reason": "bad-message"}]
        result = MODULE.materialize(value)
        self.assertFalse(result["accepted"])
        self.assertEqual(result["writes"], [])

    def test_rejects_noncanonical_atom_identity(self):
        value = request()
        value["decoded"]["atoms"][0]["atom_ref"] = "../../escape"
        with self.assertRaisesRegex(ValueError, "canonical"):
            MODULE.materialize(value)

    def test_rejects_cross_source_atom(self):
        value = request()
        value["decoded"]["atoms"][0]["source_ref"] = "source:other"
        with self.assertRaisesRegex(ValueError, "source_ref"):
            MODULE.materialize(value)


if __name__ == "__main__":
    unittest.main()

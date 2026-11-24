"""Adversarial whole tools:run receipts: a nested chat answer cannot erase owner failure."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

FOLDER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("receipt_command", FOLDER / "do-work/cite_principles.py")
command = importlib.util.module_from_spec(spec)
spec.loader.exec_module(command)


def receipt():
    return {"exit_code": 0, "replayed": False, "tool": "tool:ask-a-model", "result": {
        "model": "reported-model", "served_by": "reported-route", "usage": {},
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": '{"rows": []}'}}]}}


class WholeOwnerReceiptTest(unittest.TestCase):
    def setUp(self):
        resolver = patch.object(command, "installed_model_cli", return_value="fixture-cli")
        resolver.start(); self.addCleanup(resolver.stop)

    def ask(self, payload):
        completed = SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")
        with patch.object(command.subprocess, "run", return_value=completed):
            return command.Model({"transport": "workshop", "job": "do-a-task-step", "max_tokens": 2000}).ask("system", "user")

    def test_whole_success_retains_owner_status_and_replay_evidence(self):
        for replayed in (False, True):
            with self.subTest(replayed=replayed):
                value = receipt(); value["replayed"] = replayed
                content, _, provenance = self.ask(value)
                self.assertEqual(json.loads(content), {"rows": []})
                self.assertEqual(provenance["owner_receipt"], {
                    "exit_code": 0, "tool": "tool:ask-a-model", "replayed": replayed})

    def test_failure_status_is_not_laundered_by_success_shaped_nested_result(self):
        for status in (1, -1, "0", None, True, False):
            with self.subTest(status=status), self.assertRaises(ValueError):
                value = receipt(); value["exit_code"] = status
                self.ask(value)

    def test_error_flags_are_absent_or_exact_boolean_false_on_both_receipt_levels(self):
        for level in ('outer','reply'):
            for flag in (True,0,1,None,[],{},''):
                value=receipt();target=value if level=='outer' else value['result'];target['isError']=flag
                with self.subTest(level=level,flag=flag),self.assertRaises(ValueError):self.ask(value)
            value=receipt();target=value if level=='outer' else value['result'];target['isError']=False
            self.assertEqual(json.loads(self.ask(value)[0]),{'rows':[]})

    def test_missing_status_wrong_tool_or_ambiguous_wrapper_is_refused(self):
        cases = []
        for field in ("exit_code", "tool", "result"):
            value = receipt(); del value[field]; cases.append(value)
        value = receipt(); value["tool"] = "tool:something-else"; cases.append(value)
        value = receipt(); value["choices"] = copy.deepcopy(value["result"]["choices"]); cases.append(value)
        cases.append(receipt()["result"])
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.ask(value)


if __name__ == "__main__":
    unittest.main()

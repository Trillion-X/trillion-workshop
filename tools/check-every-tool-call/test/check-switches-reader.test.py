#!/usr/bin/env python3
"""Synthetic-only tests of the declared list-owner process boundary."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "do-work"))
import check_switches  # noqa: E402

RULES = {"rows_from": {"command": ["synthetic-list-reader"], "page": 2, "timeout_seconds": 5},
         "types": [{"type": "record:example", "id_prefix": "record:example:"}]}
KIND = RULES["types"][0]


class Reader(unittest.TestCase):
    def test_request_is_stdin_data_and_never_a_shell_command_or_authentication(self):
        reply = subprocess.CompletedProcess([], 0, '{"records":[],"next":null}', "")
        with mock.patch.object(check_switches.subprocess, "run", return_value=reply) as run:
            self.assertEqual(check_switches.list_page(RULES, {**KIND, "where": {"kind": "check"}}, "prior"),
                             {"records": [], "next": None})
        self.assertEqual(run.call_args.args, (["synthetic-list-reader"],))
        self.assertEqual(json.loads(run.call_args.kwargs["input"]),
                         {"type": "record:example", "limit": 2, "where": {"kind": "check"}, "after": "prior"})
        self.assertEqual(run.call_args.kwargs["timeout"], 5)
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertFalse(hasattr(check_switches, "door_key"))
        self.assertFalse(hasattr(check_switches, "door_url"))

    def test_environment_names_a_json_argument_list_not_shell_text(self):
        rules = {"rows_from": {"command_from": {"env": "SYNTHETIC_LIST_COMMAND"}}}
        with mock.patch.dict(os.environ, {"SYNTHETIC_LIST_COMMAND": '["reader","one argument"]'}):
            self.assertEqual(check_switches.reader_command(rules), ["reader", "one argument"])
        for value in ("", "reader --anything", "[]", '["reader",null]'):
            with self.subTest(value=value), mock.patch.dict(os.environ, {"SYNTHETIC_LIST_COMMAND": value}):
                with self.assertRaises(RuntimeError):
                    check_switches.reader_command(rules)

    def test_page_size_and_deadline_are_bounded_before_starting_a_reader(self):
        for field, value in (("page", True), ("page", 0), ("page", 1001), ("timeout_seconds", 0),
                             ("timeout_seconds", 181), ("timeout_seconds", True)):
            rules = {**RULES, "rows_from": {**RULES["rows_from"], field: value}}
            with self.subTest(field=field, value=value), mock.patch.object(check_switches.subprocess, "run") as run:
                with self.assertRaises(RuntimeError):
                    check_switches.list_page(rules, KIND, None)
                run.assert_not_called()

    def test_timeout_and_start_failure_do_not_repeat_command_or_private_output(self):
        for error in (subprocess.TimeoutExpired(["private-command"], 5, output="private-output"),
                      OSError("private-path")):
            with self.subTest(error=type(error).__name__), mock.patch.object(check_switches.subprocess, "run", side_effect=error):
                with self.assertRaises(RuntimeError) as caught:
                    check_switches.list_page(RULES, KIND, None)
                self.assertNotIn("private", str(caught.exception))

    def test_a_failed_process_cannot_return_a_successful_empty_page(self):
        reply = subprocess.CompletedProcess([], 1, '{"records":[],"next":null}', "private")
        with mock.patch.object(check_switches.subprocess, "run", return_value=reply):
            with self.assertRaisesRegex(RuntimeError, r"failed \(exit 1\)"):
                check_switches.list_page(RULES, KIND, None)

    def test_repeated_cursors_stop_the_walk_instead_of_accepting_a_partial_list(self):
        reply = subprocess.CompletedProcess([], 0, '{"records":[],"next":"same"}', "")
        with mock.patch.object(check_switches.subprocess, "run", return_value=reply) as run:
            with self.assertRaisesRegex(RuntimeError, "repeated a page cursor"):
                check_switches.read_rows(RULES)
        self.assertEqual(run.call_count, 2)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
# tools/check-against-a-persons-rules-and-verdicts/test/test_reader_knowledge.py
"""do-work/reader_knowledge.py on made-up passages and made-up rules (the rules are the person's DATA, handed in: here a
made-up block in their shape). Ported from source-repo-a tools/copy-gate/tests/test_reader_knowledge.py: its
cases on the person's own book (pinned by BLAKE3 in their files) run on their computer through
the mac-parity script, never here. Needs spaCy 3.8 and its small English model; without them it skips."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / "do-work"))
import reader_knowledge as rk  # noqa: E402

try:
    import spacy  # noqa: F401
    spacy.load("en_core_web_sm")
    HAS_PARSER = True
except Exception:  # noqa: BLE001 - any missing piece means the parser cannot run here
    HAS_PARSER = False

RULES = {
    "parser": {"model": "en_core_web_sm", "version": "3.8.0"},
    "heading_kinds": ["heading", "title"],
    "rules": [
        {"id": "unintroduced-reference", "outcome": "uncertain", "says": "A made-up note: a thing from the writer's past named before it is introduced.",
         "applies_to_kinds": ["paragraph", "narrator", "voiceover", "onscreen"]},
        {"id": "label-assigned-not-defined", "outcome": "fail", "says": "A made-up note: a label assigned and never defined.",
         "applies_to_kinds": ["paragraph", "narrator", "voiceover"]},
        {"id": "section-opens-with-a-label", "outcome": "fail", "says": "A made-up note: a section opens by calling this a category.",
         "applies_to_kinds": ["paragraph", "narrator"]},
        {"id": "label-colon-command", "outcome": "fail", "says": "A made-up note: a named concept credited, then a command with a colon.",
         "applies_to_kinds": ["paragraph", "narrator", "voiceover"]},
    ],
    "word_classes": {
        "first_person": ["i", "we"],
        "pointing_back": ["this", "that", "these", "those", "it"],
        "not_a_specific_thing": ["same", "other", "first", "last", "next", "whole", "rest", "only", "most", "best"],
        "defining_verbs": ["be", "mean", "describe", "refer"],
        "naming_phrases": ["i mean by", "what i mean by", "i call", "is called", "are called", "what i call", "known as", "called"],
        "restricting_followers": ["i", "you", "we", "he", "she", "they", "that", "which", "who", "where", "when", "of", "in", "on", "from",
                                  "for", "with", "at", "to", "between", "behind", "inside"],
    },
}


class RulesAreInput(unittest.TestCase):
    def test_rules_come_from_the_request_or_the_settings_holding_them(self):
        self.assertEqual(rk.rules_of(RULES), RULES)
        self.assertEqual(rk.rules_of({"reader_knowledge": RULES, "readers": {}}), RULES)
        with self.assertRaises(ValueError):
            rk.rules_of({"readers": {}})

    def test_a_request_without_rules_or_units_is_refused(self):
        tool = HERE / "do-work" / "reader_knowledge.py"
        for request in ({"units": []}, {"rules": RULES}):
            run = subprocess.run([sys.executable, "-I", str(tool), "run"], input=json.dumps(request), capture_output=True, text=True)
            self.assertEqual(run.returncode, 2, run.stdout)
            self.assertIn("error", json.loads(run.stdout.strip().splitlines()[-1]))


@unittest.skipUnless(HAS_PARSER, "spaCy 3.8 and en_core_web_sm are not installed in this Python")
class ReaderKnowledge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.checker = rk.Checker(RULES)

    def findings(self, text):
        return self.checker.check(rk.blocks_from_markdown(text))

    def test_a_thing_from_the_writers_past_needs_an_introduction_first(self):
        told = "I was building a popcorn brand for people on a cut.\n\nWhen I was working on the popcorn, I wanted more protein."
        untold = "Protein matters on a cut.\n\nWhen I was working on the popcorn, I wanted more protein."
        self.assertEqual([f["rule"] for f in self.findings(told)], [])
        self.assertEqual([(f["rule"], f["span"], f["outcome"]) for f in self.findings(untold)], [("unintroduced-reference", "the popcorn", "uncertain")])
        # a scene the text sets up, or a phrase that says which one, is not the writer's private past
        self.assertEqual(self.findings("When you serve, the racket meets the ball.\n\nI needed the screen in front of me."), [])

    def test_an_assigned_role_needs_a_definition_somewhere_in_the_text(self):
        bare = "You hit the ball. The ball is the target."
        defined = "The target is what the agent acts on. You hit the ball. The ball is the target."
        self.assertEqual([(f["rule"], f["span"]) for f in self.findings(bare)], [("label-assigned-not-defined", "target")])
        self.assertEqual(self.findings(defined), [])
        self.assertEqual(self.findings("You predicted a win and lost. That mismatch is the crack."), [])

    def test_a_section_that_opens_by_labelling_this(self):
        self.assertEqual([f["rule"] for f in self.findings("## Start\n\nThis is a movement for builders. Come in.")], ["section-opens-with-a-label"])
        self.assertEqual(self.findings("## Start\n\nI build tools. This is a movement for builders."), [])

    def test_label_colon_command_versus_an_explanation(self):
        command = "The **Kitchen Method** keeps the meal honest. Weigh the food: every gram, every time."
        explained = "The **Kitchen Method** weighs every gram, because a guess hides the calories. I weigh the food before I cook it."
        self.assertEqual([f["rule"] for f in self.findings(command)], ["label-colon-command"])
        self.assertEqual(self.findings(explained), [])

    def test_film_units_and_exit_codes(self):
        """Units in reading order; "This is ..." in narration points at the picture, so the section-opening row does not
        read voiceover."""
        units = [{"text": "This is Sam.", "kind": "voiceover", "where": "a"},
                 {"text": "When I was working on the popcorn, I wanted more protein.", "kind": "voiceover", "where": "b"}]
        tool = HERE / "do-work" / "reader_knowledge.py"
        with tempfile.TemporaryDirectory() as tmp:
            path, rules = Path(tmp) / "units.json", Path(tmp) / "rules.json"
            path.write_text(json.dumps(units))
            rules.write_text(json.dumps({"reader_knowledge": RULES}))
            run = subprocess.run([sys.executable, "-I", str(tool), "check", str(path), "--units", "--rules", str(rules), "--json", str(Path(tmp) / "out.json")],
                                 capture_output=True, text=True)
            self.assertEqual(run.returncode, 3, run.stderr)
            out = json.loads((Path(tmp) / "out.json").read_text())
            self.assertEqual([(f["rule"], f["line"]) for f in out["findings"]], [("unintroduced-reference", "b")])
            path.write_text("not json")
            self.assertEqual(subprocess.run([sys.executable, "-I", str(tool), "check", str(path), "--units", "--rules", str(rules)],
                                            capture_output=True, text=True).returncode, 2)

    def test_the_json_request_answers_the_same_findings(self):
        tool = HERE / "do-work" / "reader_knowledge.py"
        request = {"units": [{"text": "When I was working on the popcorn, I wanted more protein.", "kind": "voiceover", "where": 0}], "settings": {"reader_knowledge": RULES}}
        run = subprocess.run([sys.executable, "-I", str(tool), "run"], input=json.dumps(request), capture_output=True, text=True)
        answer = json.loads(run.stdout.strip().splitlines()[-1])["result"]
        self.assertEqual([(f["rule"], f["line"]) for f in answer["findings"]], [("unintroduced-reference", 0)])
        self.assertEqual(answer["status"], "uncertain")


if __name__ == "__main__":
    unittest.main()

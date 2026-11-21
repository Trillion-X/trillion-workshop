"""Tests of do-work/read_back_check.py: the read-back rule on made-up heard words, with no model."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'do-work'))
import read_back_check  # noqa: E402


def run(script, heard_rows):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'heard.json')
        with open(path, 'w', encoding='utf8') as f:
            json.dump(heard_rows, f)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = read_back_check.main([script, path])
    return code, json.loads(out.getvalue())


def heard(text):
    return [{'text': text, 'source': 'microphone', 'start_ms': 0, 'end_ms': 1000, 'me': True}]


class ReadBackRule(unittest.TestCase):
    def test_exact_read_back_passes(self):
        code, out = run('the racket is the last link in the chain.', heard('The racket is the last link in the chain.'))
        self.assertEqual(code, 0)
        self.assertEqual(out, {'result': {'ok': True, 'script_words': 9, 'missing': []}})

    def test_extra_heard_words_pass(self):
        code, out = run('watch it slowed down.', heard('Okay, watch it slowed down, right?'))
        self.assertEqual(code, 0)
        self.assertTrue(out['result']['ok'])

    def test_a_dropped_word_fails_and_is_named(self):
        code, out = run('watch it slowed down.', heard('watch it slow down'))
        self.assertEqual(code, 1)
        self.assertEqual(out['result'], {'ok': False, 'script_words': 4, 'missing': ['slowed']})

    def test_a_swapped_word_fails(self):
        code, out = run('the racket whips through', heard('the whips racket through'))
        self.assertEqual(code, 1)
        self.assertEqual(out['result']['missing'], ['whips'])

    def test_digits_and_words_match_either_way(self):
        code, _ = run('4 hands', heard('four hands'))
        self.assertEqual(code, 0)
        code, _ = run('twenty one', heard('21'))
        self.assertEqual(code, 0)

    def test_case_and_punctuation_are_ignored(self):
        code, _ = run("Federer's forehand!", heard('federers   FOREHAND'))
        self.assertEqual(code, 0)

    def test_refused_inputs(self):
        code, out = run('   ', heard('anything'))
        self.assertEqual(code, 2)
        self.assertIn('error', out)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'heard.json')
            with open(path, 'w', encoding='utf8') as f:
                json.dump([{'no_text': 1}], f)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = read_back_check.main(['hello', path])
        self.assertEqual(code, 2)
        self.assertIn('error', json.loads(out.getvalue()))


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Checks on made-up pages: exact words, smart quotes, entities, scripts, a wrong speaker, a missing page."""
import json, os, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'do-work'))
import check_words as cw

TRANSCRIPT = """<html><script>var x = "You play the ball";</script><body>
<p>Q. How did you stay calm?</p><p>ALEX MORGAN: I told myself to breathe. You play the ball, you don&#8217;t play the opponent.</p>
<p>Q. And your coach?</p><p>SAM REED: Just watch the ball — nothing else.</p></body></html>"""
ESSAY = "<article><h1>A letter</h1><p>In the good moments, I never thought I was a hero… and in the bad ones, never a failure.</p></article>"


class Checks(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.transcript = os.path.join(self.dir, 'transcript.html'); open(self.transcript, 'w').write(TRANSCRIPT)
        self.essay = os.path.join(self.dir, 'essay.html'); open(self.essay, 'w').write(ESSAY)

    def one(self, **check):
        return cw.check_one({'id': 'c', **check})

    def test_exact_words_under_the_right_speaker(self):
        r = self.one(file=self.transcript, words="You play the ball, you don't play the opponent.", speaker_label='ALEX MORGAN')
        self.assertTrue(r['found']); self.assertEqual(r['speaker_seen'], 'ALEX MORGAN'); self.assertTrue(r['verified'])

    def test_words_under_another_speaker_are_refused(self):
        r = self.one(file=self.transcript, words='Just watch the ball - nothing else.', speaker_label='ALEX MORGAN')
        self.assertTrue(r['found']); self.assertEqual(r['speaker_seen'], 'SAM REED'); self.assertFalse(r['verified'])

    def test_words_in_a_script_do_not_count(self):
        r = self.one(file=self.transcript, words='var x')
        self.assertFalse(r['found'])

    def test_paraphrase_is_not_found(self):
        r = self.one(file=self.transcript, words='Play the ball, not the opponent.')
        self.assertFalse(r['found']); self.assertFalse(r['verified'])

    def test_smart_punctuation_matches_plain(self):
        r = self.one(file=self.essay, words='I never thought I was a hero... and in the bad ones, never a failure.')
        self.assertTrue(r['verified'])

    def test_unlabelled_page_trusts_its_one_speaker(self):
        r = self.one(file=self.essay, words='never a failure', speaker_label='Some Writer')
        self.assertTrue(r['verified']); self.assertIsNone(r['speaker_seen'])

    def test_missing_page_is_a_failed_check(self):
        r = cw.check_one({'id': 'gone', 'url': 'https://example.invalid/x', 'words': 'x'}, fetch=lambda u: (_ for _ in ()).throw(OSError('no route')))
        self.assertFalse(r['verified']); self.assertIn('no route', r['error'])

    def test_one_page_is_read_once(self):
        calls = []
        def fetch(u): calls.append(u); return ESSAY
        pages = {}
        for _ in range(3): cw.check_one({'id': 'x', 'url': 'https://example.test/a', 'words': 'A letter'}, fetch=fetch, pages=pages)
        self.assertEqual(len(calls), 1)

    def test_command_answers_on_the_last_line_and_refuses_a_request_with_no_list(self):
        script = os.path.join(HERE, '..', 'do-work', 'check_words.py')
        req = os.path.join(self.dir, 'r.json'); json.dump({'checks': [{'id': 'a', 'file': self.essay, 'words': 'A letter'}]}, open(req, 'w'))
        out = subprocess.run([sys.executable, script, req], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0); self.assertTrue(json.loads(out.stdout.strip().splitlines()[-1])['result']['checks'][0]['verified'])
        bad = os.path.join(self.dir, 'b.json'); json.dump({'words': 'A letter'}, open(bad, 'w'))
        out = subprocess.run([sys.executable, script, bad], capture_output=True, text=True)
        self.assertEqual(out.returncode, 1); self.assertIn('error', json.loads(out.stdout.strip().splitlines()[-1]))

    def test_an_empty_batch_answers_no_checks(self):
        script = os.path.join(HERE, '..', 'do-work', 'check_words.py')
        req = os.path.join(self.dir, 'e.json'); json.dump({'checks': []}, open(req, 'w'))
        out = subprocess.run([sys.executable, script, req], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0); self.assertEqual(json.loads(out.stdout.strip().splitlines()[-1]), {'result': {'checks': []}})


if __name__ == '__main__':
    unittest.main(verbosity=2)

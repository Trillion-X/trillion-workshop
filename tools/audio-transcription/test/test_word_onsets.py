#!/usr/bin/env python3 -I
"""word_onsets.py on a made-up take: a tone after a pause, with Whisper-like word times that start inside the pause.
Run: python3 -I test/test_word_onsets.py   (needs numpy and soundfile; skips without them)"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'do-work', 'word_onsets.py')
try:
    import numpy as np
    import soundfile as sf
except ImportError:  # pragma: no cover
    np = sf = None


@unittest.skipIf(np is None, 'needs numpy and soundfile')
class WordOnsets(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        sr = 24000
        t = np.arange(int(3.0 * sr)) / sr
        y = np.zeros_like(t)
        for a, b in ((0.30, 0.90), (1.39, 2.20)):  # two words of voice, a pause between
            m = (t >= a) & (t < b)
            y[m] = 0.3 * np.sin(2 * np.pi * 180 * t[m])
        self.take = os.path.join(self.dir, 'take.wav')
        sf.write(self.take, y, sr, subtype='PCM_24')
        self.words = self.json('words.json', {'words': [{'text': 'Hello', 'start': 0.30, 'end': 0.90},
                                                        {'text': 'Jonh.', 'start': 1.02, 'end': 2.20}]})

    def json(self, name, value):
        path = os.path.join(self.dir, name)
        with open(path, 'w') as f:
            json.dump(value, f)
        return path

    def run_it(self, **extra):
        out = os.path.join(self.dir, 'out.json')
        done = subprocess.run([sys.executable, '-I', SCRIPT], input=json.dumps({'take': self.take, 'words': self.words, 'out': out, **extra}),
                              capture_output=True, text=True)
        answer = json.loads(done.stdout.strip().splitlines()[-1])
        return done.returncode, answer, (json.load(open(out)) if os.path.exists(out) else None)

    def test_a_start_inside_a_pause_moves_to_where_the_voice_starts_and_the_end_stays(self):
        code, answer, out = self.run_it()
        self.assertEqual(code, 0, answer)
        second = out['words'][1]
        self.assertAlmostEqual(second['start'], 1.39, delta=0.012)
        self.assertEqual(second['end'], 2.20)
        self.assertAlmostEqual(out['words'][0]['start'], 0.30, delta=0.012)
        self.assertEqual(answer['result']['moved'], 1)
        self.assertEqual(out['timing'], 'whisper words, starts moved to the first level above -45 dBFS')
        self.assertEqual(out['source'], 'take.wav')

    def test_a_word_with_no_level_above_the_line_keeps_its_start(self):
        code, _, out = self.run_it(edge_db=0)
        self.assertEqual([w['start'] for w in out['words']], [0.30, 1.02])

    def test_the_script_spelling_is_taken_when_the_counts_agree(self):
        code, answer, out = self.run_it(line=self.json('line.json', {'script': 'Hello John.'}))
        self.assertEqual([w['text'] for w in out['words']], ['Hello', 'John.'])
        self.assertEqual(answer['result']['spelling'], 'script')

    def test_a_hyphen_split_is_one_word_and_a_count_mismatch_keeps_whisper(self):
        self.words = self.json('words.json', {'words': [{'text': 'nutrient', 'start': 0.30, 'end': 0.60},
                                                        {'text': '-dense', 'start': 0.60, 'end': 0.90},
                                                        {'text': 'food.', 'start': 1.02, 'end': 2.20}]})
        code, answer, out = self.run_it(line=self.json('line.json', {'script': 'Nutrient-dense food.'}))
        self.assertEqual([(w['text'], w['end']) for w in out['words']], [('Nutrient-dense', 0.90), ('food.', 2.20)])
        code, answer, out = self.run_it(line=self.json('line.json', {'script': 'Some other three words.'}))
        self.assertEqual([w['text'] for w in out['words']], ['nutrient-dense', 'food.'])
        self.assertTrue(answer['result']['spelling'].startswith('whisper (counts differ'))

    def test_refusals_say_what_to_change(self):
        done = subprocess.run([sys.executable, '-I', SCRIPT], input='{"take": "x.wav"}', capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)
        self.assertIn('has no "words"', json.loads(done.stdout.strip().splitlines()[-1])['error'])
        code, answer, _ = self.run_it(take=os.path.join(self.dir, 'missing.wav'))
        self.assertEqual(code, 2)
        self.assertIn('error', answer)


if __name__ == '__main__':
    unittest.main()

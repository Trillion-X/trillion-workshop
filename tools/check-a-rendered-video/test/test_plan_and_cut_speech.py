"""Tests for check_plan_cuts.py and check_cut_speech.py on made-up recordings: every word a tone of its own pitch, heard by a stand-in
reader (fixtures/tone_words.py), so a cut that catches a neighbouring word is heard as one. Run: python3 -m unittest test_plan_and_cut_speech"""
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / 'fixtures'), str(HERE.parent / 'do-work')]

import check_cut_speech  # noqa: E402
import check_plan_cuts  # noqa: E402
import tone_words  # noqa: E402
from speech_reading import words  # noqa: E402

READER = json.dumps([sys.executable, str(HERE / 'fixtures' / 'tone_words.py')])
WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']


def quietly(fn, argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = fn(argv)
    lines = out.getvalue().strip().splitlines()
    return code, json.loads(lines[-1])['result'], lines


class Words(unittest.TestCase):
    def test_words_drop_case_possessives_hyphens_and_punctuation(self):
        self.assertEqual(words("Alpha's well-made, BRAVO! charlie’s"), ['alpha', 'well', 'made', 'bravo', 'charlie'])

    def test_the_heard_share_and_the_ends(self):
        share, miss, ends = check_cut_speech.heard_share('alpha bravo charlie delta', 'alpha bravo charlie delta echo')
        self.assertEqual((share, miss, ends), (1.0, [], (False, True)))
        share, miss, ends = check_cut_speech.heard_share('alpha bravo charlie delta', 'zulu bravo charlie')
        self.assertEqual((share, miss, ends), (0.5, ['alpha', 'delta'], (True, True)))
        self.assertEqual(check_cut_speech.heard_share('alpha bravo', 'alpha bravo')[2], (False, False))


class PlanCuts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.plans, self.wf = root / 'plans', root / 'words'
        self.plans.mkdir()
        self.wf.mkdir()
        times = tone_words.make(WORDS, root / 'take.wav')
        (self.wf / 'take.words.json').write_text(json.dumps({'source': str(root / 'take.wav'), 'words': times}))
        self.report = root / 'report.json'
        self.root = root

    def tearDown(self):
        self.tmp.cleanup()

    def plan(self, slug, segments, **extra):
        (self.plans / f'{slug}.json').write_text(json.dumps({'slug': slug, 'title': extra.pop('title', slug), 'segments': segments, **extra}))

    def test_a_span_that_catches_the_next_word_is_to_check(self):
        self.plan('first', [{'kind': 'ask', 'clip': None, 'text': 'A made-up line?'},
                            {'kind': 'reply', 'clip': 'take', 'from': 0.15, 'to': 2.45, 'text': 'Alpha, bravo charlie delta.'},
                            {'kind': 'reply', 'clip': 'take', 'from': 0.75, 'to': 3.05, 'text': 'Bravo charlie delta.'}])
        code, result, lines = quietly(check_plan_cuts.main, ['--plans', str(self.plans), '--report', str(self.report), '--words-folder', str(self.wf),
                                                             '--reader', READER])
        self.assertEqual(code, 2)
        self.assertEqual((result['segments'], result['to_check'], result['plan_failures']), (2, ['first#2'], 0))
        rows = [r for r in json.loads(self.report.read_text()) if 'segment' in r]
        self.assertEqual([(r['start_ok'], r['end_ok']) for r in rows], [(True, True), (True, False)])
        self.assertEqual(rows[1]['heard_end'], 'bravo charlie delta echo')
        self.assertIn('2 segments, 1 matched at both ends, 1 to check, 0 plan failures', lines[-2])

    def test_a_plan_source_is_cut_before_the_words_file(self):
        tone_words.make(['golf', 'hotel'], self.root / 'other.wav')
        self.plan('first', [{'kind': 'reply', 'clip': 'take', 'from': 0.15, 'to': 1.25, 'text': 'golf hotel'}], sources={'take': str(self.root / 'other.wav')})
        code, result, _ = quietly(check_plan_cuts.main, ['--plan-file', str(self.plans / 'first.json'), '--report', str(self.report), '--reader', READER])
        self.assertEqual((code, result['to_check']), (0, []))

    def test_plan_problems_by_the_persons_settings(self):
        (self.root / 'questions.json').write_text(json.dumps({'questions': [{'id': 'q-001', 'evidence': 'asked'}, {'id': 'q-002', 'evidence': 'guessed'}]}))
        settings = {'question_key': 'drawn_from', 'questions_file': str(self.root / 'questions.json'), 'question_id_pattern': r'q-\d+',
                    'refused_evidence': ['guessed'], 'card_kind': 'card', 'next_prefix': 'Then:', 'slug_key': 'slug', 'title_keys': ['title', 'old_title'],
                    'gate_fields': ['signed_off']}
        (self.root / 'settings.json').write_text(json.dumps(settings))
        self.plan('second', [], title='The second one')
        self.plan('first', [{'kind': 'ask', 'text': 'x', 'drawn_from': 'q-001 a made-up ask'}, {'kind': 'ask', 'text': 'y', 'drawn_from': 'q-002'},
                            {'kind': 'ask', 'text': 'z', 'drawn_from': 'q-077'}, {'kind': 'card', 'text': 'Then: The second one'},
                            {'kind': 'card', 'text': 'Then: Nowhere', 'slug': 'gone'}, {'kind': 'card', 'text': 'Then: Some other words'}], signed_off='yes')
        code, result, lines = quietly(check_plan_cuts.main, ['--plans', str(self.plans), '--report', str(self.report), '--settings', str(self.root / 'settings.json'),
                                                             'first'])
        self.assertEqual((code, result['plan_failures'], result['plans']), (1, 3, 1))
        row = json.loads(self.report.read_text())[0]
        self.assertEqual(row['signed_off'], 'yes')
        self.assertEqual(row['failures'], ["segment 1 is drawn from q-002, whose evidence is guessed, and is presented as asked",
                                           "segment 2 drawn_from 'q-077' names no question in the library",
                                           "segment 4 card names plan 'gone', which is not in the plans folder"])
        self.assertEqual(row['notes'], ['segment 5 card names no plan slug and matches no plan title: not checked'])

    def test_no_settings_no_plan_problems_and_an_unknown_slug_is_refused(self):
        self.plan('first', [{'kind': 'card', 'text': 'Then: Nowhere', 'slug': 'gone'}])
        code, result, _ = quietly(check_plan_cuts.main, ['--plans', str(self.plans), '--report', str(self.report)])
        self.assertEqual((code, result['plan_failures'], result['segments']), (0, 0, 0))
        with self.assertRaisesRegex(SystemExit, 'no plan missing'):
            quietly(check_plan_cuts.main, ['--plans', str(self.plans), '--report', str(self.report), 'missing'])


class CutSpeech(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        tone_words.make(WORDS, root / 'sound.wav', tail_s=1.6)
        cls.cut = root / 'cut.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-i', str(root / 'sound.wav'),
                        '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(cls.cut)], check=True)
        cls.timeline = root / 'timeline.json'
        cls.timeline.write_text(json.dumps([{'seg': 0, 'kind': 'ask', 'text': 'Alpha bravo?', 'start': 0.0, 'dur': 1.3},
                                            {'seg': 1, 'kind': 'reply', 'text': 'Charlie, delta echo.', 'start': 1.3, 'dur': 1.8},
                                            {'seg': 2, 'kind': 'reply', 'text': 'Foxtrot golf.', 'start': 3.1, 'dur': 1.8},
                                            {'seg': 3, 'kind': 'card', 'text': 'not spoken', 'start': 4.9, 'dur': 0.5}]))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_check(self, work, *more):
        return quietly(check_cut_speech.main, ['--cut', str(self.cut), '--timeline', str(self.timeline), '--work', str(work), '--kinds', 'ask,reply',
                                               '--always-show', 'ask', '--frames', 'ask:first,reply:middle,reply:last', '--reader', READER, *more])

    def test_a_reply_that_runs_into_the_next_word_is_listed_with_the_frames_and_silence(self):
        work = Path(self.tmp.name) / 'one'
        code, result, lines = self.run_check(work)
        self.assertEqual((code, result['to_check']), (2, [2]))
        report = json.loads((work / 'verify.json').read_text())
        self.assertEqual([(s['seg'], s['share'], s['end_off']) for s in report['segments']], [(0, 1.0, False), (1, 1.0, False), (2, 1.0, True)])
        self.assertEqual(report['segments'][2]['heard'], 'foxtrot golf hotel')
        self.assertEqual(len(report['silences']), 1)
        self.assertGreater(report['silences'][0], 1.0)
        self.assertLess(report['lufs'], -5)
        self.assertEqual([Path(f).name for f in result['frames']], ['frame1.jpg', 'frame2.jpg', 'frame3.jpg'])
        self.assertTrue((work / 'frames.jpg').is_file())
        self.assertIsNone(report['listened_by'])
        self.assertTrue(any(line.strip().startswith('ask seg 0 100%') for line in lines))

    def test_listened_by_is_only_ever_set_by_a_person(self):
        work = Path(self.tmp.name) / 'two'
        work.mkdir()
        (work / 'verify.json').write_text(json.dumps({'listened_by': 'a made-up listener'}))
        code, result, _ = self.run_check(work, '--frames', '', '--kinds', 'ask')
        self.assertEqual((code, result['listened_by'], result['frames']), (0, 'a made-up listener', []))
        self.assertEqual(json.loads((work / 'verify.json').read_text())['listened_by'], 'a made-up listener')


if __name__ == '__main__':
    unittest.main()

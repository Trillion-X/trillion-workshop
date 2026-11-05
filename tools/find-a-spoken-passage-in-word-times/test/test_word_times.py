"""Tests for do-work/word_times.py on made-up word times."""
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'do-work' / 'word_times.py'
sys.path.insert(0, str(SCRIPT.parent))
import word_times as wt  # noqa: E402

WORDS = {'words': [{'text': t, 'start': i * 0.5, 'end': i * 0.5 + 0.4} for i, t in enumerate(
    "Start here. The kettle's on, again! Then we wait. The kettle's on again? And then".split())]}
WHISPER = {'segments': [{'words': [{'word': ' Start', 'start': 0.0, 'end': 0.4}, {'word': ' here.', 'start': 0.5, 'end': 0.9}]},
                        {'words': [{'word': ' Again', 'start': 1.0, 'end': 1.333}]}, {'text': 'no words here'}]}


class Readers(unittest.TestCase):
    def quiet(self, fn, *args, **kw):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            got = fn(*args, **kw)
        return got, out.getvalue().splitlines()

    def test_every_shape_reads_as_text_start_end(self):
        self.assertEqual(wt.words_of(WHISPER)[0], (' Start', 0.0, 0.4))
        self.assertEqual(wt.words_of({'words': [{'t': 'hi', 'start': 1, 'end': 2}]}), [('hi', 1, 2)])
        with self.assertRaises(wt.Refusal):
            wt.words_of({'text': 'only text'})

    def test_span_matches_words_ignoring_case_and_punctuation_but_keeping_apostrophes(self):
        found, lines = self.quiet(wt.span, wt.words_of(WORDS), "the KETTLE'S", 'on again')
        self.assertEqual((found['start'], found['end']), (1.0, 2.9))
        self.assertEqual(found['text'], "The kettle's on, again!")
        self.assertEqual(lines, ["1.00\t2.90\tThe kettle's on, again!"])

    def test_span_after_skips_earlier_matches_and_last_is_searched_from_first(self):
        found, _ = self.quiet(wt.span, wt.words_of(WORDS), "the kettle's", 'again', after=3.0)
        self.assertEqual((found['start'], found['end']), (4.5, 6.4))
        found, _ = self.quiet(wt.span, wt.words_of(WORDS), 'then', 'then')
        self.assertEqual(found['text'], 'Then')

    def test_span_refuses_words_it_cannot_find(self):
        with self.assertRaisesRegex(SystemExit, 'first words not found'):
            self.quiet(wt.span, wt.words_of(WORDS), 'not said', 'here')
        with self.assertRaisesRegex(SystemExit, 'last words not found'):
            self.quiet(wt.span, wt.words_of(WORDS), 'wait', 'start here')

    def test_sentences_cut_on_end_marks_keep_a_window_and_print_an_open_last_sentence(self):
        found, lines = self.quiet(wt.sentences, WORDS)
        self.assertEqual(lines, ['0.00-0.90 Start here.', "1.00-2.90 The kettle's on, again!", '3.00-4.40 Then we wait.',
                                 "4.50-6.40 The kettle's on again?", '6.50- And then'])
        self.assertEqual(found[-1], {'start': 6.5, 'end': None, 'text': 'And then'})
        found, _ = self.quiet(wt.sentences, WORDS, 2.5, 3.0)
        self.assertEqual([s['text'] for s in found], ['again!', 'Then'])
        found, lines = self.quiet(wt.sentences, WHISPER)
        self.assertEqual(lines, ['0.00-0.90  Start  here.', '1.00-  Again'])

    def test_words_home_keeps_the_words_shape_untouched_and_converts_whisper(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'a.words.json'
            self.quiet(wt.words_home, WORDS, 'a.mp4', out)
            self.assertEqual(json.loads(out.read_text())['words'], WORDS['words'])
            self.quiet(wt.words_home, WHISPER, 'a.mp4', out)
            self.assertEqual(json.loads(out.read_text()), {'source': 'a.mp4', 'timing': 'word', 'words': [
                {'text': 'Start', 'start': 0.0, 'end': 0.4}, {'text': 'here.', 'start': 0.5, 'end': 0.9}, {'text': 'Again', 'start': 1.0, 'end': 1.333}]})

    def test_words_home_offset_moves_and_rounds_times_and_round_to_rounds_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'a.words.json'
            self.quiet(wt.words_home, WHISPER, 'a.mp4', out, offset=10.0)
            self.assertEqual(json.loads(out.read_text())['words'][2], {'text': 'Again', 'start': 11.0, 'end': 11.33})
            self.quiet(wt.words_home, WHISPER, 'a.mp4', out, round_to=1)
            self.assertEqual(json.loads(out.read_text())['words'][2]['end'], 1.3)
            self.quiet(wt.words_home, {'words': [{'t': ' hi', 'start': 1, 'end': 2, 'timing_source': 'x'}]}, 'a.mp4', out)
            self.assertEqual(json.loads(out.read_text())['words'], [{'text': 'hi', 'start': 1, 'end': 2}])

    def test_the_old_command_lines_print_what_the_film_tools_printed(self):
        with tempfile.TemporaryDirectory() as tmp:
            words = Path(tmp) / 'w.json'
            words.write_text(json.dumps(WORDS))
            run = lambda *a: subprocess.run([sys.executable, '-I', str(SCRIPT), *a], capture_output=True, text=True)
            self.assertEqual(run('span', str(words), 'then we', 'wait').stdout, '3.00\t4.40\tThen we wait.\n')
            self.assertEqual(run('span', str(words), "the kettle's", 'again', '--after', '3').stdout.split('\t')[0], '4.50')
            self.assertEqual(run('sentences', str(words), '0', '1').stdout, '0.00-0.90 Start here.\n1.00- The\n')
            done = run('words-home', str(words), 'card/a.mp4', str(Path(tmp) / 'o.json'))
            self.assertEqual(done.stdout, f"15 words -> {Path(tmp) / 'o.json'}\n")
            self.assertIn('first words not found', run('span', str(words), 'nope', 'wait').stderr)


class Command(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='word-times-'))
        (self.tmp / 'clips').mkdir()
        (self.tmp / 'clips' / 'K1.words.json').write_text(json.dumps(WORDS))
        (self.tmp / 'raw.json').write_text(json.dumps(WHISPER))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cli(self, request):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--base', str(self.tmp)], input=json.dumps(request), capture_output=True, text=True)
        lines = done.stdout.strip().split('\n')
        return done.returncode, lines[:-1], json.loads(lines[-1])

    def test_span_prints_the_old_line_then_one_result(self):
        code, lines, last = self.cli({'step': 'span', 'words': 'clips/K1.words.json', 'first': 'then we', 'last': 'wait'})
        self.assertEqual(code, 0, last)
        self.assertEqual(lines, ['3.00\t4.40\tThen we wait.'])
        self.assertEqual(last['result']['start'], 3.0)

    def test_a_clip_is_read_from_the_words_folder_setting(self):
        request = {'step': 'sentences', 'clip': 'K1', 'from': 0, 'to': 1, 'settings': {'words_folder': str(self.tmp / 'clips')},
                   'settings_from': {'id': 'record:setting:find-a-spoken-passage-in-word-times~film~sample', 'from': 'made up'}}
        code, lines, last = self.cli(request)
        self.assertEqual(code, 0, last)
        self.assertEqual(lines, ['0.00-0.90 Start here.', '1.00- The'])
        self.assertEqual(last['result']['settings_from']['from'], 'made up')
        code, _, last = self.cli({'step': 'sentences', 'clip': 'K1'})
        self.assertEqual(code, 1)
        self.assertIn('words_folder setting', last['error'])

    def test_words_file_writes_the_one_shape_in_the_granted_folder(self):
        code, lines, last = self.cli({'step': 'words-file', 'words': 'raw.json', 'source': 'card/K2.MP4', 'out': 'K2.words.json', 'offset': 2,
                                      'settings': {'timing': 'word'}})
        self.assertEqual(code, 0, last)
        made = json.loads((self.tmp / 'K2.words.json').read_text())
        self.assertEqual((made['source'], made['timing'], made['words'][0]['start']), ('card/K2.MP4', 'word', 2.0))
        self.assertEqual(lines, [f"3 words -> {self.tmp / 'K2.words.json'}"])

    def test_refusals_say_what_to_give(self):
        for request, words in (({'step': 'cut'}, 'step is'), ({'step': 'span'}, 'give words'), ({'step': 'span', 'words': 'absent.json'}, 'no word-time file'),
                               ({'step': 'span', 'words': 'raw.json', 'first': 'x'}, 'span needs first'),
                               ({'step': 'words-file', 'words': 'raw.json'}, 'needs source'), (['span'], 'JSON object')):
            code, _, last = self.cli(request)
            self.assertEqual(code, 1, request)
            self.assertIn(words, last['error'])


def record(folder, settings, status='active'):
    """A row as run-with-settings.mjs hands it in: {id, type, value}, settings as the compact JSON text make_record writes."""
    return {'id': f'record:setting:{folder}~film~sample-film', 'type': 'record:setting',
            'value': {'name': 'made up', 'tool': f'tool:{folder}', 'scope_kind': 'film', 'scope_id': 'sample-film',
                      'settings': json.dumps(settings, sort_keys=True, separators=(',', ':')), 'from': 'made up', 'status': status}}


class SettingsRecord(unittest.TestCase):
    setUp, tearDown, cli = Command.setUp, Command.tearDown, Command.cli

    def test_a_clip_is_read_from_the_record_and_a_retired_record_is_refused(self):
        F = 'find-a-spoken-passage-in-word-times'
        code, lines, last = self.cli({'step': 'span', 'clip': 'K1', 'first': 'then we', 'last': 'wait', 'settings_record': record(F, {'words_folder': str(self.tmp / 'clips')})})
        self.assertEqual(code, 0, last)
        self.assertEqual(lines, ['3.00\t4.40\tThen we wait.'])
        code, _, last = self.cli({'step': 'span', 'clip': 'K1', 'first': 'a', 'last': 'b', 'settings_record': record(F, {'words_folder': 'x'}, 'retired')})
        self.assertEqual(code, 1)
        self.assertIn('retired', last['error'])

if __name__ == '__main__':
    unittest.main()

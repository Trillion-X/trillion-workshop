"""Tests for do-work/name_recording.py on a made-up archive index."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'do-work' / 'name_recording.py'
sys.path.insert(0, str(SCRIPT.parent))
import name_recording as nr  # noqa: E402

WINDOWS = [
    {'id': 'w-001', 'recording': 'Interview one', 'start_line': 1, 'end_line': 100, 'text': '  The first words of window one.  '},
    {'id': 'w-002', 'recording': 'Interview two', 'start_line': 101, 'end_line': 200, 'text': 'Second window opens here ' + 'x' * 200},
    {'id': 'w-003', 'recording': 'Interview three', 'start_line': 201, 'end_line': 300, 'text': 'Third.'},
]


class NameRecording(unittest.TestCase):
    def test_range_inside_one_window(self):
        self.assertEqual([w['id'] for w in nr.windows_for(WINDOWS, '10-20')], ['w-001'])

    def test_range_touching_the_boundary_names_both_windows(self):
        self.assertEqual([w['id'] for w in nr.windows_for(WINDOWS, '100-101')], ['w-001', 'w-002'])

    def test_range_spanning_every_window(self):
        self.assertEqual(len(nr.windows_for(WINDOWS, '1-300')), 3)

    def test_range_past_the_archive_names_nothing(self):
        self.assertEqual(nr.windows_for(WINDOWS, '301-400'), [])

    def test_bad_ranges_are_refused_with_what_to_write(self):
        for bad in ('12', '12-x', '40-12', '1-2-3', ''):
            with self.assertRaises(ValueError) as caught:
                nr.parse_range(bad)
            self.assertIn('range', str(caught.exception))

    def test_printed_line_is_the_one_the_old_tool_printed(self):
        line = nr.printed('150-160', WINDOWS[1])
        self.assertEqual(line.split('\t')[:4], ['150-160', 'w-002', 'Interview two', '101-200'])
        self.assertEqual(line.split('\t')[4], repr(WINDOWS[1]['text'].strip()[:120]))

    def test_first_words_are_stripped_and_cut_at_120_characters(self):
        self.assertEqual(len(WINDOWS[1]['text'].strip()[:120]), 120)
        self.assertTrue(nr.printed('1-1', WINDOWS[0]).endswith("'The first words of window one.'"))

    def test_command_prints_lines_then_one_json_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'archive.json'
            archive.write_text(json.dumps(WINDOWS))
            done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--archive', str(archive), '10-20', '999-1000'],
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            lines = done.stdout.strip().split('\n')
            self.assertTrue(lines[0].startswith('10-20\tw-001\tInterview one\t1-100\t'))
            self.assertIn('999-1000\tno archive window overlaps this range', lines)
            result = json.loads(lines[-1])['result']
            self.assertEqual([m['id'] for m in result['matches']], ['w-001'])

    def run_request(self, request, *extra):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), *extra], input=json.dumps(request), capture_output=True, text=True)
        return done.returncode, done.stdout.strip().split('\n')

    def test_request_on_stdin_and_missing_archive_refusal(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, lines = self.run_request({'archive': str(Path(tmp) / 'absent.json'), 'ranges': ['1-2']})
            self.assertEqual(code, 1)
            self.assertIn('there is no archive index', json.loads(lines[-1])['error'])

    def test_no_ranges_is_refused(self):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--archive', 'x.json'], capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)
        self.assertIn('at least one line range', json.loads(done.stdout.strip())['error'])

    def test_a_bad_range_anywhere_is_refused_before_anything_is_printed(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'archive.json').write_text(json.dumps(WINDOWS))
            code, lines = self.run_request({'archive': 'archive.json', 'ranges': ['10-20', '40-12']}, '--base', tmp)
            self.assertEqual(code, 1)
            self.assertEqual(len(lines), 1)
            self.assertIn('ends before it starts', json.loads(lines[0])['error'])

    def test_relative_archive_is_read_from_the_granted_folder_and_ranges_may_be_one_string(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'archive.json').write_text(json.dumps(WINDOWS))
            code, lines = self.run_request({'archive': 'archive.json', 'ranges': '150-160 250-250'}, '--base', tmp)
            self.assertEqual(code, 0, lines)
            result = json.loads(lines[-1])['result']
            self.assertEqual([m['id'] for m in result['matches']], ['w-002', 'w-003'])
            self.assertEqual(result['not_found'], [])

    def test_settings_name_the_archive_and_the_preview_length(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'film-archive.json').write_text(json.dumps(WINDOWS))
            request = {'ranges': ['150-160'], 'settings': {'archive': 'film-archive.json', 'preview_chars': 6},
                       'settings_from': {'id': 'record:setting:name-the-recording-behind-transcript-lines~film~sample', 'from': 'x'}}
            code, lines = self.run_request(request, '--base', tmp)
            self.assertEqual(code, 0, lines)
            self.assertEqual(lines[0].split('\t')[4], repr('Second'))
            result = json.loads(lines[-1])['result']
            self.assertEqual(result['matches'][0]['first_words'], 'Second')
            self.assertEqual(result['settings_from']['id'], request['settings_from']['id'])
            code, lines = self.run_request({**request, 'archive': str(Path(tmp) / 'absent.json')}, '--base', tmp)
            self.assertEqual(code, 1, 'the request\'s own archive wins over the setting')

    def test_a_request_that_is_not_an_object_is_refused(self):
        code, lines = self.run_request(['1-2'])
        self.assertEqual(code, 2)
        self.assertIn('JSON object', json.loads(lines[-1])['error'])


def record(folder, settings, status='active'):
    """A row as run-with-settings.mjs hands it in: {id, type, value}, settings as the compact JSON text make_record writes."""
    return {'id': f'record:setting:{folder}~film~sample-film', 'type': 'record:setting',
            'value': {'name': 'made up', 'tool': f'tool:{folder}', 'scope_kind': 'film', 'scope_id': 'sample-film',
                      'settings': json.dumps(settings, sort_keys=True, separators=(',', ':')), 'from': 'made up', 'status': status}}


class SettingsRecord(unittest.TestCase):
    F = 'name-the-recording-behind-transcript-lines'

    def run_request(self, request, *extra):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), *extra], input=json.dumps(request), capture_output=True, text=True)
        return done.returncode, done.stdout.strip().split('\n')

    def test_the_record_run_with_settings_hands_in_is_read_and_a_retired_one_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'a.json').write_text(json.dumps(WINDOWS))
            code, lines = self.run_request({'ranges': ['10-20'], 'settings_record': record(self.F, {'archive': 'a.json', 'preview_chars': 5})}, '--base', tmp)
            self.assertEqual(code, 0, lines)
            self.assertEqual(json.loads(lines[-1])['result']['matches'][0]['first_words'], 'The f')
            code, lines = self.run_request({'ranges': ['10-20'], 'settings_record': record(self.F, {'archive': 'a.json'}, 'retired')}, '--base', tmp)
            self.assertEqual(code, 2)
            self.assertIn('retired', json.loads(lines[-1])['error'])
            code, lines = self.run_request({'ranges': ['10-20'], 'settings_record': 'record:setting:' + self.F + '~film~x'}, '--base', tmp)
            self.assertIn('run-with-settings.mjs', json.loads(lines[-1])['error'])

class OldCommandLine(unittest.TestCase):
    def test_the_old_command_line_prints_the_old_lines_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'archive.json'
            archive.write_text(json.dumps(WINDOWS))
            done = subprocess.run([sys.executable, '-I', str(SCRIPT), str(archive), '100-101', '999-1000'], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout.splitlines(), [nr.printed('100-101', WINDOWS[0]), nr.printed('100-101', WINDOWS[1])])


if __name__ == '__main__':
    unittest.main()

"""The settings reader on made-up rows: ids, the scope chosen, the default when there is none, and every refusal."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / 'read-data'))
import settings as S  # noqa: E402

CLI = HERE / 'do-work' / 'read_setting.py'


def row(kind, scope, values, folder='make-a-sample', status='active'):
    return S.make_record(folder, kind, scope, values, name='sample', tool='tool:make-a-sample',
                         source='tools/sample/settings.json@0000000', status=status)


class Ids(unittest.TestCase):
    def test_round_trip(self):
        rid = S.setting_id('make-a-sample', 'film', 'a~film')
        self.assertEqual(rid, 'record:setting:make-a-sample~film~a~film')
        self.assertEqual(S.parse_id(rid), ('make-a-sample', 'film', 'a~film'))

    def test_refusals(self):
        for args in (('a/b', 'film', 'x'), ('a', 'show', 'x'), ('a', 'film', '')):
            with self.assertRaises(S.SettingError):
                S.setting_id(*args)
        with self.assertRaises(S.SettingError):
            S.parse_id('record:tool-settings:x')


class Reading(unittest.TestCase):
    rows = [row('account', 'main', {'pace': 1}), row('film', 'f1', {'pace': 2}),
            row('film', 'f2', {'pace': 9}, folder='other-tool')]

    def test_most_specific_scope_wins(self):
        scopes = [('piece', 'p1'), ('film', 'f1'), ('account', 'main')]
        self.assertEqual(S.setting(self.rows, 'make-a-sample', scopes), {'pace': 2})
        self.assertEqual(S.setting(self.rows, 'make-a-sample', [('film', 'f3'), ('account', 'main')]), {'pace': 1})

    def test_none_gives_the_default_like_old_setting(self):
        self.assertIsNone(S.setting(self.rows, 'make-a-sample', [('film', 'f2')]))
        self.assertEqual(S.setting([], 'make-a-sample', [('film', 'f2')], default={'pace': 0}), {'pace': 0})
        self.assertEqual(S.setting(None), None)

    def test_one_record_value_or_file(self):
        self.assertEqual(S.setting(self.rows[0]), {'pace': 1})
        self.assertEqual(S.setting(self.rows[0]['value'] | {'settings': {'pace': 3}}), {'pace': 3})
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'r.json'
            p.write_text(json.dumps({'records': self.rows}))
            self.assertEqual(S.setting(str(p), 'make-a-sample', [('film', 'f1')]), {'pace': 2})

    def test_refusals(self):
        with self.assertRaises(S.SettingError):
            S.setting(self.rows, 'make-a-sample')  # two rows, no scope
        with self.assertRaises(S.SettingError):
            S.setting(row('film', 'f', {}, status='retired'))
        with self.assertRaises(S.SettingError):
            S.setting(self.rows[0], tool='tool:another')
        with self.assertRaises(S.SettingError):
            S.setting({'id': 'x', 'type': 'record:check', 'value': {}})
        with self.assertRaises(S.SettingError):
            S.setting('/no/such/file.json')


class Keep(unittest.TestCase):
    def test_expected_is_the_row_as_handed_or_none(self):
        old = row('film', 'f1', {'pace': 2})
        new = row('film', 'f1', {'pace': 3})
        fresh = row('film', 'f2', {'pace': 4})
        kept = S.keep([new, fresh], {'records': [old]})
        self.assertEqual(kept[0], {**new, 'expected': {'type': old['type'], 'value': old['value']}})
        self.assertEqual(kept[1], {**fresh, 'expected': None})
        self.assertEqual(S.keep([new], None), [{**new, 'expected': None}])
        with self.assertRaises(S.SettingError):
            S.keep([new], [old])


class Handed(unittest.TestCase):
    rows = [row('account', 'main', {'pace': 1}), row('film', 'f1', {'pace': 2})]

    def test_a_named_row_is_read_from_the_rows_handed_in(self):
        stored = {'records': self.rows + [{'id': 'note:1', 'type': 'note', 'value': {'words': 'not a setting'}}]}
        got = S.request_settings({'settings_record': self.rows[1]['id'], 'stored': stored, 'settings': {'w': 1}},
                                 {'pace': 0, 'w': 0}, folder='make-a-sample')
        self.assertEqual(got, {'pace': 2, 'w': 1})
        got = S.request_settings({'stored': stored}, {}, folder='make-a-sample', scopes=[('film', 'f9'), ('account', 'main')])
        self.assertEqual(got, {'pace': 1})
        self.assertIsNone(S.handed_record(stored, 'record:setting:make-a-sample~film~absent'))

    def test_a_named_row_not_handed_is_refused_never_run_on_the_defaults(self):
        rid = self.rows[1]['id']
        for request in ({'settings_record': rid}, {'settings_record': rid, 'stored': {'records': []}},
                        {'settings_record': 'record:setting:make-a-sample~film~absent', 'stored': {'records': self.rows}}):
            with self.assertRaises(S.SettingError):
                S.request_settings(request, {'pace': 0}, folder='make-a-sample')
        with self.assertRaises(S.SettingError):
            S.request_settings({'settings_record': rid, 'stored': {'records': self.rows}}, {}, folder='another-tool')
        with self.assertRaises(S.SettingError):
            S.request_settings({'stored': self.rows}, {})


class Command(unittest.TestCase):
    def run_cli(self, request):
        done = subprocess.run([sys.executable, '-I', str(CLI)], input=json.dumps(request), capture_output=True, text=True)
        return done.returncode, json.loads(done.stdout.strip().splitlines()[-1])

    def test_read_and_make(self):
        code, out = self.run_cli({'make': {'folder': 'make-a-sample', 'scope_kind': 'film', 'scope_id': 'f1',
                                           'settings': {'b': 1, 'a': 2}, 'name': 'n', 'tool': 'tool:t', 'from': 'x@1'}})
        self.assertEqual(code, 0)
        [record] = out['result']['keep']
        self.assertEqual((record['value']['settings'], record['expected']), ('{"a":2,"b":1}', None))
        record = {k: v for k, v in record.items() if k != 'expected'}
        code, out = self.run_cli({'settings_record': [record], 'folder': 'make-a-sample',
                                  'scopes': [{'kind': 'film', 'id': 'f1'}]})
        self.assertEqual((code, out['result']), (0, {'found': True, 'id': record['id'], 'settings': {'a': 2, 'b': 1}}))
        code, out = self.run_cli({'settings_record': [], 'default': {'a': 0}})
        self.assertEqual(out['result'], {'found': False, 'id': None, 'settings': {'a': 0}})
        code, out = self.run_cli({'stored': {'records': [record]}, 'folder': 'make-a-sample', 'scopes': [{'kind': 'film', 'id': 'f1'}]})
        self.assertEqual(out['result'], {'found': True, 'id': record['id'], 'settings': {'a': 2, 'b': 1}})
        code, out = self.run_cli({'settings_record': record['id'], 'folder': 'make-a-sample'})
        self.assertEqual(code, 2)
        self.assertIn('no rows were handed in', out['error'])
        code, out = self.run_cli({'make': {'folder': 'x'}})
        self.assertEqual(code, 2)
        self.assertIn('make needs', out['error'])


if __name__ == '__main__':
    unittest.main()

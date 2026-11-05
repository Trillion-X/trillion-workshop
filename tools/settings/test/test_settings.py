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


class Command(unittest.TestCase):
    def run_cli(self, request):
        done = subprocess.run([sys.executable, '-I', str(CLI)], input=json.dumps(request), capture_output=True, text=True)
        return done.returncode, json.loads(done.stdout.strip().splitlines()[-1])

    def test_read_and_make(self):
        code, out = self.run_cli({'make': {'folder': 'make-a-sample', 'scope_kind': 'film', 'scope_id': 'f1',
                                           'settings': {'b': 1, 'a': 2}, 'name': 'n', 'tool': 'tool:t', 'from': 'x@1'},
                                  'with_list': True})
        self.assertEqual(code, 0)
        listed, record = out['result']['records']
        self.assertEqual(listed['id'], 'list:settings')
        self.assertEqual(record['value']['settings'], '{"a":2,"b":1}')
        code, out = self.run_cli({'settings_record': [record], 'folder': 'make-a-sample',
                                  'scopes': [{'kind': 'film', 'id': 'f1'}]})
        self.assertEqual((code, out['result']), (0, {'found': True, 'id': record['id'], 'settings': {'a': 2, 'b': 1}}))
        code, out = self.run_cli({'settings_record': [], 'default': {'a': 0}})
        self.assertEqual(out['result'], {'found': False, 'id': None, 'settings': {'a': 0}})
        code, out = self.run_cli({'make': {'folder': 'x'}})
        self.assertEqual(code, 2)
        self.assertIn('make needs', out['error'])


if __name__ == '__main__':
    unittest.main()

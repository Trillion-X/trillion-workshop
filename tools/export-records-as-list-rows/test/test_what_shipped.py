"""Stdlib tests for reading what a made-up bakery's repository shipped into a staged file, and for the sender's keep_held setting that
writes only the rows an account lacks (test/fixtures/fake_record_door.py)."""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
DOOR = Path(__file__).resolve().parent / 'fixtures' / 'fake_record_door.py'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import record_write_send as sender  # noqa: E402
import what_shipped  # noqa: E402
import read_what_shipped as cli  # noqa: E402

ENV = {**os.environ, 'GIT_AUTHOR_NAME': 'baker', 'GIT_AUTHOR_EMAIL': 'baker@example.test',
       'GIT_COMMITTER_NAME': 'baker', 'GIT_COMMITTER_EMAIL': 'baker@example.test'}


class Repository(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='what-shipped-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.repo = self.tmp / 'bakery'
        self.git('init', '-q', '-b', 'main', str(self.repo), at=self.tmp)
        self.staged = self.tmp / 'staged' / 'releases.json'

    def git(self, *args, at=None):
        return subprocess.run(['git', *args], cwd=at or self.repo, env=ENV, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, subject):
        (self.repo / 'menu.txt').write_text(subject)
        self.git('add', 'menu.txt')
        self.git('commit', '-q', '-m', subject)
        return self.git('rev-parse', 'HEAD')

    def release(self, ref='refs/heads/released'):
        self.git('update-ref', ref, 'HEAD')

    def read(self, settings=None):
        return what_shipped.read(self.repo, settings or {'mark': {'ref': 'refs/heads/released'}}, self.staged)

    def releases(self):
        return json.loads(self.staged.read_text())['releases']


class FromARef(Repository):
    def test_the_first_release_carries_its_own_subject_and_the_next_one_every_subject_since(self):
        first = self.commit('Rye on Sundays')
        self.release()
        self.assertEqual(self.read()['added'], first[:12])
        self.commit('Lemon tarts')
        second = self.commit('A second van')
        self.release()
        self.assertEqual(self.read(), {'releases': 2, 'added': second[:12]})
        one, two = self.releases()
        self.assertEqual((one['previous'], one['subjects']), (None, ['Rye on Sundays']))
        self.assertEqual((two['previous'], two['subjects']), (first, ['A second van', 'Lemon tarts']))

    def test_a_release_already_read_adds_nothing_and_leaves_the_file_as_it_is(self):
        self.commit('Rye on Sundays')
        self.release()
        self.read()
        before = self.staged.read_bytes()
        self.assertEqual(self.read(), {'releases': 1, 'added': None})
        self.assertEqual(self.staged.read_bytes(), before)

    def test_most_subjects_keeps_the_newest(self):
        self.commit('one')
        self.release()
        self.read()
        for subject in ('two', 'three', 'four'):
            self.commit(subject)
        self.release()
        self.read({'mark': {'ref': 'refs/heads/released'}, 'most_subjects': 2})
        self.assertEqual(self.releases()[-1]['subjects'], ['four', 'three'])

    def test_a_folder_that_is_not_a_repository_and_a_missing_ref_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'not a git repository'):
            what_shipped.read(self.tmp / 'staged-nowhere', {'mark': {'ref': 'x'}}, self.staged)
        self.commit('one')
        with self.assertRaisesRegex(ValueError, 'no commit refs/heads/gone'):
            self.read({'mark': {'ref': 'refs/heads/gone'}})


class FromACommand(Repository):
    def mark_program(self, said):
        program = self.tmp / 'mark.py'
        program.write_text(f'import json\nprint(json.dumps({said!r}))\n')
        return {'id_prefix': 'bake-', 'mark': {'command': [sys.executable, '-I', str(program)]}, 'fields': {'commit': 'released', 'name': 'build', 'at': 'when'}}

    def test_the_mark_names_the_commit_name_and_time_by_the_fields_given(self):
        commit = self.commit('Rye on Sundays')
        settings = self.mark_program({'released': commit, 'build': '2026.3', 'when': '2026-03-09T08:00:00Z'})
        self.assertEqual(self.read(settings)['added'], '2026.3')
        self.assertEqual(self.releases()[0] | {'subjects': None}, {'id': 'bake-2026.3', 'name': '2026.3', 'commit': commit, 'at': '2026-03-09T08:00:00Z',
                                                                  'previous': None, 'subjects': None})

    def test_a_mark_without_the_commit_field_is_refused_and_the_command_line_says_so(self):
        self.commit('one')
        settings = self.tmp / 'settings.json'
        settings.write_text(json.dumps(self.mark_program({'build': '1'})))
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(cli.main(['--settings', str(settings), '--repository', str(self.repo), '--staged', str(self.staged)]), 2)
        self.assertIn('names no commit under "released"', err.getvalue())
        self.assertFalse(self.staged.exists())


class KeepHeld(unittest.TestCase):
    def test_keep_held_writes_only_the_rows_the_account_lacks_and_leaves_an_edited_row_alone(self):
        tmp = Path(tempfile.mkdtemp(prefix='keep-held-test-'))
        self.addCleanup(shutil.rmtree, tmp)
        account = tmp / 'account.json'
        os.environ['FAKE_DOOR'] = str(account)
        self.addCleanup(os.environ.pop, 'FAKE_DOOR', None)
        account.write_text(json.dumps({'records': {'r:one': {'type': 'r', 'value': {'title': 'edited by hand'}}}, 'keys': {}, 'calls': []}))
        config = {'transport': {'kind': 'call', 'argv': [sys.executable, '-I', str(DOOR), '{plan}', '{result}']}, 'address': '@made-up',
                  'list_method': 'list', 'write_method': 'write', 'page_limit': 5, 'per_command': 5, 'command_bytes': 4000,
                  'request_key_prefix': 'bakery', 'keep_held': True}
        payload = {'commands': [{'input': {'records': [{'id': 'r:one', 'type': 'r', 'value': {'title': 'as built'}},
                                                       {'id': 'r:two', 'type': 'r', 'value': {'title': 'new'}}]}}]}
        status = sender.send(sender.Door(config, tmp / 'work'), payload, tmp / 'status.json', log=lambda line: None)
        self.assertEqual((status['to_write'], status['written']), (1, 1))
        held = json.loads(account.read_text())['records']
        self.assertEqual((held['r:one']['value'], held['r:two']['value']), ({'title': 'edited by hand'}, {'title': 'new'}))


if __name__ == '__main__':
    unittest.main()

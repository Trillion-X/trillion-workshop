"""Stdlib tests for publishing what one saved view shows into a file, from a made-up bakery's list of what is new as
tools/read-a-list-view answers it. Which rows a view keeps and their order are that read's job (its own tests); these tests check what is
published from its answer."""
from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import record_write_send as sender  # noqa: E402
import view_publish  # noqa: E402
import publish_view_file as cli  # noqa: E402

FIELDS = [{'id': 'title', 'kind': 'text'}, {'id': 'stage', 'kind': 'choice'}, {'id': 'flags', 'kind': 'tags'}, {'id': 'day', 'kind': 'date'}]
SHOWN = {
    'tarts': {'title': 'Lemon tarts', 'stage': 'Out', 'flags': ['public'], 'day': '2026-03-09'},
    'rye': {'title': 'Rye on Sundays', 'stage': 'Out', 'flags': ['public'], 'day': '2026-02-01'},
}


class Bakery(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='view-publish-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        # The view's rows in its order, as read-a-list-view answers a page holding the whole view.
        self.read = {'list': 'news', 'fields': FIELDS, 'next': None, 'complete': True, 'of': 4,
                     'rows': [{'id': key, 'values': dict(values), 'title': values['title']} for key, values in SHOWN.items()]}
        self.config = {'view': 'list-view:news:shown'}
        self.out = self.tmp / 'site' / 'news.json'

    def row(self, key):
        return next(row for row in self.read['rows'] if row['id'] == key)

    def publish(self):
        return view_publish.publish(self.read, self.config, self.out, self.tmp)


class Publish(Bakery):

    def test_the_file_holds_the_reads_rows_in_its_order_with_the_lists_fields(self):
        result = self.publish()
        document = json.loads(self.out.read_text())
        self.assertEqual((result['rows'], result['of'], result['written']), (2, 4, True))
        self.assertEqual(document['rows'], [{'id': 'tarts', 'values': SHOWN['tarts']}, {'id': 'rye', 'values': SHOWN['rye']}])
        self.assertEqual(document['fields'], FIELDS)
        self.assertEqual(document['source'], {'view': 'list-view:news:shown', 'list': 'news', 'blake3': result['blake3']})

    def test_publishing_the_same_rows_again_writes_nothing(self):
        first = self.publish()
        before = self.out.stat().st_mtime_ns
        second = self.publish()
        self.assertEqual((second['written'], second['blake3']), (False, first['blake3']))
        self.assertEqual(self.out.stat().st_mtime_ns, before)

    def test_a_changed_row_is_published_under_a_new_key(self):
        first = self.publish()
        self.row('rye')['values']['title'] = 'Rye every day'
        second = self.publish()
        self.assertTrue(second['written'])
        self.assertNotEqual(second['blake3'], first['blake3'])

    def test_a_read_that_holds_only_part_of_the_view_publishes_nothing(self):
        for part in ({'next': '2'}, {'complete': False}):
            with self.subTest(part=part), self.assertRaisesRegex(ValueError, 'only part of the view'):
                view_publish.publish({**self.read, **part}, self.config, self.out, self.tmp)
        self.assertFalse(self.out.exists())

    def test_the_command_line_prints_the_result_and_refuses_a_config_without_the_view(self):
        config, read = self.tmp / 'config.json', self.tmp / 'read.json'
        config.write_text(json.dumps(self.config))
        read.write_text(json.dumps(self.read))
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(cli.main(['--read', str(read), '--config', str(config), '--out', str(self.out)]), 0)
        self.assertEqual(json.loads(out.getvalue())['rows'], 2)
        config.write_text(json.dumps({}))
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(cli.main(['--read', str(read), '--config', str(config), '--out', str(self.out)]), 2)
        self.assertIn('needs view', err.getvalue())


class Media(Bakery):
    def setUp(self):
        super().setUp()
        self.row('rye')['values']['picture'] = json.dumps({'src': 'https://old.example/pics/rye.webp', 'alt': 'Rye loaves'})
        self.row('tarts')['values']['picture'] = {'src': '/already/on-the-site.png'}
        (self.tmp / 'pictures').mkdir()
        (self.tmp / 'pictures' / 'rye.webp').write_bytes(b'rye picture bytes')
        self.config['media'] = {'fields': ['picture'], 'from': [{'prefix': 'https://old.example/pics/', 'folder': 'pictures'}],
                                'into': 'site/public/media', 'served_at': '/media/'}

    def test_a_picture_is_carried_into_the_site_under_its_blake3_and_the_row_names_the_sites_address(self):
        result = self.publish()
        name = sender.blake3_hex(b'rye picture bytes') + '.webp'
        self.assertEqual(result['media'], {'copied': 1, 'kept': 0, 'not_public': 0})
        self.assertEqual((self.tmp / 'site/public/media' / name).read_bytes(), b'rye picture bytes')
        rows = {row['id']: row['values'] for row in json.loads(self.out.read_text())['rows']}
        self.assertEqual(json.loads(rows['rye']['picture']), {'src': f'/media/{name}', 'alt': 'Rye loaves'})
        self.assertEqual(rows['tarts']['picture'], {'src': '/already/on-the-site.png'}, 'an address no prefix matches stays')

    def test_an_unchanged_picture_is_not_copied_again(self):
        self.publish()
        copied = next((self.tmp / 'site/public/media').iterdir())
        before = copied.stat().st_mtime_ns
        second = self.publish()
        self.assertEqual((second['media'], second['written']), ({'copied': 0, 'kept': 1, 'not_public': 0}, False))
        self.assertEqual(copied.stat().st_mtime_ns, before)
        self.assertEqual(len(list((self.tmp / 'site/public/media').iterdir())), 1)

    def test_a_changed_picture_is_carried_under_its_new_name_and_the_file_changes(self):
        first = self.publish()
        (self.tmp / 'pictures' / 'rye.webp').write_bytes(b'a better rye picture')
        second = self.publish()
        self.assertEqual((second['media'], second['written']), ({'copied': 1, 'kept': 0, 'not_public': 0}, True))
        self.assertNotEqual(second['blake3'], first['blake3'])

    def test_a_row_whose_picture_is_not_public_publishes_its_text_with_no_picture_and_copies_nothing(self):
        self.row('rye')['values']['picture_public'] = 'No'
        self.config['media'].update(public_field='picture_public', not_public=['No'])
        result = self.publish()
        self.assertEqual(result['media'], {'copied': 0, 'kept': 0, 'not_public': 1})
        self.assertFalse((self.tmp / 'site/public/media').exists())
        rows = {row['id']: row['values'] for row in json.loads(self.out.read_text())['rows']}
        self.assertIsNone(rows['rye']['picture'])
        self.assertEqual(rows['rye']['title'], 'Rye on Sundays')
        self.assertEqual(rows['tarts']['picture'], {'src': '/already/on-the-site.png'})

    def test_a_missing_picture_publishes_nothing(self):
        (self.tmp / 'pictures' / 'rye.webp').unlink()
        with self.assertRaisesRegex(ValueError, 'rye names https://old.example/pics/rye.webp'):
            self.publish()
        self.assertFalse(self.out.exists())


if __name__ == '__main__':
    unittest.main()

"""Stdlib tests for export-records-as-list-rows, on a made-up toy library (test/fixtures/toy-library) and a mapping written for it.
Run: python3 -I -m unittest discover -s tools/export-records-as-list-rows/test -v   (or npm test)"""
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
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'toy-library'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import export_records_as_list_rows as cli  # noqa: E402
import list_rows  # noqa: E402


class Library(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='list-rows-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'toys'
        shutil.copytree(FIXTURE, self.root)
        self.mapping = json.loads((self.root / 'mapping.json').read_text())
        self.sources = {s['name']: s for s in self.mapping['sources']}

    def rows(self, name, **change):
        return {r['id']: r['values'] for r in list_rows.build(self.root, {**self.sources[name], **change})}


class Transforms(Library):
    def test_a_json_source_with_every_map_transform(self):
        rows = self.rows('toys')
        self.assertEqual(list(rows), ['T-1', 'T-2', 'T-3'])
        self.assertEqual(rows['T-1'], {
            'name': 'kite', 'tags': 'wind; outdoor', 'age': 6, 'pieces': 1, 'state': 'Home', 'kind': 'Toy',
            'loans': 'owner-a park (forms/a1.txt; forms/a2.txt)\nowner-b'})
        self.assertEqual(rows['T-2']['pieces'], 1200, 'a thousands comma is not part of the number')
        self.assertNotIn('tags', rows['T-2'], 'an empty list gives no value')
        self.assertNotIn('loans', rows['T-2'])
        self.assertNotIn('age', rows['T-3'], 'an empty number gives no value')
        self.assertEqual(rows['T-3']['pieces'], 3.5)
        self.assertEqual(rows['T-3']['loans'], 'owner-c school (forms/c1.txt)')

    def test_a_where_filter_keeps_only_matching_records(self):
        self.assertEqual(list(self.rows('toys', where={'state': 'in'})), ['T-1', 'T-3'])

    def test_a_path_walks_dotted_keys(self):
        (self.root / 'data' / 'deep.json').write_text(json.dumps({'a': {'b': [{'id': 'X', 'v': 'one'}]}}))
        source = {'name': 'deep', 'list_id': 'x', 'type': 'json', 'file': 'data/deep.json', 'path': 'a.b', 'id': '{id}', 'map': {'v': {'from': 'v'}}}
        self.assertEqual({r['id']: r['values'] for r in list_rows.build(self.root, source)}, {'X': {'v': 'one'}})

    def test_a_template_with_every_placeholder_empty_gives_no_value(self):
        rec = {'a': '', 'b': None, 'c': 'x'}
        self.assertIsNone(list_rows.transform({'template': '{a} {b}'}, rec, None, Path()))
        self.assertEqual(list_rows.transform({'template': '[{a}] {c}'}, rec, None, Path()), '[] x')

    def test_unknown_transform_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'is not one of the transforms'):
            list_rows.transform({'wish': 1}, {}, None, Path())


class Readers(Library):
    def test_a_tsv_source_computes_fields_from_the_file_and_its_neighbours(self):
        rows = self.rows('titles')
        self.assertEqual(list(rows), ['bk-1', 'bk-2', 'bk-3', 'bk-4', 'bk-5'])
        first = rows['bk-1']
        self.assertEqual(first['title'], 'Tiny tales', 'the first shelf wins a repeated id')
        self.assertEqual((first['shelf'], first['pages'], first['added'], first['kind']), ('shelf-a', 12, '2026-01-05', 'Book'))
        self.assertEqual(first['found_in'], 'Read from shelves/shelf-a/index/titles.tsv')
        self.assertTrue(first['scan'].endswith('shelf-a/index/scans/bk-1.txt'))
        self.assertEqual(first['scan_words'], 6, 'a leading [time] is not a word')
        self.assertTrue(rows['bk-5']['scan'].endswith('shelf-b/index/notes/bk-5.md'), 'the second folder and extension are tried')
        self.assertEqual(rows['bk-5']['scan_words'], 5)
        self.assertNotIn('scan', rows['bk-3'])

    def test_blank_when_empties_fields_and_unmapped_or_malformed_values_give_nothing(self):
        rows = self.rows('titles')
        self.assertNotIn('title', rows['bk-2'])
        self.assertNotIn('pages', rows['bk-2'])
        self.assertEqual(rows['bk-3']['kind'], 'Magazine')
        self.assertNotIn('kind', rows['bk-4'], 'an empty kind is not guessed')
        self.assertNotIn('added', rows['bk-4'], 'a date that is not eight digits gives nothing')

    def test_a_record_with_an_empty_required_field_is_skipped(self):
        self.assertEqual(len(self.rows('titles')), 5, 'the blank row of the file is not a record')

    def test_a_markdown_table_is_read_under_its_heading_only(self):
        rows = self.rows('items')
        self.assertEqual(list(rows), ['it-Big tales', 'it-Old tales', 'it-Post 5'])
        self.assertEqual(rows['it-Big tales'], {'title': 'Big tales', 'owner': 'owner-a', 'pages': 30, 'shelf': 'shelf-a'})
        self.assertEqual(rows['it-Post 5']['link'], 'https://example.test/owner-a/1234567890123456')
        self.assertNotIn('it-Ignored', rows)

    def test_a_missing_section_or_type_is_refused(self):
        with self.assertRaises(ValueError):
            self.rows('items', section='## Nothing here')
        with self.assertRaisesRegex(ValueError, 'type spreadsheet is not one of'):
            self.rows('items', type='spreadsheet')

    def test_first_per_and_exclude(self):
        self.assertEqual(self.rows('owners'), {'holder-owner-a': {'handle': 'owner-a', 'first_item': '`Big tales`'}, 'holder-owner-b': {'handle': 'owner-b', 'first_item': '`Old tales`'}})
        self.assertEqual(list(self.rows('owners', exclude=[{'field': 'owner', 'in': ['owner-a']}])), ['holder-owner-b'])


class Duplicates(Library):
    def test_a_duplicate_row_id_is_refused_unless_the_source_says_what_to_keep(self):
        without = {k: v for k, v in self.sources['titles'].items() if k != 'on_duplicate'}
        with self.assertRaisesRegex(ValueError, 'two records make row id bk-1; add "on_duplicate"'):
            list_rows.build(self.root, without)
        with self.assertRaisesRegex(ValueError, 'on_duplicate must be one of first, last, fill'):
            self.rows('titles', on_duplicate='both')

    def test_last_keeps_the_later_record_in_the_earlier_position(self):
        rows = self.rows('titles', on_duplicate='last')
        self.assertEqual(rows['bk-1']['title'], 'Tiny tales again')
        self.assertEqual(list(rows)[0], 'bk-1')

    def test_fill_keeps_the_first_and_adds_only_fields_it_lacks(self):
        shelf_b = self.root / 'shelves' / 'shelf-b' / 'index' / 'titles.tsv'
        shelf_b.write_text('id\ttitle\tpages\tadded\tkind\tgroup\nbk-1\tOther\t\t20260301\tmagazines\t\n')
        rows = self.rows('titles', on_duplicate='fill')
        self.assertEqual((rows['bk-1']['title'], rows['bk-1']['kind'], rows['bk-1']['added']), ('Tiny tales', 'Book', '2026-01-05'))
        shelf_a = self.root / 'shelves' / 'shelf-a' / 'index' / 'titles.tsv'
        shelf_a.write_text('id\ttitle\tpages\tadded\tkind\tgroup\nbk-1\tTiny tales\t12\t\t\t\n')
        rows = self.rows('titles', on_duplicate='fill')
        self.assertEqual((rows['bk-1']['added'], rows['bk-1']['kind']), ('2026-03-01', 'Magazine'))


class Export(Library):
    def export(self, out, **kw):
        return list_rows.export(self.mapping, self.root, out, **kw)

    def test_export_writes_lists_batches_and_a_manifest(self):
        out = self.tmp / 'out'
        manifest = self.export(out, batch=2)
        lists = json.loads((out / 'make_lists.json').read_text())
        self.assertEqual(lists['lists'][0]['list']['id'], 'toys')
        self.assertNotIn('why', lists['lists'][0])
        self.assertEqual(manifest['counts']['toys'], {'list_id': 'toys', 'rows': 3})
        self.assertEqual([(b['file'], b['rows']) for b in manifest['batches'] if b['list_id'] == 'toys'], [('toys-000.json', 2), ('toys-001.json', 1)])
        batch = json.loads((out / 'toys-000.json').read_text())
        self.assertEqual((batch['list_id'], [r['id'] for r in batch['rows']]), ('toys', ['T-1', 'T-2']))
        self.assertEqual(json.loads((out / 'manifest.json').read_text()), manifest)

    def test_skip_ids_and_only(self):
        out = self.tmp / 'out'
        manifest = self.export(out, only='toys', skip={'toys': ['T-2']})
        self.assertEqual(list(manifest['counts']), ['toys'])
        self.assertEqual([r['id'] for r in json.loads((out / 'toys-000.json').read_text())['rows']], ['T-1', 'T-3'])

    def test_a_second_export_replaces_only_what_the_first_wrote(self):
        out = self.tmp / 'out'
        self.export(out, batch=1)
        (out / 'keep-me.json').write_text('{}')
        self.assertTrue((out / 'toys-002.json').is_file())
        self.export(out, batch=100)
        self.assertFalse((out / 'toys-002.json').exists(), 'a batch of the first export that the second does not make is removed')
        self.assertTrue((out / 'keep-me.json').is_file(), 'a file that was not exported is left alone')

    def test_the_command_exports_and_refuses_with_a_reason(self):
        out, err = io.StringIO(), io.StringIO()
        argv = ['--mapping', str(self.root / 'mapping.json'), '--root', str(self.root), '--out', str(self.tmp / 'cli-out')]
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(cli.main(argv), 0)
            self.assertEqual(cli.main([*argv, '--batch', '0']), 2)
            self.assertEqual(cli.main([*argv[:-2], '--out', str(self.tmp / 'x'), '--only', 'owners', '--skip-ids', str(self.tmp / 'missing.json')]), 2)
        self.assertEqual(json.loads(out.getvalue())['toys']['rows'], 3)
        self.assertIn('--batch must be at least 1', err.getvalue())
        self.assertIn('missing.json', err.getvalue())


if __name__ == '__main__':
    unittest.main()

"""Stdlib tests for the record sources and expressions a mapping uses to read a whole library of files into lists the person
already has: tab-separated tables, markdown lines and tables, whole text files, rows kept in the mapping itself, rows worked
out again once later rows exist, lists read from the account and widened, and a mapping kept as a setting row. Every row is
made up (a made-up orchard almanac). Run: python3 -I -m unittest discover -s tools/export-records-as-list-rows/test -v"""
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
import build_record_write as cli  # noqa: E402
import expressions  # noqa: E402
import records_write  # noqa: E402

AT = '2026-01-01T00:00:00.000Z'

TREES = 'grove\tkind\tname\tviews\turl\n' + '\n'.join([
    'north\tapple\t"Is it ripe?" a picking guide\t1200\thttps://example.com/v?v=aa1',
    'north\tpear\tPlain pear\t1000\thttps://example.com/v?v=aa2',
    'south\tplum\tWhy the plum splits\t50000\thttps://example.com/v?v=bb1',
    'south\tplum\tbroken line with too few cells',
])

ALMANAC = '\n'.join([
    '# Orchard almanac',
    '| 9 | not in section two | 1 |',
    '## 2. Plantings',
    '### Grove: north',
    '| T1 | Apple row | aa1 |',
    '| T2 | Pear row \\| with a bar | aa2 |',
    '### Grove: south',
    '| T3 | Plum row | bb1 |',
    '## 3. Later',
    '| T4 | After the end | bb1 |',
])

# The lists the account holds, as records:read gives them: trees has no `grove_size` field yet; plantings is already right.
HELD = [
    {'id': 'list:trees', 'type': 'list', 'value': {'label': 'Trees', 'row_type': 'trees', 'title_field': 'name', 'fields': [
        {'id': 'name', 'label': 'Name', 'kind': 'text'}, {'id': 'kind', 'label': 'Kind', 'kind': 'choice', 'choices': ['apple']},
        {'id': 'views', 'label': 'Views', 'kind': 'number'}]}},
    {'id': 'list:plantings', 'type': 'list', 'value': {'label': 'Plantings', 'row_type': 'plantings', 'title_field': 'name', 'fields': [
        {'id': 'name', 'label': 'Name', 'kind': 'text'}, {'id': 'grove', 'label': 'Grove', 'kind': 'text'},
        {'id': 'trees', 'label': 'Trees', 'kind': 'link', 'links_to': 'trees'}]}},
    {'id': 'list:notes', 'type': 'list', 'value': {'label': 'Notes', 'row_type': 'notes', 'title_field': 'line', 'fields': [
        {'id': 'line', 'label': 'Line', 'kind': 'text'}, {'id': 'about', 'label': 'About', 'kind': 'text'}]}},
]


def mapping() -> dict:
    return {
        'lists_read': {'config': {'root': 'settings', 'path': 'door.json'}, 'ids': ['trees', 'plantings', 'notes']},
        'lists_add': {'trees': {'fields': [{'id': 'planted_in', 'label': 'Planted in', 'kind': 'link', 'links_to': 'plantings'},
                                           {'id': 'views', 'label': 'Views seen'}],
                                'choices': {'kind': ['pear', 'apple', 'plum']}, 'set': {'opens_on': 'by-views'}}},
        'views': [{'list': 'trees', 'order': 'a', 'view': {'id': 'by-views', 'label': 'By views', 'sort': [{'field': 'views', 'direction': 'desc'}]}}],
        'by': 'orchard-build', 'confidence': 'high', 'emit': ['trees', 'plantings', 'notes'],
        'tables': {'notes': [{'id': 'n1', 'about': 'north', 'lines': ['first', 'second']}, {'id': 'n2', 'about': 'south', 'lines': []}]},
        'sources': [
            {'name': 'trees', 'list': 'trees', 'kind': 'staged', 'inputs': [{'root': 'data', 'path': 'trees.tsv'}],
             'keys': {'tree_id': {'capture': {'from': 'url', 'pattern': 'v=([a-z0-9]+)'}}, 'id': {'text': 'tree-{tree_id}'}},
             'compute': {'views_n': {'to_number': {'path': 'views'}}, 'plain_name': {'plain': {'path': 'name'}}},
             'skip_if': {'less': [{'path': 'views_n'}, 1100]},
             'values': {'name': {'path': 'name'}, 'kind': {'path': 'kind'}, 'views': {'path': 'views_n'}},
             'basis': {'views': {'reasoning': {'text': 'Read from the {grove} grove table.'}, 'sources': {'list': ['trees.tsv']}},
                       'name': {'confidence': 'low', 'reasoning': 'As typed.', 'sources': {'list': ['trees.tsv']}}}},
            {'name': 'plantings', 'list': 'plantings', 'kind': 'staged',
             'inputs': [{'root': 'data', 'path': 'almanac.md', 'format': 'lines', 'start': '^## 2\\.', 'end': '^## 3\\.',
                         'carry': ['^### Grove: (?P<grove>\\w+)'], 'needs_carry': True, 'pattern': '^\\| (?P<code>T\\d+) \\|', 'cells': True}],
             'keys': {'id': {'text': 'planting-{code}'}},
             'compute': {'tree_cell': {'path': 'cells.2'}, 'tree': {'text': 'tree-{tree_cell}'}, 'name_cell': {'path': 'cells.1'},
                         'trees_here': {'where': {'list': 'trees', 'if': {'equals': [{'path': 'row.id'}, {'path': 'tree'}]}}}},
             'values': {'name': {'path': 'name_cell'}, 'grove': {'path': 'grove'}, 'trees': {'path': 'trees_here'}, 'line': {'path': 'line'}}},
            {'name': 'tree-plantings', 'list': 'trees', 'kind': 'again', 'again': {'list': 'trees'}, 'on_duplicate': 'fill',
             'compute': {'in': {'where': {'list': 'plantings', 'if': {'contains': [{'path': 'row.trees'}, {'path': 'id'}]}}}},
             'skip_if': {'empty': {'path': 'in'}}, 'values': {'planted_in': {'path': 'in'}}},
            {'name': 'note-lines', 'list': 'notes', 'kind': 'staged', 'inputs': [{'root': 'mapping', 'path': 'tables.notes', 'each': 'lines'}],
             'keys': {'note': {'path': '_parent.id'}, 'id': {'text': '{note}-{_index}'}},
             'values': {'line': {'path': 'value'}, 'about': {'path': '_parent.about'}}},
            {'name': 'readme', 'list': 'notes', 'kind': 'staged', 'inputs': [{'root': 'data', 'path': 'README.txt', 'format': 'text'}],
             'keys': {'id': {'text': 'readme'}}, 'values': {'line': {'squash': {'path': 'text'}}}},
        ],
    }


def lists_reader(held):
    def read(source):
        spec = source['records']
        return [r for r in held if r['type'] == spec['type'] and r['id'].startswith(spec.get('prefix') or '')]
    return read


class Orchard(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='record-write-orchard-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / 'trees.tsv').write_text(TREES)
        (self.tmp / 'almanac.md').write_text(ALMANAC)
        (self.tmp / 'README.txt').write_text('  The orchard\n\n  in short.  ')
        self.roots = {'data': self.tmp, 'settings': self.tmp}

    def build(self, m=None, held=HELD):
        return records_write.build(m or mapping(), self.roots, AT, record_reader=lists_reader(held))

    def records(self, payload):
        return {r['id']: r for c in payload['commands'] for r in c['input']['records']}

    def test_a_tsv_reads_quote_marks_as_words_and_skips_short_lines_and_rows_skip_if_leaves_out(self):
        got = self.records(self.build())
        trees = {k: v['value'] for k, v in got.items() if v['type'] == 'record:trees'}
        self.assertEqual(sorted(trees), ['record:trees:tree-aa1', 'record:trees:tree-bb1'])  # aa2 has 1,000 views: skipped
        self.assertEqual(trees['record:trees:tree-aa1']['name'], '"Is it ripe?" a picking guide')
        self.assertEqual(trees['record:trees:tree-bb1']['views'], 50000)

    def test_markdown_lines_carry_their_heading_stay_inside_the_section_and_keep_escaped_bars(self):
        got = self.records(self.build())
        plantings = {k.rsplit(':', 1)[1]: v['value'] for k, v in got.items() if v['type'] == 'record:plantings'}
        self.assertEqual(sorted(plantings), ['planting-T1', 'planting-T2', 'planting-T3'])
        self.assertEqual(plantings['planting-T2']['name'], 'Pear row | with a bar')
        self.assertEqual((plantings['planting-T1']['grove'], plantings['planting-T3']['grove']), ('north', 'south'))
        self.assertEqual(plantings['planting-T3']['line'], 8)
        self.assertEqual(plantings['planting-T1']['trees'], ['tree-aa1'])
        self.assertNotIn('trees', plantings['planting-T2'])  # its tree was skipped, so no link is made

    def test_an_again_source_links_rows_to_rows_made_after_them_and_needs_a_duplicate_policy(self):
        got = self.records(self.build())
        self.assertEqual(got['record:trees:tree-aa1']['value']['planted_in'], ['planting-T1'])
        self.assertEqual(got['record:trees:tree-bb1']['value']['planted_in'], ['planting-T3'])
        self.assertEqual(got['record:trees:tree-bb1']['value']['views'], 50000)  # filled, not replaced
        m = mapping()
        del m['sources'][2]['on_duplicate']
        with self.assertRaisesRegex(ValueError, 'give on_duplicate fill or over'):
            self.build(m)

    def test_rows_kept_in_the_mapping_one_per_item_and_a_whole_text_file_as_one_row(self):
        got = self.records(self.build())
        notes = {k.rsplit(':', 1)[1]: v['value'] for k, v in got.items() if v['type'] == 'record:notes'}
        self.assertEqual(notes, {'n1-0': {'line': 'first', 'about': 'north'}, 'n1-1': {'line': 'second', 'about': 'north'},
                                 'readme': {'line': 'The orchard in short.'}})

    def test_a_basis_may_say_its_own_confidence(self):
        got = self.records(self.build())
        basis = got['record:trees:tree-aa1']['value']['_basis']
        self.assertEqual((basis['views']['confidence'], basis['name']['confidence']), ('high', 'low'))
        self.assertEqual(basis['views']['reasoning'], 'Read from the north grove table.')

    def test_lists_read_from_the_account_are_widened_and_only_a_changed_list_is_written(self):
        payload = self.build()
        got = self.records(payload)
        lists = {k: v['value'] for k, v in got.items() if v['type'] == 'list'}
        self.assertEqual(list(lists), ['list:trees'])  # plantings is unchanged, so it is not written again
        trees = lists['list:trees']
        self.assertEqual([f['id'] for f in trees['fields']], ['name', 'kind', 'views', 'planted_in'])
        self.assertEqual(trees['fields'][2], {'id': 'views', 'label': 'Views seen', 'kind': 'number'})
        self.assertEqual(trees['fields'][1]['choices'], ['apple', 'pear', 'plum'])
        self.assertEqual(trees['opens_on'], 'by-views')
        self.assertEqual(payload['counts']['lists'], 1)
        self.assertIn('list-view:trees:by-views', got)

    def test_lists_read_refuses_a_list_the_account_lacks_and_an_addition_to_a_list_not_read(self):
        with self.assertRaisesRegex(ValueError, 'holds no list plantings'):
            self.build(held=[HELD[0], HELD[2]])
        m = mapping()
        m['lists_add']['orchards'] = {'fields': []}
        with self.assertRaisesRegex(ValueError, 'lists_add names orchards'):
            self.build(m)
        m = mapping()
        m['lists_add']['trees']['choices'] = {'colour': ['red']}
        with self.assertRaisesRegex(ValueError, 'colour, a field the list does not have'):
            self.build(m)
        with self.assertRaisesRegex(ValueError, 'give the run a records reader'):
            records_write.build(mapping(), self.roots, AT)

    def test_an_unknown_format_is_refused_by_name(self):
        m = mapping()
        m['sources'][0]['inputs'][0]['format'] = 'xml'
        with self.assertRaisesRegex(ValueError, 'format xml is not one of'):
            self.build(m)


class Expressions(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='record-write-expr-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / 'a.md').write_text('# Top\n## Script\none\n two \n## After\nlast\n')
        (self.tmp / 'b.json').write_text(json.dumps({'text': 'hello', 'deep': {'x': [1, 2]}}))
        self.ctx = expressions.Context({'d': self.tmp})

    def ev(self, t, rec=None):
        return expressions.evaluate(t, rec or {}, self.ctx)

    def test_lists(self):
        rec = {'xs': [{'id': 'a', 'n': 3}, {'id': 'b', 'n': 1}, {'id': 'c'}]}
        self.assertEqual(self.ev({'map': {'of': {'path': 'xs'}, 'do': {'path': 'item.n'}}}, rec), [3, 1])
        self.assertEqual(self.ev({'filter': {'of': {'path': 'xs'}, 'where': {'set': {'path': 'item.n'}}}}, rec), rec['xs'][:2])
        self.assertEqual(self.ev({'flat': {'list': [['a', 'b'], ['c']]}}), ['a', 'b', 'c'])
        self.assertEqual([self.ev({k: {'list': ['b', 'a']}}) for k in ('first', 'last', 'sorted', 'length')], ['b', 'a', ['a', 'b'], 2])

    def test_text_and_numbers(self):
        self.assertEqual(self.ev({'plain': 'It’s  “Ripe”\n'}), 'it\'s "ripe"')
        self.assertEqual(self.ev({'round': {'of': 2.25, 'digits': 1}}), 2.3)  # half up, as JavaScript rounds
        self.assertEqual(self.ev({'round': {'of': 4.0, 'digits': 1}}), 4)
        self.assertEqual(self.ev({'minus': ['10', 2.5]}), 7.5)
        self.assertEqual(self.ev({'plus': [1.5, 1.5]}), 3)
        self.assertEqual(self.ev({'thousands': 1234567}), '1,234,567')
        self.assertEqual([self.ev({'number_text': v}) for v in (0.0, 8.38, 12, None)], ['0', '8.38', '12', None])
        self.assertEqual(self.ev({'day': 'Wed Sep 02 23:30:00 -0200 2026'}), '2026-09-03')
        self.assertEqual(self.ev({'day': '2026-09-02T10:00:00Z'}), '2026-09-02')
        self.assertIsNone(self.ev({'day': 'soon'}))
        self.assertEqual(self.ev({'uri': 'north/row 1'}), 'north%2Frow%201')
        self.assertEqual(self.ev({'regex_all': {'of': 'a1 b2', 'pattern': '([a-z])\\d'}}), ['a', 'b'])
        self.assertEqual(self.ev({'regex_table': {'of': 'x: 1\ny: 2 ', 'pattern': '(\\w): (.*)'}}), {'x': '1', 'y': '2'})
        self.assertEqual(self.ev({'resplit': {'of': 'a...b', 'pattern': '\\.\\.\\.'}}), ['a', 'b'])
        self.assertEqual(self.ev({'replace': {'of': 'aaa', 'pattern': 'a', 'with': 'b', 'count': 2}}), 'bba')
        self.assertEqual(self.ev({'let': {'names': {'x': 'one', 'y': {'text': '{x}-two'}}, 'in': {'path': 'y'}}}), 'one-two')

    def test_fit_cuts_on_steps_and_counts_as_a_javascript_service_does(self):
        words = 'é' * 300
        cut = self.ev({'fit': {'of': words, 'max': 120, 'note': ' [cut at {max}; whole: {whole}]', 'whole': 'w.txt', 'step': 10}})
        self.assertTrue(cut.endswith(' [cut at 120; whole: w.txt]'))
        self.assertLessEqual(expressions.json_length(cut), 120)
        self.assertEqual(self.ev({'fit': {'of': 'short', 'max': 120, 'note': 'x'}}), 'short')

    def test_files(self):
        ref = {'object': {'root': 'd', 'path': 'a.md'}}
        self.assertEqual(self.ev({'text_between': {'file': ref, 'start': '^## Script', 'end': '^## '}}),
                         {'text': 'one\n two', 'from_line': 3, 'to_line': 4})
        self.assertIsNone(self.ev({'text_between': {'file': ref, 'after': '^## After', 'start': '^## Script', 'end': '^## '}}))
        self.assertEqual(self.ev({'line_of': {'file': ref, 'line': 1}}), '# Top')
        self.assertEqual(self.ev({'line_of': {'file': ref, 'line': 99}}), '')
        self.assertEqual(self.ev({'first_existing': {'root': 'd', 'paths': {'list': ['none.json', 'b.json']}}}), {'root': 'd', 'path': 'b.json'})
        self.assertEqual(self.ev({'read_json': {'file': {'object': {'root': 'd', 'path': 'b.json'}}, 'at': 'text'}}), 'hello')
        self.assertEqual(self.ev({'strings_at': {'of': {'path': 'xs'}, 'at': '*.a.b'}}, {'xs': [{'a': {'b': 'x'}}, {'a': {'b': 'y'}}, {'a': 3}]}), ['x', 'y'])
        self.assertEqual(self.ev({'path_text': {'object': {'root': 'd', 'path': 'a.md'}}}), str(self.tmp / 'a.md'))
        self.assertTrue(expressions.holds({'exists': {'object': {'root': 'd', 'path': 'a.md'}}}, {}, self.ctx))
        self.assertTrue(expressions.holds({'contains': [{'list': ['a', 'b']}, 'b']}, {}, self.ctx))
        self.assertTrue(expressions.holds({'in': ['a', 'cat']}, {}, self.ctx))
        self.assertTrue(expressions.holds({'starts_with': ['north', 'no']}, {}, self.ctx))
        self.assertFalse(expressions.holds({'less': ['1', 2]}, {}, self.ctx))


class MappingAsASetting(unittest.TestCase):
    """The mapping a person keeps in their account as a setting row of list:settings (tools/settings), read from saved reads."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='record-write-setting-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / 'trees.tsv').write_text(TREES)
        (self.tmp / 'almanac.md').write_text(ALMANAC)
        (self.tmp / 'README.txt').write_text('The orchard.')
        (self.tmp / 'mapping.json').write_text(json.dumps(mapping()))

    def keep(self, most):
        code, _, err = self.run_cli('--mapping', str(self.tmp / 'mapping.json'), '--as-setting', 'account~orchard', '--setting-name',
                                    'Orchard almanac rows', '--setting-from', 'orchard/mapping.json@0000000', '--command-bytes', str(most),
                                    '--out', str(self.tmp / 'setting-payload.json'))
        self.assertEqual(code, 0, err)
        payload = json.loads((self.tmp / 'setting-payload.json').read_text())
        records = [r for c in payload['commands'] for r in c['input']['records']]
        (self.tmp / 'held.json').write_text(json.dumps({'records': [*records, *HELD]}))
        return records

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def built_from_the_setting(self):
        common = ['--root', f'data={self.tmp}', '--root', f'settings={self.tmp}', '--records-from', str(self.tmp / 'held.json')]
        code, _, err = self.run_cli('--mapping-record', 'record:setting:export-records-as-list-rows~account~orchard',
                                    '--out', str(self.tmp / 'a.json'), *common)
        self.assertEqual(code, 0, err)
        code, _, err = self.run_cli('--mapping', str(self.tmp / 'mapping.json'), '--out', str(self.tmp / 'b.json'), *common)
        self.assertEqual(code, 0, err)
        a, b = (json.loads((self.tmp / n).read_text()) for n in ('a.json', 'b.json'))
        for payload in (a, b):
            payload.pop('built_at', None)
            for record in (r for c in payload['commands'] for r in c['input']['records']):
                for basis in (record['value'].get('_basis') or {}).values():
                    basis.pop('at', None)
        self.assertEqual(a['commands'], b['commands'])

    def test_one_setting_row_keeps_the_mapping_text_in_its_own_key_order(self):
        records = self.keep(49152)
        self.assertEqual([r['id'] for r in records], ['list:settings', 'record:setting:export-records-as-list-rows~account~orchard'])
        value = records[1]['value']
        self.assertEqual((value['tool'], value['scope_kind'], value['scope_id'], value['status']),
                         ('tool:build-records-to-write', 'account', 'orchard', 'active'))
        self.assertEqual(list(json.loads(value['settings'])['sources'][0]['keys']), ['tree_id', 'id'])  # not sorted: id needs tree_id
        self.built_from_the_setting()

    def test_a_mapping_too_big_for_one_command_is_kept_in_parts_and_read_back_whole(self):
        records = self.keep(2600)
        ids = [r['id'] for r in records[1:]]
        self.assertGreater(len(ids), 1)
        first = json.loads(records[1]['value']['settings'])
        self.assertEqual(first['parts'], ids[1:])
        self.assertTrue(all(len(json.dumps({'records': [r]}, separators=(',', ':')).encode()) <= 2600 for r in records))
        self.built_from_the_setting()
        code, _, err = self.run_cli('--mapping', str(self.tmp / 'mapping.json'), '--as-setting', 'account~orchard', '--setting-name', 'x',
                                    '--setting-from', 'y', '--command-bytes', '900', '--out', str(self.tmp / 'too-small.json'))
        self.assertEqual(code, 2)
        self.assertIn('one source alone is too big', err)

    def test_a_setting_of_another_tool_or_a_missing_one_is_refused(self):
        self.keep(49152)
        common = ['--out', str(self.tmp / 'a.json'), '--records-from', str(self.tmp / 'held.json')]
        code, _, err = self.run_cli('--mapping-record', 'record:setting:cite-principles-from-captions~account~main', *common)
        self.assertEqual(code, 2)
        self.assertIn('not of export-records-as-list-rows', err)
        code, _, err = self.run_cli('--mapping-record', 'record:setting:export-records-as-list-rows~account~other', *common)
        self.assertEqual(code, 2)
        self.assertIn('holds no setting', err)
        code, _, err = self.run_cli('--mapping-record', 'record:setting:export-records-as-list-rows~account~orchard', '--out', str(self.tmp / 'a.json'))
        self.assertEqual(code, 2)
        self.assertIn('--records-from', err)


if __name__ == '__main__':
    unittest.main()

"""Stdlib tests for the records:write builder, on a made-up pantry library (test/fixtures/pantry) copied to a temporary folder.
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
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'pantry'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import build_record_write as cli  # noqa: E402
import expressions  # noqa: E402
import records_write  # noqa: E402

AT = '2026-01-01T00:00:00.000Z'


class Pantry(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='record-write-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'pantry'
        shutil.copytree(FIXTURE, self.root)
        self.mapping = self.load('mapping.json')

    def load(self, name):
        return json.loads((self.root / name).read_text())

    def save(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def build(self, **change):
        return records_write.build({**self.mapping, **change}, {'here': self.root, 'data': self.root}, AT)

    def records(self, payload=None):
        return {r['id']: r for c in (payload or self.build())['commands'] for r in c['input']['records']}


class Records(Pantry):
    def test_lists_views_and_rows_become_records_in_the_declared_order_in_commands_of_the_limit(self):
        payload = self.build()
        batches = [[r['id'] for r in c['input']['records']] for c in payload['commands']]
        self.assertEqual([len(b) for b in batches], [3, 3, 3, 3, 2])
        flat = [i for b in batches for i in b]
        self.assertEqual(flat[:3], ['list:stores', 'list:goods', 'list-view:goods:by-store'])
        self.assertEqual(flat[3:6], ['record:stores:corner', 'record:stores:market', 'record:stores:newshop'])
        self.assertEqual(flat[6:9], ['record:goods:market:flour', 'record:goods:market:oats', 'record:goods:market:salt'])
        records = self.records(payload)
        self.assertEqual(records['list-view:goods:by-store']['type'], 'list-view')
        self.assertEqual(records['list-view:goods:by-store']['value']['list_id'], 'goods')
        self.assertEqual(records['record:goods:market:flour']['type'], 'record:goods')
        self.assertEqual((payload['counts']['records'], payload['counts']['commands']), (14, 5))
        self.assertEqual(payload['_what'], 'A made-up payload for the tests.')
        self.assertEqual(payload['built_at'], AT)

    def test_the_names_of_records_come_from_the_mapping_when_it_gives_them(self):
        ids = {'list': 'collection:{id}', 'row': 'item:{row_type}/{id}', 'row_type': 'item-of-{row_type}', 'view': 'saved:{list}:{view_id}', 'view_type': 'saved-view'}
        records = self.records(self.build(ids=ids))
        self.assertIn('collection:stores', records)
        self.assertEqual(records['item:stores/corner']['type'], 'item-of-stores')
        self.assertEqual(records['saved:goods:by-store']['type'], 'saved-view')

    def test_rows_made_from_staged_files_keep_their_own_values_and_say_why_in_a_basis(self):
        flour = self.records()['record:goods:market:flour']['value']
        self.assertEqual(flour['uses'], ['baking', 'bread'], 'the staged row had none: read from the uses file')
        self.assertEqual(flour['blurb'], 'Flour for any loaf.', 'the uses file rewrote the description')
        self.assertEqual(flour['store'], ['market'])
        self.assertEqual(flour['where_to_buy'], 'https://market.test/flour')
        self.assertEqual(flour['_basis']['blurb'], {
            'confidence': 'medium', 'by': 'pantry-build', 'at': AT,
            'reasoning': 'Read on 2026-01-02; seen 4 times, in here staged/market-stock.json. Reworded; it was: White flour for bread.',
            'sources': ['/lists/stores/market', 'https://market.test/flour', 'here staged/market-stock.json']})
        self.assertEqual(flour['_basis']['uses']['reasoning'], 'Read from the description.')
        self.assertEqual(len(flour['_basis']['uses']['sources']), 3, 'a basis names at most the limit of sources, the first of each kept')

    def test_a_staged_text_of_words_is_split_a_pointer_is_replaced_by_the_stores_address_and_an_empty_description_is_kept(self):
        records = self.records()
        oats, salt = records['record:goods:market:oats']['value'], records['record:goods:market:salt']['value']
        self.assertEqual(oats['uses'], ['grain', 'porridge'])
        self.assertEqual(oats['where_to_buy'], 'https://market.test/stock')
        self.assertIn('the note pointed at stock-notes.md', oats['_basis']['blurb']['reasoning'])
        self.assertEqual(oats['_basis']['uses']['reasoning'], 'As staged.')
        self.assertEqual(salt['blurb'], '')

    def test_rows_in_another_shape_are_read_by_their_field_names_and_get_an_id_from_the_file_and_a_field(self):
        records = self.records()
        plum = records['record:goods:jam:jam-1:plum-jam']['value']
        self.assertEqual((plum['name'], plum['kind'], plum['blurb'], plum['store']), ('Plum jam', 'preserve', 'Sweet and dark.', ['corner']))
        self.assertNotIn('record:goods:jam:jam-1:skipped', records, 'only rows that equal `keep` are made')
        rye = records['record:goods:jam:jam-2:rye-bread']['value']
        self.assertEqual(rye['where_to_buy'], 'https://corner.test/stock', 'the store names an address for rows that point at a note')
        self.assertEqual(rye['uses'], ['loaf', 'rye'])

    def test_a_store_row_with_a_document_carries_it_under_its_note_with_a_basis_and_the_count_of_its_goods(self):
        corner = self.records()['record:stores:corner']['value']
        self.assertEqual(corner['stocked'], 4)
        self.assertEqual(corner['notes'], "> Copied from the store's own page.\n\nThe corner store sells jam, tea and bread.\n")
        self.assertEqual(corner['_basis']['notes']['reasoning'], "Copied when the store was read. Copied from the store's own page.")
        self.assertEqual(corner['_basis']['notes']['sources'], ['https://corner.test/', 'pantry documents/corner.md'])
        self.assertNotIn('_basis', self.records()['record:stores:market']['value'], 'a row with no document has no basis')

    def test_added_rows_take_the_address_of_an_override_then_the_stores_then_their_first_source_and_say_what_they_need(self):
        records = self.records()
        one, two = records['record:goods:extra-1']['value'], records['record:goods:extra-2']['value']
        self.assertEqual(one['where_to_buy'], 'https://corner.test/stock')
        self.assertEqual(one['pairs_with'], ['extra-2'])
        self.assertEqual(one['_basis']['blurb']['reasoning'], 'Written from point 3. It needs extra-2.')
        self.assertEqual(two['_basis']['blurb']['reasoning'], 'Written from the files named.')
        self.assertEqual(two['_basis']['uses']['sources'], ['/lists/stores/corner', 'https://corner.test/b', 'https://corner.test/c'])

    def test_a_file_that_names_a_new_store_makes_its_row_and_an_overridden_address_wins(self):
        records = self.records()
        self.assertEqual(records['record:stores:newshop']['value'], {'name': 'New Shop', 'url': 'https://newshop.test/', 'licence': 'CC0', 'stocked': 1})
        stores = self.load('stores.json')
        stores['stores'][0]['address_overrides'] = {'extra-1': 'https://corner.test/special'}
        self.save('stores.json', stores)
        self.assertEqual(self.records()['record:goods:extra-1']['value']['where_to_buy'], 'https://corner.test/special')

    def test_what_is_pending_diverted_or_counted_is_in_the_payload(self):
        payload = self.build()
        self.assertEqual(payload['pending'], [
            {'file': 'here staged/not-there-yet.json', 'reason': 'not there yet'},
            {'file': 'here staged/optional-unknown.json', 'reason': 'rows name store later, which needs a store row'}])
        self.assertEqual(payload['extra_links'], [{'target': 'jam-2', 'url': 'https://corner.test/other-jam', 'file': 'here staged/more/jam-1.jsonl', 'target_made': False}])
        self.assertEqual(payload['counts']['rows'], {'goods': 8, 'stores': 3})
        self.assertEqual(payload['counts']['breakdown'], {'corner': {'staged': 2, 'total': 4}, 'market': {'staged': 3, 'total': 3}, 'newshop': {'staged': 1, 'total': 1}})

    def test_a_diverted_note_whose_target_is_made_says_so(self):
        notes = self.root / 'staged' / 'more' / 'jam-1.jsonl'
        notes.write_text(notes.read_text().replace('"row_id":"jam-2"', '"row_id":"market:salt"'))
        self.assertEqual(self.build()['extra_links'][0]['target_made'], True)


class Refusals(Pantry):
    def refuses(self, message, **change):
        with self.assertRaisesRegex(ValueError, message):
            self.build(**change)

    def test_a_row_with_no_address_or_no_words_is_refused_by_name(self):
        stores = self.load('stores.json')
        del stores['stores'][1]['address_for_rows']
        self.save('stores.json', stores)
        self.refuses('market:oats has no web address and its store names none')
        uses = self.load('uses.json')
        del uses['rows']['market:flour']
        self.save('uses.json', uses)
        stores['stores'][1]['address_for_rows'] = 'https://market.test/stock'
        self.save('stores.json', stores)
        self.refuses('market:flour has no uses: add its row to uses.json')

    def test_two_rows_with_one_id_a_slash_in_an_id_or_a_missing_link_target_are_refused(self):
        extras = self.load('extras.json')
        extras['rows'][1]['id'] = 'extra-1'
        self.save('extras.json', extras)
        self.refuses('Two goods rows share the id extra-1')
        extras['rows'][1]['id'] = 'extra/2'
        self.save('extras.json', extras)
        self.refuses('extra/2 holds a slash')
        extras['rows'][1]['id'] = 'extra-3'
        self.save('extras.json', extras)
        self.refuses('extra-1 pairs with extra-2, which is not a good')

    def test_a_row_naming_a_store_with_no_row_is_refused_and_a_too_long_field_is_refused(self):
        found = self.root / 'staged' / 'market-stock.json'
        found.write_text(found.read_text().replace('"id": "market:salt",', '"id": "market:salt", "site": "ghost",'))
        found.write_text(found.read_text().replace('stock-notes.md', 'https://market.test/oats'))
        inputs = self.load('inputs.json')
        inputs['inputs'][0].pop('store')
        self.save('inputs.json', inputs)
        stores = self.load('stores.json')
        stores['stores'][0]['address_for_rows'] = stores['stores'][1]['address_for_rows'] = 'https://x.test/'
        self.save('stores.json', stores)
        self.refuses('names store (ghost|None)')
        self.save('inputs.json', {'inputs': [{'root': 'here', 'path': 'staged/market-stock.json', 'store': 'market'}]})
        found.write_text(found.read_text().replace('Rolled oats.', 'o' * 130))
        self.refuses('market:oats blurb is longer than 120 characters')

    def test_a_basis_naming_more_sources_than_the_limit_is_refused(self):
        goods = {**self.mapping['sources'][1], 'compute_after': {**self.mapping['sources'][1]['compute_after'], 'basis_sources': {'path': 'cited'}}}
        self.refuses('A basis names at most 2 sources', sources=[self.mapping['sources'][0], goods], limits={'text_chars': 120, 'basis_sources': 2, 'per_command': 3})

    def test_an_unknown_root_and_a_missing_list_definition_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'No folder was given for root data'):
            records_write.build(self.mapping, {'here': self.root}, AT)
        (self.root / 'shelf-lists.json').unlink()
        with self.assertRaises(OSError):
            self.build()


class Expressions(unittest.TestCase):
    def ev(self, t, rec=None, **rows):
        ctx = expressions.Context({})
        ctx.rows = rows.get('rows', {})
        ctx.recs = rows.get('recs', {})
        return expressions.evaluate(t, rec or {}, ctx)

    def test_paths_dig_into_objects_and_lists(self):
        rec = {'a': {'b': [{'c': 1}, {'c': 2}]}}
        self.assertEqual(self.ev({'path': 'a.b.1.c'}, rec), 2)
        self.assertIsNone(self.ev({'path': 'a.b.5.c'}, rec))
        self.assertIsNone(self.ev({'path': 'a.x'}, rec))

    def test_if_conditions_and_first_set_are_lazy(self):
        rec = {'a': 'x', 'b': ''}
        self.assertEqual(self.ev({'if': {'all': [{'set': {'path': 'a'}}, {'empty': {'path': 'b'}}, {'not': {'equals': [{'path': 'a'}, 'y']}}]}, 'then': 'yes', 'else': 'no'}, rec), 'yes')
        self.assertEqual(self.ev({'if': {'any': [{'matches': {'of': {'path': 'a'}, 'pattern': '^y'}}, {'equals': [1, 2]}]}, 'then': 'yes', 'else': 'no'}, rec), 'no')
        self.assertEqual(self.ev({'first_set': [{'path': 'b'}, {'path': 'a'}, {'fail': 'never reached'}]}, rec), 'x')
        with self.assertRaisesRegex(ValueError, 'reached x'):
            self.ev({'first_set': [{'path': 'b'}, {'fail': 'reached {a}'}]}, rec)
        with self.assertRaisesRegex(ValueError, 'is not one of set'):
            self.ev({'if': {'sometimes': 1}, 'then': 1}, rec)

    def test_split_list_joined_cut_pairs_object_and_slug(self):
        self.assertEqual(self.ev({'split': {'of': 'a, b ,,c', 'sep': ','}}), ['a', 'b', 'c'])
        self.assertEqual(self.ev({'split': {'of': ['kept']}}), ['kept'])
        self.assertEqual(self.ev({'list': ['a', {'path': 'gone'}, ['b', ''], 'a'], 'flatten': True, 'unique': True, 'limit': 2}), ['a', 'b'])
        self.assertEqual(self.ev({'joined': {'of': ['a', 1], 'sep': '+'}}), 'a+1')
        self.assertEqual(self.ev({'cut': {'of': 'abcdef', 'max': 3}}), 'abc')
        self.assertEqual(self.ev({'json': {'path': 'm'}}, {'m': {'k': [1, {'é': 'v'}]}}), '{"k":[1,{"é":"v"}]}')
        self.assertIsNone(self.ev({'json': {'path': 'none'}}))
        self.assertIsNone(self.ev({'json': []}))
        self.assertEqual(self.ev({'pairs': {'of': {'path': 'm'}, 'template': '{key}={value}'}}, {'m': {'k': 'v'}}), ['k=v'])
        self.assertEqual(self.ev({'object': {'x': {'path': 'a'}, 'y': {'path': 'none'}}}, {'a': 1}), {'x': 1})
        self.assertEqual(self.ev({'slug': {'of': 'Hello, World -- 2!', 'max': 8}}), 'hello-wo')

    def test_text_fills_missing_fields_as_empty_and_leaves_no_stripping(self):
        self.assertEqual(self.ev({'text': ' [{a}] {b}.'}, {'a': 'x'}), ' [x] .')

    def test_lookup_row_of_and_count_links_read_tables_rows_and_records(self):
        recs = {'stores': [{'id': 's1', 'overrides': {'g1': 'u'}}]}
        rows = {'goods': [{'id': 'g1', 'values': {'store': ['s1']}}, {'id': 'g2', 'values': {'store': ['s1', 's2']}}]}
        self.assertEqual(self.ev({'lookup': {'table': {'row_of': {'list': 'stores', 'id': 's1', 'get': 'overrides'}}, 'key': 'g1'}}, recs=recs), 'u')
        self.assertIsNone(self.ev({'lookup': {'table': {'path': 'nothing'}, 'key': 'g1'}}))
        self.assertEqual(self.ev({'count_links': {'list': 'goods', 'field': 'store'}}, {'id': 's1'}, rows=rows), 2)
        self.assertEqual(self.ev({'count_links': {'list': 'goods', 'field': 'store'}}, {'id': 's2'}, rows=rows), 1)

    def test_require_and_ref_label(self):
        self.assertEqual(self.ev({'require': {'of': ['a'], 'texts': True, 'error': 'bad {id}'}}, {'id': 1}), ['a'])
        for bad in ([], [''], 'text', None, [1]):
            with self.assertRaisesRegex(ValueError, 'bad 1'):
                self.ev({'require': {'of': bad, 'texts': True, 'error': 'bad {id}'}}, {'id': 1})
        ref = {'const': {'root': 'a', 'path': 'p.md'}}
        self.assertEqual(self.ev({'ref_label': {'of': ref, 'templates': {'a': 'A/{path}'}, 'default': '{root} {path}'}}), 'A/p.md')
        self.assertEqual(self.ev({'ref_label': {'of': {'const': {'root': 'b', 'path': 'q'}}, 'templates': {'a': 'A/{path}'}, 'default': '{root} {path}'}}), 'b q')

    def test_every_transform_of_the_row_mapping_still_works_here(self):
        self.assertEqual(self.ev({'number': 'n'}, {'n': '1,200'}), 1200)
        self.assertEqual(self.ev({'date8': 'd'}, {'d': '20260102'}), '2026-01-02')
        self.assertEqual(self.ev({'const': 'k'}), 'k')


class Command(Pantry):
    def test_the_command_writes_the_payload_and_names_what_it_could_not_read(self):
        out_file = self.tmp / 'payload.json'
        argv = ['--mapping', str(self.root / 'mapping.json'), '--root', f'data={self.root}', '--out', str(out_file)]
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(cli.main(argv), 0)
            with self.assertRaises(SystemExit):
                cli.main(argv + ['--root', 'broken'])
            self.assertEqual(cli.main(['--mapping', str(self.root / 'mapping.json'), '--out', str(self.tmp / 'y.json')]), 2)
        self.assertEqual(json.loads(out.getvalue().splitlines()[0])['records'], 14)
        payload = json.loads(out_file.read_text())
        self.assertEqual(len(payload['commands']), 5)
        self.assertEqual(payload['commands'][0]['input']['records'][0]['id'], 'list:stores')
        self.assertIn('No folder was given for root data', err.getvalue())


if __name__ == '__main__':
    unittest.main()

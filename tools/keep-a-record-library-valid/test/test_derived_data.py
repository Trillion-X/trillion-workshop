"""Tests for the builders a schema declares for files derived from sources, on a made-up garden library built in a temporary folder.
Run: python3 -I -m unittest discover -s tools/keep-a-record-library-valid/test -v   (or npm test)"""
from __future__ import annotations

import io
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import checks  # noqa: E402
import derived_data  # noqa: E402
import keep_a_record_library as cli  # noqa: E402
from library import Store  # noqa: E402

PLANTS = """# Plants

## Herbs
- Basil | 3 | sun; warm
- Mint | 12 | 

## Roots
- Carrot | 7 | deep soil

## Questions
| Basil |
| Carrot |
| Rhubarb |
"""

SCHEMA = {
    'scope': 'Made-up garden library.',
    'builders': [
        {'name': 'plants', 'kind': 'markdown-rows', 'output': 'derived/plants.json', 'source': 'plants.md',
         'group_heading': '## ', 'row_prefix': '- ', 'unreadable': 'Rows not readable at lines {lines}',
         'row_regex': r'^- (?P<name>[^|]+?) \| (?P<n>\d+) \| (?P<tags>.*?)$',
         'id': {'field': 'id', 'prefix': 'P-', 'width': 2},
         'fields': {'plant': {'from': 'name'}, 'count': {'from': 'n', 'as': 'int'}, 'tags': {'from': 'tags', 'split': ';'},
                    'group': {'heading': True}, 'origin': {'const': 'plants.md'}},
         'document': {'note': 'Parsed from the plants file.', 'source': {'from': 'source_path'}, 'count': {'from': 'count'}, 'plants': {'from': 'rows'}}},
        {'name': 'cards', 'kind': 'cross-cards', 'output': 'derived/cards.json', 'source': 'plants.md',
         'names': {'section': '## Questions', 'row_regex': r'^\| (.+?) \|$', 'group': 1},
         'items_from': 'plants', 'item_key': 'plant', 'templates': {'file': 'lenses.json', 'path': 'lenses'},
         'card': {'id': {'id': {'prefix': 'C-', 'width': 3}}, 'kind': {'const': 'card'}, 'plant': {'item': 'plant'},
                  'text': {'lens': 'text', 'fill': '{plant}'}},
         'document': {'count': {'from': 'count'}, 'names': {'from': 'names'}, 'missing': {'from': 'missing'}, 'cards': {'from': 'rows'}}},
        {'name': 'beds', 'kind': 'folder-table', 'output': 'derived/beds.tsv', 'root': 'beds', 'family_file': 'FAMILY',
         'outputs': [{'name': 'NOTES.md', 'column': 'has_notes'}, {'name': 'frost', 'column': 'has_frost', 'dir': True}],
         'header_start': ['path', 'owner'], 'header_end': ['family', 'score']},
        {'name': 'readings', 'kind': 'sqlite-rows', 'output': 'derived/readings.json', 'input': 'sensor_db', 'table': 'readings',
         'fields': ['bed', 'wet'], 'document': {'database': {'from': 'database'}, 'count': {'from': 'count'}, 'readings': {'from': 'rows'}}},
        {'name': 'tasks', 'kind': 'json-to-tsv', 'output': 'derived/tasks.tsv', 'source': 'tasks.json', 'path': 'tasks',
         'columns': ['title', {'name': 'who', 'default': 'anyone'}]},
    ],
}


def run_cli(root, *argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        status = cli.main(['--library', str(root), '--schema', str(root / 'schema.json'), *argv])
    return status, out.getvalue(), err.getvalue()


class Builders(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='derived-data-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'garden'
        (self.root / 'beds' / 'herb-bed' / 'spring' / 'frost').mkdir(parents=True)
        (self.root / 'beds' / 'herb-bed' / 'spring' / 'NOTES.md').write_text('notes\n')
        (self.root / 'beds' / 'herb-bed' / 'FAMILY').write_text('x')
        (self.root / 'beds' / 'orchard' / 'summer').mkdir(parents=True)
        (self.root / 'plants.md').write_text(PLANTS)
        (self.root / 'lenses.json').write_text(json.dumps({'lenses': [{'text': 'Where does {plant} grow best?'}, {'text': 'When is {plant} picked?'}]}))
        (self.root / 'tasks.json').write_text(json.dumps({'tasks': [{'title': 'water', 'who': 'Ana'}, {'title': 'weed'}]}))
        (self.root / 'schema.json').write_text(json.dumps(SCHEMA))
        self.db = self.tmp / 'sensors.sqlite'
        with sqlite3.connect(self.db) as conn:
            conn.execute('CREATE TABLE readings (bed TEXT, wet INTEGER, extra TEXT)')
            conn.executemany('INSERT INTO readings VALUES (?, ?, ?)', [('herb-bed', 40, 'a'), ('orchard', None, 'b')])
        self.store = Store(self.root, self.root / 'schema.json')
        self.inputs = {'sensor_db': self.db}
        self.has_sqlite3 = shutil.which('sqlite3') is not None

    def built(self, inputs=None):
        return derived_data.build_all(self.store, self.inputs if inputs is None else inputs)

    def test_each_kind_builds_what_its_sources_say(self):
        if not self.has_sqlite3:
            self.skipTest('the sqlite3 command reads the database')
        out, not_checked = self.built()
        self.assertEqual(not_checked, [])
        plants = json.loads(out['derived/plants.json'])
        self.assertEqual(plants['count'], 3)
        self.assertEqual(plants['plants'][0], {'id': 'P-01', 'plant': 'Basil', 'count': 3, 'tags': ['sun', 'warm'], 'group': 'Herbs', 'origin': 'plants.md'})
        self.assertEqual(plants['plants'][1]['tags'], [])
        self.assertEqual(plants['plants'][2]['group'], 'Roots')
        cards = json.loads(out['derived/cards.json'])
        self.assertEqual((cards['count'], cards['missing']), (4, ['Rhubarb']))
        self.assertEqual(cards['cards'][1]['text'], 'When is Basil picked?')
        self.assertEqual(cards['cards'][3]['id'], 'C-004')
        self.assertEqual(out['derived/beds.tsv'].split('\r\n')[:3], [
            'path\towner\thas_notes\thas_frost\tfamily\tscore',
            'herb-bed/spring\therb-bed\tTrue\tTrue\tTrue\t2',
            'orchard/summer\torchard\tFalse\tFalse\tFalse\t0'])
        readings = json.loads(out['derived/readings.json'])
        self.assertEqual(readings['readings'], [{'bed': 'herb-bed', 'wet': 40}, {'bed': 'orchard', 'wet': None}])
        self.assertEqual(out['derived/tasks.tsv'], 'title\twho\r\nwater\tAna\r\nweed\tanyone\r\n')

    def test_json_documents_use_the_default_format_and_a_format_row_changes_it(self):
        out, _ = self.built({})
        self.assertFalse(out['derived/plants.json'].endswith('\n'))
        self.assertIn('\n "note": "Parsed from the plants file."', out['derived/plants.json'])
        schema = json.loads(json.dumps(SCHEMA))
        schema['builders'][0]['format'] = {'json': {'indent': 2, 'trailing_newline': True}}
        (self.root / 'schema.json').write_text(json.dumps(schema))
        changed, _ = derived_data.build_all(Store(self.root, self.root / 'schema.json'), {})
        self.assertTrue(changed['derived/plants.json'].endswith('}\n'))
        self.assertIn('\n  "note"', changed['derived/plants.json'])

    def test_a_library_named_by_a_relative_path_builds_the_same_bytes(self):
        import os
        before = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, before)
        relative = Store(Path('garden'), Path('garden') / 'schema.json')
        self.assertTrue(relative.root.is_absolute())
        self.assertEqual(derived_data.build_all(relative, {})[0], self.built({})[0])

    def test_a_builder_whose_input_is_not_given_is_left_out_and_named(self):
        out, not_checked = self.built({})
        self.assertNotIn('derived/readings.json', out)
        self.assertEqual(not_checked, ['derived/readings.json'])
        self.assertIn('derived/plants.json', out)

    def test_an_unreadable_row_is_refused_with_its_line_number(self):
        (self.root / 'plants.md').write_text(PLANTS.replace('- Mint | 12 | ', '- Mint | many |'))
        with self.assertRaisesRegex(ValueError, r'Rows not readable at lines \[5\]'):
            self.built({})

    def test_an_unknown_kind_is_refused_by_name(self):
        (self.root / 'schema.json').write_text(json.dumps({'builders': [{'name': 'x', 'kind': 'magic', 'output': 'x'}]}))
        with self.assertRaisesRegex(ValueError, 'kind magic is not one of'):
            derived_data.build_all(Store(self.root, self.root / 'schema.json'), {})

    def test_rebuild_writes_then_check_passes_then_an_edit_makes_a_file_stale(self):
        if not self.has_sqlite3:
            self.skipTest('the sqlite3 command reads the database')
        given = ['--input', f'sensor_db={self.db}']
        status, out, err = run_cli(self.root, *given, 'rebuild-data', '--check')
        self.assertEqual(status, 1, err)
        self.assertEqual(len(json.loads(out)['stale']), 5)
        status, out, err = run_cli(self.root, *given, 'rebuild-data')
        self.assertEqual(status, 0, err)
        self.assertTrue((self.root / 'derived' / 'tasks.tsv').is_file())
        self.assertFalse(list((self.root / 'derived').glob('*.tmp')))
        status, out, err = run_cli(self.root, *given, 'rebuild-data', '--check')
        self.assertEqual((status, json.loads(out)['all_passed']), (0, True), err)
        (self.root / 'tasks.json').write_text(json.dumps({'tasks': [{'title': 'prune'}]}))
        status, out, err = run_cli(self.root, *given, 'rebuild-data', '--check')
        self.assertEqual((status, json.loads(out)['stale']), (1, ['derived/tasks.tsv']), err)

    def test_check_with_a_missing_input_names_what_it_could_not_check(self):
        status, out, err = run_cli(self.root, 'rebuild-data', '--check')
        self.assertEqual(status, 1, err)
        self.assertEqual(json.loads(out)['not_checked'], ['derived/readings.json'])

    def test_rebuild_into_another_folder_leaves_the_library_alone(self):
        target = self.tmp / 'elsewhere'
        status, out, err = run_cli(self.root, 'rebuild-data', '--out', str(target))
        self.assertEqual(status, 0, err)
        self.assertTrue((target / 'derived' / 'plants.json').is_file())
        self.assertFalse((self.root / 'derived').exists())

    def test_validate_reports_stale_builder_output_with_the_derived_files(self):
        schema = {'scope': 'x', 'pools': {}, 'checks': [], 'builders': SCHEMA['builders'][-1:]}
        (self.root / 'schema.json').write_text(json.dumps(schema))
        store = Store(self.root, self.root / 'schema.json')
        report = checks.validate(store)
        self.assertFalse(report['all_passed'])
        self.assertEqual(report['stale_derived_files'], ['derived/tasks.tsv'])
        derived_data.write_all(self.root, derived_data.build_all(store, {})[0])
        self.assertTrue(checks.validate(store)['all_passed'])


if __name__ == '__main__':
    unittest.main()

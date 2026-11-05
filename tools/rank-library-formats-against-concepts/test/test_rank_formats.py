"""Tests for do-work/rank_formats.py on a made-up library, bank, concept files and judged files."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'do-work' / 'rank_formats.py'
sys.path.insert(0, str(SCRIPT.parent))
import rank_formats as rf  # noqa: E402

INDEX = """# Library

## All items

| creator | item | format type | medium & aspect | length s | cuts/min | wpm | views | likes | bookmarks | one-line premise | link to folder |
|---|---|---|---|---|---|---|---|---|---|---|---|
| alpha | A tour of a workshop | launch film | video 16:9 | 81.3 | 4 | 188 | 1,000 | 10 | 2 | "Show the place." | [folder](formats/alpha/alpha-001/) |
| beta | Ten slides on one idea | slideshow / carousel | carousel + screen video 4:5 | 50 | 15 | 200 | 5,000 | 85 | 141 | "One idea, ten slides." | [folder](formats/beta/beta-002/) |
| gamma | Notes on a thing | long-form X article | text | 0 | ? | ? | 7 | 1 | 1 | "Write it down." | [folder](formats/gamma/gamma-003/) |
| delta | Points elsewhere | see alpha | video | 1 | 1 | 1 | 1 | 1 | 1 | "x" | [folder](formats/alpha/alpha-001/) |
| epsilon | No folder link | launch film | video | 1 | 1 | 1 | 1 | 1 | 1 | "x" | none |

## Other
| creator | item | format type | medium & aspect | length s | cuts/min | wpm | views | likes | bookmarks | one-line premise | link to folder |
| zeta | Not in all items | launch film | video | 1 | 1 | 1 | 1 | 1 | 1 | "x" | [folder](formats/zeta/zeta-004/) |
"""
FORMAT_MD = "# alpha-001\n\n**What it is.** A short tour of a place,\nshown by walking through it.\n\nMore text.\n"
BANK = """| id | name | pattern | a | b | c | d | e |
|---|---|---|---|---|---|---|---|
| 8 | forms | [N] days of [X] (tested) | 1 | 2 | 3 | 4 | 5 |
| 9 | not a form | [N] days of [X] (tested) | 1 | 2 | 3 | 4 | 5 |
| 10 | no paren | a question headline | 1 | 2 | 3 | 4 | 5 |
"""
CONCEPTS_A = """# Group A

## A01 | (Strong) First idea

| beat | where |
|---|---|
| HOOK: opening line | local clip one |
| Q: a question | B2 pulled |
| plain beat | drive only |

## B02 | Second idea
| concept | beat |
| B02 | HOOK: only beat | local |
"""
PACKAGE = "id,domain,viewer_gets,proof_needed\nV13,Package idea,what they get,what proves it\nV99,Not wanted,x,y\n"
SETTINGS = {
    'form_templates': {'8': ['[N] days of [X]', 'a long period, shown over time']},
    'stable_keys': {'alpha-001': 'tour'},
    'own_formats': [{'key': 'own_one', 'type': 'own', 'medium': 'long video', 'creator': 'someone', 'stats': 'their template',
                     'path': 'no library item', 'text': 'their long structure'}],
    'skip_concepts': ['B02'],
    'empty_options': ['B02'],
    'package_ids': ['V13'],
    'form_template_path': 'bank.md template {id}',
    'about_template': 'read {candidates} candidates ({library_items} library, {forms} forms, {own} own)',
}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='rank-formats-'))
        lib = self.tmp / 'library'
        (lib / 'formats' / 'alpha' / 'alpha-001').mkdir(parents=True)
        (lib / 'INDEX.md').write_text(INDEX)
        (lib / 'formats' / 'alpha' / 'alpha-001' / 'FORMAT.md').write_text(FORMAT_MD)
        (self.tmp / 'bank.md').write_text(BANK)
        (self.tmp / 'A.md').write_text(CONCEPTS_A)
        (self.tmp / 'package.csv').write_text(PACKAGE)
        (self.tmp / 'settings.json').write_text(json.dumps(SETTINGS))
        (self.tmp / 'titles.json').write_text(json.dumps({'titles': [], 'format_chosen': {'plan-1': ['beta-002']}}))
        self.base = {'library': str(lib), 'bank': str(self.tmp / 'bank.md'), 'package': str(self.tmp / 'package.csv'),
                     'concepts': {'files': [str(self.tmp / 'A.md')]}, 'settings': SETTINGS}

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cli(self, request, *extra):
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), *extra], input=json.dumps(request), capture_output=True, text=True)
        return done, json.loads(done.stdout.strip().split('\n')[-1])


class Readers(Fixture):
    def configured(self, **over):
        rf.configure({**self.base, 'step': 'catalog', **over})

    def test_library_candidates_follow_the_all_items_table_only_and_skip_pointers_and_rows_with_no_folder(self):
        self.configured(bank=None, settings={**SETTINGS, 'own_formats': []})
        self.assertEqual([c['key'] for c in rf.candidates()], ['tour', 'beta-002', 'gamma-003'])

    def test_a_candidate_row_has_its_type_medium_stats_path_and_what_it_is(self):
        self.configured(bank=None, settings={**SETTINGS, 'own_formats': []})
        first, second, third = rf.candidates()
        self.assertEqual((first['type'], first['medium']), ('launch film', 'short'))
        self.assertEqual(first['stats'], '81.3 s, 1,000 views, 10 likes, 2 bookmarks')
        self.assertEqual(first['path'], 'library/formats/alpha/alpha-001/')
        self.assertEqual(first['text'], 'A tour of a workshop: A short tour of a place, shown by walking through it.')
        self.assertEqual(second['medium'], 'carousel')
        self.assertEqual(third['medium'], 'write-up')
        self.assertEqual(second['text'], 'Ten slides on one idea: "One idea, ten slides."')

    def test_only_listed_title_templates_that_name_a_form_are_candidates(self):
        self.configured()
        rows = [r for r in rf.candidates() if r['key'].startswith('title_template_')]
        self.assertEqual([r['key'] for r in rows], ['title_template_8'])
        self.assertEqual(rows[0]['stats'], '[N] days of [X] (tested) outliers')
        self.assertEqual(rows[0]['path'], 'bank.md template 8')
        self.assertEqual(rows[0]['text'], '[N] days of [X]: a long period, shown over time')

    def test_concepts_read_headings_beats_and_where_the_footage_is_and_apply_skips_and_package_ids(self):
        self.configured()
        found = rf.concepts()
        self.assertEqual(sorted(found), ['A01', 'V13'])
        self.assertEqual(found['A01']['title'], 'First idea')
        self.assertEqual(found['A01']['beats'], ['opening line', 'a question', 'plain beat'])
        self.assertEqual((found['A01']['n'], found['A01']['local'], found['A01']['b2']), (3, 1, 1))
        self.assertEqual(found['V13']['beats'], ['what they get', 'what proves it'])

    def test_medium_of_reads_kind_and_aspect(self):
        self.assertEqual(rf.medium_of('multi-panel grid', 'x'), 'post')
        self.assertEqual(rf.medium_of('talk', 'Long video 16:9'), 'long video')
        self.assertEqual(rf.medium_of('loop', 'web loop'), 'web loop')


class Steps(Fixture):
    def test_catalog_prints_f_lines_then_c_lines_sorted_by_id_and_one_result(self):
        done, answer = self.cli(dict(self.base, step='catalog'))
        self.assertEqual(done.returncode, 0, done.stdout)
        lines = done.stdout.strip().split('\n')[:-1]
        self.assertEqual([l.split('\t')[0] for l in lines], ['F'] * 5 + ['C'] * 2)
        self.assertEqual([l.split('\t')[1] for l in lines], ['tour', 'beta-002', 'gamma-003', 'title_template_8', 'own_one', 'A01', 'V13'])
        self.assertEqual(answer['result']['candidates'], 5)

    def judged(self, name, rows):
        path = self.tmp / name
        path.write_text(json.dumps(rows))
        return str(path)

    def test_apply_writes_options_palette_and_about_and_keeps_the_rest_of_the_file(self):
        good = self.judged('j.json', {'A01': [{'format': 'tour', 'fit': 'why one'}, {'format': 'own_one', 'fit': 'why two', 'material': 'special'}],
                                      'V13': [{'format': 'beta-002', 'fit': 'why three'}]})
        done, answer = self.cli(dict(self.base, step='apply', titles=str(self.tmp / 'titles.json'), judged=[good]))
        self.assertEqual(done.returncode, 0, done.stdout)
        doc = json.loads((self.tmp / 'titles.json').read_text())
        self.assertEqual(doc['format_chosen'], {'plan-1': ['beta-002']})
        self.assertEqual(doc['format_options']['B02'], [])
        first = doc['format_options']['A01'][0]
        self.assertEqual((first['type'], first['medium'], first['path'], first['fit']), ('launch film', 'short', 'library/formats/alpha/alpha-001/', 'why one'))
        self.assertEqual((first['moments_fit'], first['moments_local'], first['moments_b2'], first['moments_drive']), (3, 1, 1, 1))
        self.assertEqual(doc['format_options']['A01'][1]['material'], 'special')
        self.assertEqual(doc['format_options']['A01'][0]['material'], rf.DEFAULTS['default_material'])
        self.assertEqual(sorted(doc['format_palette']), ['beta-002', 'own_one', 'tour'])
        self.assertEqual(doc['format_ranking_about'], 'read 5 candidates (3 library, 1 forms, 1 own)')
        self.assertEqual(answer['result']['concepts'], 2)

    def test_apply_refuses_a_key_the_catalog_does_not_hold_and_leaves_the_file_unchanged(self):
        before = (self.tmp / 'titles.json').read_text()
        bad = self.judged('bad.json', {'A01': [{'format': 'nope', 'fit': 'x'}], 'V13': [{'format': 'tour', 'fit': 'y'}]})
        done, answer = self.cli(dict(self.base, step='apply', titles=str(self.tmp / 'titles.json'), judged=[bad]))
        self.assertEqual(done.returncode, 1)
        self.assertIn("keys not in the catalog: ['nope']", answer['error'])
        self.assertEqual((self.tmp / 'titles.json').read_text(), before)

    def test_apply_refuses_a_concept_nobody_judged(self):
        short = self.judged('short.json', {'A01': [{'format': 'tour', 'fit': 'x'}]})
        done, answer = self.cli(dict(self.base, step='apply', titles=str(self.tmp / 'titles.json'), judged=[short]))
        self.assertEqual(done.returncode, 1)
        self.assertIn("concepts not judged: ['V13']", answer['error'])

    def test_judged_files_are_laid_over_each_other_in_order(self):
        one = self.judged('one.json', {'A01': [{'format': 'tour', 'fit': 'first'}], 'V13': [{'format': 'tour', 'fit': 'v'}]})
        two = self.judged('two.json', {'A01': [{'format': 'own_one', 'fit': 'second'}]})
        done, _ = self.cli(dict(self.base, step='apply', titles=str(self.tmp / 'titles.json'), judged=[one, two]))
        self.assertEqual(done.returncode, 0, done.stdout)
        doc = json.loads((self.tmp / 'titles.json').read_text())
        self.assertEqual([o['fit'] for o in doc['format_options']['A01']], ['second'])


class Refusals(Fixture):
    def test_a_missing_step_or_library_says_what_to_give(self):
        done, answer = self.cli({'library': str(self.tmp / 'library')})
        self.assertIn('step is "catalog"', answer['error'])
        done, answer = self.cli({'step': 'catalog', 'concepts': {'files': []}})
        self.assertIn('give library', answer['error'])
        done, answer = self.cli({'step': 'catalog', 'library': str(self.tmp / 'nowhere')})
        self.assertIn('no library index', answer['error'])
        done, answer = self.cli({'step': 'catalog', 'library': str(self.tmp / 'library')})
        self.assertIn('give concepts.files', answer['error'])
        done, answer = self.cli(dict(self.base, step='apply'))
        self.assertIn('titles is required', answer['error'])


class RequestShape(Fixture):
    def test_relative_paths_are_read_and_written_in_the_granted_folder(self):
        rel = {'step': 'apply', 'library': 'library', 'bank': 'bank.md', 'package': 'package.csv', 'concepts': {'files': ['A.md']},
               'titles': 'titles.json', 'judged': ['j.json'],
               'settings': SETTINGS, 'settings_from': {'id': 'record:setting:rank-library-formats-against-concepts~film~sample', 'from': 'made up'}}
        (self.tmp / 'j.json').write_text(json.dumps({'A01': [{'format': 'tour', 'fit': 'f'}], 'V13': [{'format': 'own_one', 'fit': 'g'}]}))
        done, answer = self.cli(rel, '--base', str(self.tmp))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(answer['result']['concepts'], 2)
        self.assertEqual(answer['result']['settings_from']['from'], 'made up')
        self.assertIn('tour', json.loads((self.tmp / 'titles.json').read_text())['format_palette'])

    def test_a_settings_file_is_refused_with_where_settings_live_now(self):
        done, answer = self.cli(dict(self.base, step='catalog', settings_file='settings.json'))
        self.assertEqual(done.returncode, 1)
        self.assertIn('settings_record', answer['error'])

    def test_settings_lay_over_the_defaults_key_by_key(self):
        settings = rf.load_settings({'settings': {'default_material': 'their words'}})
        self.assertEqual(settings['default_material'], 'their words')
        self.assertEqual(settings['empty_options'], [])
        self.assertEqual(rf.load_settings({})['form_templates'], {})

    def test_a_request_that_is_not_an_object_is_refused(self):
        done, answer = self.cli(['catalog'])
        self.assertEqual(done.returncode, 1)
        self.assertIn('JSON object', answer['error'])


def record(folder, settings, status='active'):
    """A row as run-with-settings.mjs hands it in: {id, type, value}, settings as the compact JSON text make_record writes."""
    return {'id': f'record:setting:{folder}~film~sample-film', 'type': 'record:setting',
            'value': {'name': 'made up', 'tool': f'tool:{folder}', 'scope_kind': 'film', 'scope_id': 'sample-film',
                      'settings': json.dumps(settings, sort_keys=True, separators=(',', ':')), 'from': 'made up', 'status': status}}


class SettingsRecord(unittest.TestCase):
    def test_the_record_is_laid_over_the_defaults_and_a_retired_record_is_refused(self):
        settings = rf.load_settings({'settings_record': record('rank-library-formats-against-concepts', SETTINGS), 'settings': {'default_material': 'x'}})
        self.assertEqual(settings['stable_keys'], {'alpha-001': 'tour'})
        self.assertEqual(settings['default_material'], 'x')
        with self.assertRaisesRegex(ValueError, 'retired'):
            rf.load_settings({'settings_record': record('rank-library-formats-against-concepts', SETTINGS, 'retired')})


if __name__ == '__main__':
    unittest.main()

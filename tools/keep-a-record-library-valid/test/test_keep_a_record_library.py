"""Stdlib tests for keep-a-record-library-valid, on a made-up greenhouse library (test/fixtures/greenhouse) copied to a temporary folder.
Run: python3 -I -m unittest discover -s tools/keep-a-record-library-valid/test -v   (or npm test)"""
from __future__ import annotations

import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'greenhouse'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import checks  # noqa: E402
import investigation  # noqa: E402
import keep_a_record_library as cli  # noqa: E402
import routes  # noqa: E402
from library import Store, at_path  # noqa: E402

HAS_BLAKE3 = importlib.util.find_spec('blake3') is not None or shutil.which('b3sum') is not None
needs_blake3 = unittest.skipUnless(HAS_BLAKE3, 'a file identity is BLAKE3: install the blake3 python module or the b3sum command')


def run_cli(root, *argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        status = cli.main(['--library', str(root), '--schema', str(root / 'schema.json'), *argv])
    return status, out.getvalue(), err.getvalue()


class Library(unittest.TestCase):
    """A fresh copy of the made-up library."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='record-library-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'greenhouse'
        shutil.copytree(FIXTURE, self.root)
        self.store = Store(self.root, self.root / 'schema.json')
        self.piece = self.root / 'beds' / 'herb-bed'
        (self.piece / 'LOG.md').write_text('log v1\n')

    def started(self, piece=None, **kw):
        return investigation.start(self.store, piece or self.piece, kw.pop('profile', 'spring-planting'), **kw)

    def close_scope(self):
        investigation.record_evidence(self.store, self.piece, 'orient', 'executed', [str(self.piece / 'NOTES.md')], 'header read')

    def record(self):
        return json.loads((self.piece / 'investigation.json').read_text())

    def edit(self, relative, change):
        path = self.root / relative
        document = json.loads(path.read_text())
        change(document)
        path.write_text(json.dumps(document))
        self.store = Store(self.root, self.root / 'schema.json')

    def report(self):
        return checks.validate(self.store)


class PathsAndPools(Library):
    def test_a_path_names_records_in_a_loaded_document(self):
        document = {'a': {'b': [1, 2]}, 'c': [{'d': [{'e': 1}, {'e': 2}]}, {'d': [{'e': 3}]}]}
        self.assertEqual(at_path(document, 'a.b'), [1, 2])
        self.assertEqual(at_path(document, 'c[].d'), [{'e': 1}, {'e': 2}, {'e': 3}])
        self.assertEqual(at_path(document, 'c[].d[].e'), [1, 2, 3])
        self.assertEqual(at_path([{'e': 1}], ''), [{'e': 1}])

    def test_pools_read_their_ids_through_the_schema(self):
        self.assertEqual(self.store.ids('chores'), ['W1.1', 'W1.2', 'W2.1'])
        self.assertEqual(self.store.ids('findings'), [])
        with self.assertRaisesRegex(KeyError, 'no pool named nothing'):
            self.store.pool('nothing')


class HeaderAndRoutes(Library):
    def test_header_parsed_with_continuation_lines_and_any_heading_level(self):
        h = routes.parse_header(self.piece / 'NOTES.md', 'Bed header')
        self.assertEqual(h['kind'], 'herb')
        self.assertEqual(h['shape'], 'raised (two boards)')
        self.assertEqual(routes.parse_header(self.piece / 'NOTES.md', 'No such heading'), {})
        (self.piece / 'NOTES.md').write_text('### Bed header\n```\nsize: 2 m\n      plus a path\n```\n')
        self.assertEqual(routes.parse_header(self.piece / 'NOTES.md', 'Bed header'), {'size': '2 m plus a path'})

    def test_tags_drop_comments_and_add_implied_tags(self):
        tags = routes.header_tags(routes.parse_header(self.piece / 'NOTES.md', 'Bed header'), self.store.investigation)
        self.assertEqual(tags, {'herb', 'outdoor', 'shade:part', 'shade', 'raised', 'mulch', 'trellis'})

    def test_route_grammar(self):
        t = {'herb', 'outdoor', 'sun'}
        self.assertTrue(routes.route_applies('all', t))
        self.assertTrue(routes.route_applies('root, herb', t))
        self.assertTrue(routes.route_applies('herb + outdoor (not indoor)', t))
        self.assertFalse(routes.route_applies('herb + outdoor (not indoor)', t | {'indoor'}))
        self.assertFalse(routes.route_applies('all (not sun)', t))
        self.assertFalse(routes.route_applies('herb + root', t))
        self.assertEqual(routes.route_tags('herb + outdoor (not indoor)'), ['herb', 'outdoor', 'indoor'])


class Start(Library):
    def test_start_selects_a_routed_set_without_duplicates(self):
        out = self.started()
        inv = self.record()
        bank = self.store.by_id('questions')
        ids = inv['selection']['selected']
        self.assertEqual(len(ids), len(out['selected']))
        self.assertTrue(all(not bank[i].get('same_as') for i in ids))
        self.assertEqual(inv['nodes'][0]['id'], 'orient')
        self.assertEqual(inv['nodes'][0]['tools'], ['ls'])
        self.assertEqual([n['group'] for n in inv['nodes'][1:4]], ['GR-1', 'GR-2', 'GR-3'], 'breadth first across groups')
        self.assertEqual(inv['selection']['not_selected']['QN-008'], 'answered by W1.1 (same_as)')
        self.assertEqual(inv['selection']['not_selected']['QN-002'], 'stage orchard-only is not asked of a own target')
        self.assertEqual(inv['authority'], self.store.investigation['authority'])
        self.assertEqual(out['next'].split(' --q ')[1].split()[0], 'orient')

    def test_route_excludes_question(self):
        self.started(limit=99)
        self.assertIn('QN-004', self.record()['selection']['selected'])
        (self.piece / 'investigation.json').unlink()
        (self.piece / 'NOTES.md').write_text((self.piece / 'NOTES.md').read_text().replace('outdoor shade', 'outdoor indoor shade'))
        investigation.start(self.store, self.piece, 'spring-planting', limit=99)
        inv = self.record()
        self.assertNotIn('QN-004', inv['selection']['selected'])
        self.assertIn('routes', inv['selection']['not_selected']['QN-004'])

    def test_refuses_overwrite_unknown_profile_and_bad_limit(self):
        self.started()
        with self.assertRaisesRegex(ValueError, 'Refusing to overwrite'):
            self.started()
        (self.piece / 'investigation.json').unlink()
        with self.assertRaisesRegex(ValueError, 'Unknown run profile'):
            self.started(profile='nope')
        with self.assertRaisesRegex(ValueError, 'limit must be'):
            self.started(limit=100)

    def test_a_piece_under_a_target_kind_folder_is_asked_that_kinds_questions(self):
        piece = self.root / 'beds' / 'old-orchard' / 'spring'
        self.assertEqual(routes.target_kind(piece, self.store), 'orchard')
        self.assertEqual(routes.target_kind(self.piece, self.store), 'own')
        (piece / 'NOTES.md').write_text('## Bed header\n```\nplace: outdoor\n```\n')
        investigation.start(self.store, piece, 'spring-planting', limit=99)
        inv = json.loads((piece / 'investigation.json').read_text())
        self.assertEqual(inv['target_kind'], 'orchard')
        self.assertIn('QN-002', inv['selection']['selected'])


@needs_blake3
class NextAndEvidence(Library):
    def test_next_follows_prerequisites(self):
        self.started()
        self.assertEqual([r['id'] for r in investigation.next_open(self.store, self.piece)['ready']], ['orient'])
        self.close_scope()
        nxt = investigation.next_open(self.store, self.piece)
        closing = [n['id'] for n in self.record()['nodes'] if n['stage'] == 'review']
        self.assertTrue(closing)
        self.assertTrue(set(closing) <= set(nxt['waiting_ids']))
        self.assertFalse(set(closing) & {r['id'] for r in nxt['ready']})

    def test_refuses_missing_file_and_rule_breaks(self):
        self.started()
        notes = str(self.piece / 'NOTES.md')
        with self.assertRaisesRegex(ValueError, 'does not exist'):
            investigation.record_evidence(self.store, self.piece, 'orient', 'executed', [str(self.piece / 'nope.md')], 'x')
        with self.assertRaisesRegex(ValueError, 'requires --file'):
            investigation.record_evidence(self.store, self.piece, 'orient', 'executed', [], 'x')
        with self.assertRaisesRegex(ValueError, 'requires --note'):
            investigation.record_evidence(self.store, self.piece, 'orient', 'not-applicable', [], '')
        with self.assertRaisesRegex(ValueError, 'status must be'):
            investigation.record_evidence(self.store, self.piece, 'orient', 'passed', [notes], 'x')
        with self.assertRaisesRegex(ValueError, 'label must be one of Seen, Guessed'):
            investigation.record_evidence(self.store, self.piece, 'orient', 'executed', [notes], 'x', label='Fact')
        with self.assertRaisesRegex(ValueError, 'not selected'):
            investigation.record_evidence(self.store, self.piece, 'QN-008', 'executed', [notes], 'x')
        with self.assertRaisesRegex(ValueError, 'prerequisites'):
            investigation.record_evidence(self.store, self.piece, self.record()['nodes'][1]['id'], 'executed', [notes], 'x')
        with self.assertRaisesRegex(ValueError, 'unknown checks: W9.9'):
            investigation.record_evidence(self.store, self.piece, 'orient', 'executed', [notes], 'x', caught_by=['W9.9'])

    def test_stores_blake3_reuses_evidence_and_takes_the_first_label_by_default(self):
        self.started()
        self.close_scope()
        e = self.record()['evidence'][0]
        self.assertEqual(e['identity']['algorithm'], 'blake3')
        self.assertEqual(len(e['identity']['value']), 64)
        self.assertEqual(e['path'], 'NOTES.md')
        self.assertEqual(self.record()['nodes'][0]['label'], 'Seen')
        q = self.record()['nodes'][1]['id']
        investigation.record_evidence(self.store, self.piece, q, 'executed', [str(self.piece / 'NOTES.md')], 'same file', caught_by=['W1.1', 'none'])
        inv = self.record()
        self.assertEqual(len(inv['evidence']), 1)
        self.assertEqual(inv['nodes'][1]['evidence'], ['E1'])

    def test_append_continuation_preserves_evidence_and_retry_note(self):
        self.started()
        self.close_scope()
        q = self.record()['nodes'][1]['id']
        investigation.record_evidence(self.store, self.piece, q, 'executed', [str(self.piece / 'NOTES.md')], 'earlier source')
        args = ['evidence', str(self.piece), '--q', q, '--status', 'executed', '--file', str(self.piece / 'LOG.md'), '--note', 'new source check', '--append']
        for _ in range(2):  # an identical retry changes nothing
            self.assertEqual(run_cli(self.root, *args)[0], 0)
        node = next(n for n in self.record()['nodes'] if n['id'] == q)
        self.assertEqual(node['evidence'], ['E1', 'E2'])
        self.assertEqual(node['note'], 'earlier source\n\nnew source check')
        self.assertEqual(len(self.record()['evidence']), 2)
        # A revised file becomes the active reference; its previous identity remains historical.
        (self.piece / 'LOG.md').write_text('log revised\n')
        self.assertEqual(run_cli(self.root, *args)[0], 0)
        self.assertEqual(next(n for n in self.record()['nodes'] if n['id'] == q)['evidence'], ['E1', 'E3'])
        self.assertEqual(len(self.record()['evidence']), 3)
        self.assertNotIn(q, investigation.progress(self.store, self.piece)['answers_with_changed_or_missing_evidence'])
        # Source history stays attributable when a file changes later.
        (self.piece / 'NOTES.md').write_text((self.piece / 'NOTES.md').read_text() + '\nchanged\n')
        current = investigation.progress(self.store, self.piece)
        self.assertEqual(current['evidence']['changed'], 2)
        self.assertIn(q, current['answers_with_changed_or_missing_evidence'])
        # Default calls still replace the active answer's evidence.
        investigation.record_evidence(self.store, self.piece, q, 'executed', [str(self.piece / 'LOG.md')], 'replacement')
        self.assertEqual(next(n for n in self.record()['nodes'] if n['id'] == q)['evidence'], ['E3'])

    def test_progress_sees_changed_evidence_and_net_new(self):
        self.started()
        self.close_scope()
        q = self.record()['nodes'][1]['id']
        investigation.record_evidence(self.store, self.piece, q, 'executed', [str(self.piece / 'LOG.md')], 'found a gap', defect=True)
        p = investigation.progress(self.store, self.piece)
        self.assertEqual(p['evidence']['matches'], 2)
        self.assertEqual([d['id'] for d in p['defects']], [q])
        self.assertEqual(p['answered_not_caught_by_checklist'], [q])
        self.assertFalse(p['complete'])
        (self.piece / 'LOG.md').write_text('log v2\n')
        p = investigation.progress(self.store, self.piece)
        self.assertEqual(p['evidence']['changed'], 1)
        self.assertEqual(p['answers_with_changed_or_missing_evidence'], [q])

    def test_a_missing_or_changed_source_is_reported_not_crashed(self):
        self.started()
        self.assertEqual(run_cli(self.root, 'evidence', str(self.piece), '--q', 'orient', '--status', 'executed',
                                 '--file', str(self.piece / 'NOTES.md'), '--note', 'header read')[0], 0)
        record = self.record()
        record['evidence'][0]['extension_metadata'] = {'writer': 'compatible'}
        (self.piece / 'investigation.json').write_text(json.dumps(record))
        (self.piece / 'NOTES.md').write_text((self.piece / 'NOTES.md').read_text() + '\nchanged\n')
        self.assertEqual(run_cli(self.root, 'progress', str(self.piece))[0], 0)
        self.assertEqual(investigation.progress(self.store, self.piece)['evidence']['changed'], 1)
        (self.piece / 'NOTES.md').unlink()
        self.assertEqual(investigation.progress(self.store, self.piece)['evidence']['missing'], 1)

    def test_a_flat_append_is_diagnosed_by_validate_and_progress(self):
        self.started()
        record = self.record()
        record['evidence'] = {'E1': {'path': 'NOTES.md'}}
        (self.piece / 'investigation.json').write_text(json.dumps(record))
        status, out, _ = run_cli(self.root, 'validate')
        self.assertEqual(status, 1)
        problems = json.loads(out)['id_problems']['investigation_evidence_shape']
        self.assertIn('investigation evidence must be a list', problems[0])
        self.assertLess(problems[0].index('Preserve the malformed investigation'), problems[0].index('restore an authentic valid snapshot first'))
        status, _, err = run_cli(self.root, 'progress', str(self.piece))
        self.assertEqual(status, 2)
        self.assertIn('Invalid evidence record shape', err)
        record['evidence'] = [{'id': 'E1', 'path': 'NOTES.md'}]
        (self.piece / 'investigation.json').write_text(json.dumps(record))
        status, _, err = run_cli(self.root, 'progress', str(self.piece))
        self.assertEqual(status, 2)
        self.assertIn('Evidence E1 (NOTES.md): missing or invalid identity', err)
        self.assertNotIn('KeyError', err)


@needs_blake3
class Findings(Library):
    def test_findings_of_each_kind_land_in_both_places(self):
        self.started()
        self.close_scope()
        out = investigation.add_finding(self.store, self.piece, 'tip', 'Basil', {'what_helped': 'morning shade', 'why': 'leaves stay tender'}, 'orient', [])
        self.assertEqual(out['library_finding']['next_step'], 'known crop CR-001: add this bed to its notes')
        self.assertEqual(out['library_finding']['label'], 'Seen')
        out = investigation.add_finding(self.store, self.piece, 'tip', 'Sorrel', {'what_helped': 'a pot', 'why': 'roots stay in'}, None, ['E1'], 'Guessed')
        self.assertIn('new crop', out['library_finding']['next_step'])
        out = investigation.add_finding(self.store, self.piece, 'mistake', 'Planted too deep',
                                        {'assumed': 'a', 'saw': 'b', 'cause': 'c', 'rule': 'd'}, None, ['E1'])
        self.assertNotIn('next_step', out['library_finding'])
        self.assertEqual([f['id'] for f in json.loads(self.store.findings_path().read_text())], ['FN-0001', 'FN-0002', 'FN-0003'])
        self.assertEqual([f['library_id'] for f in self.record()['findings']], ['FN-0001', 'FN-0002', 'FN-0003'])
        with self.assertRaisesRegex(ValueError, 'finding kind must be one of tip, mistake'):
            investigation.add_finding(self.store, self.piece, 'device', 'x', {}, None, ['E1'])
        with self.assertRaisesRegex(ValueError, 'needs evidence'):
            investigation.add_finding(self.store, self.piece, 'tip', 'x', {'what_helped': 'a', 'why': 'b'}, None, [])
        with self.assertRaisesRegex(ValueError, 'needs: --field saw=..., --field cause=..., --field rule=...'):
            investigation.add_finding(self.store, self.piece, 'mistake', 'x', {'assumed': 'a'}, None, ['E1'])
        with self.assertRaisesRegex(ValueError, 'Evidence not recorded on this piece: E9'):
            investigation.add_finding(self.store, self.piece, 'mistake', 'x', {'assumed': 'a'}, None, ['E9'])

    def test_the_finding_command_takes_fields_as_name_value_pairs(self):
        self.started()
        self.close_scope()
        status, out, err = run_cli(self.root, 'finding', str(self.piece), '--kind', 'mistake', '--title', 'Too deep', '--q', 'orient',
                                   '--field', 'assumed=a', '--field', 'saw=b', '--field', 'cause=c', '--field', 'rule=d=e')
        self.assertEqual(status, 0, err)
        self.assertEqual(json.loads(out)['library_finding']['rule'], 'd=e')


class SearchFindings(Library):
    def set_findings(self, rows):
        self.store.findings_path().write_text(json.dumps(rows))

    def test_word_boundaries_do_not_rank_prefix_collisions(self):
        self.set_findings([
            {'id': 'matched', 'title': 'Editor handoff dialog', 'what_helped': 'A tall example passes through the confirmed handoff.'},
            {'id': 'prefix-only', 'title': 'Dialogue between taller editors', 'what_helped': 'A story shows a taller scene.'},
        ])
        self.assertEqual([r['id'] for r in routes.search_library(self.store, ['tall', 'dialog', 'handoff'])], ['matched'])

    def test_punctuation_multiword_plural_and_repeated_terms(self):
        self.set_findings([{'id': 'drawing', 'title': 'Hand-drawn marker diagram', 'what_helped': 'Ordered strokes and pauses remain visible.'}])
        result = routes.search_library(self.store, ['hand-drawn', 'diagrams', 'stroke', 'pause'])
        self.assertEqual(result, routes.search_library(self.store, ['hand-drawn', 'diagram,', 'diagrams', 'stroke', 'pause']))
        self.assertEqual([r['id'] for r in result], ['drawing'])

    def test_stable_ties_and_limit(self):
        self.set_findings([{'id': 'first', 'title': 'Persistent topic list'}, {'id': 'second', 'title': 'Persistent topic list'}])
        result = routes.search_library(self.store, ['persistent,', 'topic?', 'list.'])
        self.assertEqual([r['id'] for r in result], ['first', 'second'])
        self.assertEqual(routes.search_library(self.store, ['persistent', 'topic', 'list'], limit=1), result[:1])
        self.assertEqual(routes.search_library(self.store, ['persistent', 'topic', 'list'], limit=0), [])

    def test_short_alphanumeric_terms_match_case_insensitively(self):
        self.set_findings([{'id': 'ui', 'title': 'UI overlay'}, {'id': 'three-d', 'title': '3D model'}, {'id': 'prefixes', 'title': 'Building basics and 3-day routine'}])
        for query, expected in [('UI', 'ui'), ('ui', 'ui'), ('3D', 'three-d'), ('3d', 'three-d')]:
            with self.subTest(query=query):
                self.assertEqual([r['id'] for r in routes.search_library(self.store, [query])], [expected])

    def test_empty_and_zero_hit_queries_return_no_results(self):
        self.set_findings([{'id': 'entry', 'title': 'Persistent topic list'}])
        self.assertEqual(routes.search_library(self.store, []), [])
        self.assertEqual(routes.search_library(self.store, ['xylophonezz']), [])


class Validate(Library):
    def failing(self):
        return self.report()['id_problems']

    def test_the_made_up_library_is_valid_and_the_report_has_the_declared_shape(self):
        report = self.report()
        self.assertTrue(report['all_passed'], report['id_problems'])
        self.assertEqual(report['passed'], report['total'])
        self.assertEqual(list(report), ['all_passed', 'passed', 'total', 'checks', 'id_problems', 'readings', 'stale_derived_files', 'scope'])
        self.assertEqual(list(report['checks'])[:3], ['question_ids_unique', 'question_count_matches', 'crop_count_matches'])
        self.assertEqual(list(report['checks'])[-3:], ['findings_ids_unique', 'readings_values_in_vocabulary', 'crop_count_current'])
        self.assertNotIn('no_such_file_check', report['checks'])
        self.assertEqual(report['stale_derived_files'], [])
        self.assertEqual(report['readings']['files'], 1)

    def test_ids_unique_and_count_equals(self):
        self.edit('data/questions.json', lambda d: d['questions'].append(dict(d['questions'][0])))
        report = self.report()
        self.assertEqual({k for k, v in report['id_problems'].items()}, {'question_ids_unique', 'question_count_matches'})
        self.assertIs(report['checks']['question_ids_unique'], False)
        self.assertIs(report['checks']['question_count_matches'], False)

    def test_references_report_the_missing_values_or_the_owners(self):
        def break_groups(d):
            d['groups'][0]['questions'].append('QN-999')
            d['groups'][1]['season_id'] = 'SN-99'
            d['profiles'][0]['groups'].append('GR-9')
        self.edit('data/care-plans.json', break_groups)
        self.edit('data/questions.json', lambda d: d['questions'][0].update(same_as='W9.9'))
        problems = self.failing()
        self.assertEqual(problems['group_question_ids_resolve'], ['QN-999'])
        self.assertEqual(problems['group_season_ids_resolve'], ['SN-99'])
        self.assertEqual(problems['profile_group_ids_resolve'], ['GR-9'])
        self.assertEqual(problems['same_as_resolves'], ['QN-001'], 'owners, not the missing value')

    def test_list_equals_joined_names_the_profile(self):
        self.edit('data/care-plans.json', lambda d: d['profiles'][0].update(selected_questions=7))
        self.assertEqual(self.failing()['profile_question_ids_match_groups'], ['spring-planting'])
        self.edit('data/care-plans.json', lambda d: d['profiles'][0].update(selected_questions=8, question_ids=d['profiles'][0]['question_ids'][:-1]))
        self.assertEqual(self.failing()['profile_question_ids_match_groups'], ['spring-planting'])

    def test_not_chained(self):
        self.edit('data/questions.json', lambda d: d['questions'][7].update(same_as='QN-001'))
        self.edit('data/questions.json', lambda d: d['questions'][0].update(same_as='W1.2'))
        self.assertEqual(self.failing()['same_as_not_chained'], ['QN-008'])

    def test_text_table_matches_field_and_is_left_out_when_the_text_has_no_table(self):
        guide = self.root / 'notes' / 'guide.md'
        guide.write_text(guide.read_text().replace('| W1.1 | QN-008 |', '| W1.2 | QN-008 |'))
        self.assertEqual(self.failing()['chore_table_matches_same_as'], [['QN-008', 'W1.1'], ['QN-008', 'W1.2']])
        guide.write_text('# Guide\n\nNo table here.\n')
        report = self.report()
        self.assertNotIn('chore_table_matches_same_as', report['checks'])
        self.assertEqual(report['total'], len(report['checks']))

    def test_routes_known(self):
        self.edit('data/questions.json', lambda d: d['questions'][0].update(routes='herb + shade:part'))
        self.edit('data/questions.json', lambda d: d['questions'][1].update(routes='herbs'))
        self.assertEqual(self.failing()['routes_use_known_tags'], ['QN-002'])

    def test_ids_named_in_text_must_resolve(self):
        guide = self.root / 'notes' / 'guide.md'
        guide.write_text(guide.read_text() + '\nSee QN-042 and CD-001.\n')
        self.assertEqual(self.failing()['ids_named_in_notes_resolve'], ['guide.md:QN-042'])

    def test_investigation_records_are_checked_for_ids_and_shape(self):
        self.started()
        self.assertTrue(self.report()['all_passed'])
        record = self.record()
        record['nodes'][1]['id'] = 'QN-404'
        record['nodes'][2]['status'] = 'done'
        record['nodes'][3]['caught_by'] = ['W7.7']
        record['nodes'][4]['depends_on'] = ['QN-405']
        (self.piece / 'investigation.json').write_text(json.dumps(record))
        problems = self.failing()['investigation_ids_resolve']
        self.assertEqual(problems, sorted(problems))
        self.assertTrue(any(p.endswith(':QN-404') for p in problems))
        self.assertTrue(any(p.endswith(':status') for p in problems))
        self.assertTrue(any('caught_by W7.7' in p for p in problems))
        self.assertTrue(any('depends_on QN-405' in p for p in problems))

    def test_tables_are_checked_against_the_vocabulary(self):
        readings = self.root / 'beds' / 'old-orchard' / 'spring' / 'readings.tsv'
        readings.write_text('light\tcovers\tph\tday\tmystery\nhalf\therb,fruit\tacid\t2\tx\nfull\troot\t7\t3\ty\n')
        status, out, _ = run_cli(self.root, 'validate')
        report = json.loads(out)
        self.assertEqual(status, 1)
        self.assertEqual(report['readings']['bad_cells'], 3)  # light=half, covers=fruit, ph=acid
        self.assertIn('mystery', report['readings']['unknown_columns'])
        self.assertFalse(report['checks']['readings_values_in_vocabulary'])
        self.assertEqual(report['readings']['vocabulary'], str((self.root / 'data' / 'shade-vocabulary.json').resolve()))

    def test_a_derived_file_that_is_stale_is_named_and_a_command_that_fails_is_an_error(self):
        (self.root / 'data' / 'crop-count.txt').write_text('5')
        status, out, _ = run_cli(self.root, 'validate')
        report = json.loads(out)
        self.assertEqual((status, report['stale_derived_files'], report['checks']['crop_count_current']), (1, ['crop-count.txt'], False))
        (self.root / 'data' / 'crop-count.txt').write_text('not a number')
        status, _, err = run_cli(self.root, 'validate')
        self.assertEqual(status, 2)
        self.assertIn('crop_count_current', err)

    def test_a_schema_row_of_an_unknown_kind_or_pool_is_refused_by_name(self):
        schema = json.loads((self.root / 'schema.json').read_text())
        schema['checks'].append({'name': 'odd', 'kind': 'astrology', 'pool': 'questions'})
        (self.root / 'schema.json').write_text(json.dumps(schema))
        status, _, err = run_cli(self.root, 'validate')
        self.assertEqual(status, 2)
        self.assertIn('check odd: kind astrology is not one of', err)
        schema['checks'][-1] = {'name': 'odd', 'kind': 'ids-unique', 'pool': 'planets'}
        (self.root / 'schema.json').write_text(json.dumps(schema))
        status, _, err = run_cli(self.root, 'validate')
        self.assertEqual(status, 2)
        self.assertIn('no pool named planets', err)

    def test_a_schema_without_tables_or_derived_rows_still_validates(self):
        schema = json.loads((self.root / 'schema.json').read_text())
        del schema['tables'], schema['derived']
        (self.root / 'schema.json').write_text(json.dumps(schema))
        status, out, _ = run_cli(self.root, 'validate')
        report = json.loads(out)
        self.assertEqual(status, 0)
        self.assertEqual(list(report), ['all_passed', 'passed', 'total', 'checks', 'id_problems', 'scope'])

    def test_cli_exit_codes(self):
        status, out, _ = run_cli(self.root, 'validate')
        self.assertEqual(status, 0)
        self.assertTrue(json.loads(out)['all_passed'])
        status, _, err = run_cli(self.root, 'progress', str(self.piece))
        self.assertEqual(status, 2)
        self.assertIn('keep_a_record_library.py start', err)
        self.assertEqual(run_cli(self.root, 'start', str(self.piece), '--profile', 'spring-planting')[0], 0)
        status, _, err = run_cli(self.root, 'evidence', str(self.piece), '--q', 'orient', '--status', 'executed', '--file', str(self.piece / 'missing.md'))
        self.assertEqual(status, 2)
        self.assertIn('does not exist', err)


if __name__ == '__main__':
    unittest.main()

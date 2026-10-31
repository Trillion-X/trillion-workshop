"""Tests of the checklist gate (do-work/checklist_gate.py) on a made-up bakery library built by bakery.py: every command, through the command line,
the way a person's AI runs it."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bakery  # noqa: E402

GATE = HERE.parent / 'do-work' / 'checklist_gate.py'
MONDAY = 'batches/monday'


class GateCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.lib, self.schema = bakery.build(Path(self._tmp.name))
        self.piece = self.lib / MONDAY
        self.cli('checklist', '--write')

    # -- helpers ------------------------------------------------------------------------------------------------------
    def cli(self, *args, schema: Path | None = None):
        p = subprocess.run([sys.executable, '-I', str(GATE), '--library', str(self.lib), '--schema', str(schema or self.schema), *map(str, args)],
                           capture_output=True, text=True)
        out = json.loads(p.stdout) if p.stdout.strip() else None
        return p.returncode, out, p.stderr

    def gate(self, *options, stage='B1', at=None, piece=None):
        args = ['gate', piece or self.piece, '--stage', stage, *[x for o in options for x in ('--option', o)]]
        if at:
            args += ['--at', at]
        return self.cli(*args)

    def answer(self, check, answer='pass', evidence='looked at it, all fine', by='the baker', option=None, piece=None):
        args = ['answer', piece or self.piece, '--check', check, '--answer', answer, '--evidence', evidence, '--by', by]
        if option:
            args += ['--option', option]
        return self.cli(*args)

    def rows(self):
        path = self.piece / 'answers.jsonl'
        return [json.loads(x) for x in path.read_text().splitlines()] if path.is_file() else []

    def ids(self, result, key='unanswered_must'):
        return sorted((i['id'], i['option']) for i in result[key])

    def report(self, items: dict, name='checker-1.json', meta=None, mtime_after=True):
        """A checker report for items ({file path: {check: [finding]}}); written after the files, so it is not older than they are."""
        doc = {'_taste': meta if meta is not None else {'check_pins': {'crust': 'p-crust-1', 'crumb': 'p-crumb-1'}, 'config_overridden': False}, **items}
        path = bakery.write(self.lib / 'reports' / name, json.dumps(doc))
        return path

    def real(self, name):
        return os.path.realpath(next(self.piece.glob(f'lane-a/previews-round-*/{name}')))

    def set_pins(self, **pins):
        bakery.write(self.lib / 'reviewed-pins.json', json.dumps({'pins': pins}))


class ChecklistCommand(GateCase):
    def test_generated_document_reads_rule_wording_from_the_rule_source(self):
        doc = json.loads((self.lib / 'checklist.json').read_text())
        checks = {c['id']: c for s in doc['stages'] for c in s['checks']}
        self.assertEqual(doc['check_count'], len(checks))
        self.assertEqual(doc['must_count'], sum(c['must'] for c in checks.values()))
        self.assertEqual(checks['B1.R1']['rule'], 'No raw egg is ever left on a tray.')
        self.assertEqual(checks['B1.R1']['source'], 'rules.json#rows[no-raw-egg]')
        self.assertNotIn('not-a-bakery-rule', json.dumps(doc), 'a rule of another kind is not a row')
        self.assertEqual(checks['B1.Q3']['source'], 'agent')
        self.assertEqual(checks['B1.G1']['advisory_passes_at'], ['review'])
        self.assertEqual(doc['delivery_stages']['final'].split('.')[0], 'a loaf put on the shelf')
        self.assertEqual(checks['B1.R1']['must'], True)
        self.assertEqual(checks['B1.R2']['must'], False)

    def test_check_passes_until_the_text_changes(self):
        code, out, _ = self.cli('checklist', '--check')
        self.assertEqual((code, out['all_passed']), (0, True))
        source = self.lib / 'checklist-source.md'
        source.write_text(source.read_text().replace('| B2.2 | [ ] Sold out by close | all | Count the shelf | habit | no |',
                                                      '| B2.2 | [ ] Sold out by close | all | Count the shelf | habit | yes |'))
        code, out, _ = self.cli('checklist', '--check')
        self.assertEqual((code, out['all_passed']), (1, False))
        self.assertIn("differing: ['B2.2']", out['difference'])

    def test_problems_finds_what_a_hand_edit_breaks(self):
        path = self.lib / 'checklist.json'
        doc = json.loads(path.read_text())
        doc['stages'][1]['checks'].append(dict(doc['stages'][0]['checks'][0]))                    # a repeated id
        doc['stages'][0]['checks'][1]['must'] = 'yes'                                            # a must that is not true or false
        doc['stages'][0]['checks'][1]['advisory_passes_at'] = ['someday']                        # an advisory stage that is not a delivery stage
        del doc['stages'][0]['checks'][3]['rule_id']                                             # a per-item check with no rule id
        doc['after_phase'] = ['B9.9']                                                            # a phase that names no check
        path.write_text(json.dumps(doc))
        code, out, _ = self.cli('checklist', '--problems')
        self.assertEqual(code, 1)
        text = '\n'.join(out['problems'])
        for word in ('repeats the id', 'must is true or false', 'someday', 'names no rule_id', 'B9.9'):
            self.assertIn(word, text)

    def test_problems_is_clean_on_a_generated_document(self):
        self.assertEqual(self.cli('checklist', '--problems')[1], {'all_passed': True, 'problems': []})

    def test_a_rule_with_no_row_and_a_note_with_no_target_are_refused(self):
        bakery.write(self.lib / 'rules.json', json.dumps({'rows': [*bakery.RULES['rows'], {'id': 'extra-rule', 'rule': 'Another.', 'kinds': ['bakery']}]}))
        code, _, err = self.cli('checklist', '--check')
        self.assertEqual(code, 2)
        self.assertIn("rules with no checklist row: ['extra-rule']", err)
        bakery.write(self.lib / 'rules.json', json.dumps(bakery.RULES))
        source = self.lib / 'checklist-source.md'
        source.write_text(source.read_text().replace('**Advisory row:** B1.G1 at review', '**Advisory row:** B1.G1 at someday'))
        code, _, err = self.cli('checklist', '--check')
        self.assertEqual(code, 2)
        self.assertIn('Advisory row B1.G1', err)

    def test_stdout_without_a_flag_is_the_generated_document(self):
        code, out, _ = self.cli('checklist')
        self.assertEqual(out, json.loads((self.lib / 'checklist.json').read_text()))


class GateAndAnswers(GateCase):
    def test_a_piece_with_no_header_cannot_be_routed(self):
        (self.piece / 'BATCH.md').unlink()
        code, out, _ = self.gate('m2')
        self.assertEqual(code, 1)
        self.assertIn('routes undeclared', out['problems'][0])

    def test_per_item_checks_are_skipped_with_no_item_and_asked_for_each_item_with_one(self):
        _, out, _ = self.gate()
        self.assertEqual(self.ids(out), [('B1.1', None)])
        self.assertIn('B1.G1', out['per_option_checks_not_evaluated'])
        _, out, _ = self.gate('m2')
        self.assertEqual(self.ids(out), [('B1.1', None), ('B1.G1', 'm2'), ('B1.Q1', 'm2'), ('B1.Q2', 'm2'), ('B1.Q3', 'm2'), ('B1.Q4', 'm2'), ('B1.R1', 'm2')])
        self.assertNotIn('B1.R3', [i['id'] for i in out['unanswered_must']], 'a row routed to audio is not asked of a bread loaf')
        self.assertEqual(out['unanswered_optional_count'], 1)           # the slash row is not required
        self.assertTrue(all(i['answer_with'].startswith('python3 -I') for i in out['unanswered_must']))

    def test_answers_are_refused_for_a_checker_name_short_evidence_and_the_wrong_scope(self):
        self.assertEqual(self.answer('B1.1', by='taste-checker')[0], 2)
        self.assertIn('reserved for results recorded by a checker', self.answer('B1.1', by='scale')[2])
        self.assertIn('evidence is required', self.answer('B1.1', evidence='ok')[2])
        self.assertIn('answered per option', self.answer('B1.R1')[2])
        self.assertIn('answered once per piece', self.answer('B1.1', option='m2')[2])
        self.assertIn('never n/a', self.answer('B1.1', answer='n/a')[2])
        self.assertIn('not a check in the checklist', self.answer('B9.9')[2])
        self.assertEqual(self.rows(), [])

    def test_a_human_answer_counts_and_pins_the_file_it_judged(self):
        self.assertEqual(self.answer('B1.1')[0], 0)
        self.assertEqual(self.answer('B1.R1', option='m2')[0], 0)
        row = self.rows()[-1]
        self.assertEqual(set(row['file_pins']), {'m2'})
        self.assertEqual(len(row['file_pins']['m2']), 64)
        _, out, _ = self.gate('m2')
        self.assertNotIn('B1.1', [i['id'] for i in out['unanswered_must']])
        self.assertNotIn('B1.R1', [i['id'] for i in out['unanswered_must']])

    def test_a_row_on_other_bytes_is_stale_and_the_newest_row_stands(self):
        self.answer('B1.R1', option='m2')
        (self.piece / 'lane-a/previews-round-2/m2.txt').write_text('a different loaf')
        _, out, _ = self.gate('m2')
        stale = [i for i in out['unanswered_must'] if i['id'] == 'B1.R1']
        self.assertEqual(len(stale), 1)
        self.assertIn('other bytes of m2', stale[0]['stale'])
        self.answer('B1.R1', option='m2')                                                          # answered again on the new bytes
        _, out, _ = self.gate('m2')
        self.assertNotIn('B1.R1', [i['id'] for i in out['unanswered_must']])
        self.answer('B1.R1', answer='fail', evidence='a raw egg on the tray', option='m2')
        _, out, _ = self.gate('m2')
        self.assertEqual(self.ids(out, 'failed_must'), [('B1.R1', 'm2')])

    def test_a_human_row_never_stands_in_for_a_checker_row(self):
        self.answer('B1.Q1', option='m2', evidence='I looked at the crust myself')
        _, out, _ = self.gate('m2')
        self.assertIn(('B1.Q1', 'm2'), self.ids(out))

    def test_a_piece_level_row_goes_stale_when_a_file_it_routes_to_changes(self):
        self.answer('B1.1')
        _, out, _ = self.gate('m2', 'm1-r2')
        self.assertNotIn('B1.1', [i['id'] for i in out['unanswered_must']])
        (self.piece / 'lane-a/previews-round-2/m2.txt').write_text('changed')
        _, out, _ = self.gate('m2', 'm1-r2')
        self.assertIn('B1.1', [i['id'] for i in out['unanswered_must']])

    def test_unknown_stage_and_delivery_stage_are_refused(self):
        self.assertIn('unknown stage B7', self.gate('m2', stage='B7')[2])
        self.assertIn('unknown delivery stage someday', self.gate('m2', at='someday')[2])

    def test_the_first_gate_starts_the_record_once(self):
        self.assertFalse((self.piece / 'record.json').exists())
        _, out, _ = self.gate('m2')
        self.assertEqual(out['investigation_started'], 'record.json')
        self.assertTrue((self.piece / 'record.json').is_file())
        self.assertIsNone(self.gate('m2')[1]['investigation_started'])

    def test_rows_routed_by_a_flag_the_files_prove(self):
        self.assertNotIn('B2.1', [i['id'] for i in self.gate('m2', stage='B2')[1]['unanswered_must']])
        bakery.write(self.piece / 'lane-a/specs-round-2/m2.json', json.dumps({'recipe': {'nuts': ['almond']}}))
        _, out, _ = self.gate('m2', stage='B2')
        self.assertIn('B2.1', [i['id'] for i in out['unanswered_must']])
        self.assertIn('nuts', out['tags'])

    def test_a_publish_phase_row_is_not_asked(self):
        _, out, _ = self.gate('m2', stage='B2')
        asked = [i['id'] for i in out['unanswered_must']]
        self.assertNotIn('B2.2', asked)
        self.assertEqual(out['unanswered_optional_count'], 0, 'the publish and after-publish rows are neither asked nor counted')

    def test_a_medium_that_applies_per_file_routes_each_file_its_own_rows(self):
        bakery.header(self.piece, medium='bread audio')
        bakery.loaf(self.piece, 'lane-a', 2, 'hum', suffix='wav', text='hum', spec={'recipe': {}})
        _, out, _ = self.gate('m2', 'hum')
        asked = self.ids(out)
        self.assertIn(('B1.R3', 'hum'), asked)
        self.assertNotIn(('B1.R3', 'm2'), asked)
        self.assertIn(('B1.R1', 'm2'), asked)
        self.assertNotIn(('B1.R1', 'hum'), asked)

    def test_a_piece_with_its_own_config_names_its_own_item_files(self):
        other = self.lib / 'batches' / 'tuesday'
        bakery.header(other)
        bakery.write(other / 'loaves' / 'rye.txt', 'rye')
        bakery.write(other / 'batch.json', json.dumps({'item_globs': ['loaves/*.txt'], 'id_mode': 'path'}))
        _, out, _ = self.gate('loaves/rye', piece=other)
        self.assertIn(('B1.G1', 'loaves/rye'), self.ids(out))


class AdvisoryAndPicks(GateCase):
    def run_gates(self, *options, at='review'):
        args = ['run-gates', self.piece, '--lane-dir', self.piece / 'lane-a', '--at', at]
        if options:
            args += ['--option', ','.join(options)]
        return self.cli(*args)

    def test_an_advisory_row_passes_only_at_its_stage(self):
        (self.piece / 'lane-a/previews-round-2/m2.txt').write_text('a SOFT loaf')
        code, out, _ = self.run_gates('m2')
        self.assertEqual((code, out['rows'][0]['answer']), (0, 'advisory'))
        _, review, _ = self.gate('m2', at='review')
        self.assertNotIn(('B1.G1', 'm2'), self.ids(review))
        self.assertNotIn(('B1.G1', 'm2'), self.ids(review, 'failed_must'))
        self.assertEqual([a['id'] for a in review['advisory']], ['B1.G1'])
        self.assertIn('advisory, not a pass', review['advisory'][0]['pick_line'])
        _, final, _ = self.gate('m2', at='final')
        self.assertEqual(self.ids(final, 'failed_must'), [('B1.G1', 'm2')])
        self.assertIn('advisory passes only at review', final['failed_must'][0]['evidence'])
        self.assertEqual(final['advisory'], [])

    def test_a_failed_judgment_on_a_rebuild_of_a_picked_item_waits_for_the_person(self):
        bakery.write(self.piece / 'verdicts.jsonl', json.dumps({'option_id': 'm1-r1', 'verdict': 'picked'}) + '\n')
        bakery.write(self.piece / 'lane-a/specs-round-2/m1-r2.json', json.dumps({'recipe': {}, 'rebuild_of': 'm1-r1'}))
        self.answer('B1.R1', answer='fail', evidence='UNCERTAIN: maybe an egg', option='m1-r2')
        self.answer('B1.R1', answer='fail', evidence='a raw egg on the tray', option='m2')
        _, out, _ = self.gate('m1-r2', 'm2')
        self.assertEqual([(i['id'], i['option'], i['rebuild_of']) for i in out['waits_for_person_picked_design']], [('B1.R1', 'm1-r2', 'm1-r1')])
        self.assertEqual(self.ids(out, 'failed_must'), [('B1.R1', 'm2')])
        bakery.write(self.piece / 'verdicts.jsonl', json.dumps({'option_id': 'm1-r1', 'verdict': 'rejected'}) + '\n')
        _, out, _ = self.gate('m1-r2')
        self.assertEqual(out['waits_for_person_picked_design'], [])
        self.assertEqual(self.ids(out, 'failed_must'), [('B1.R1', 'm1-r2')])


class Scope(GateCase):
    def scope(self):
        code, out, err = self.cli('scope', self.piece)
        self.assertEqual(code, 0, err)
        return out

    def test_latest_round_plus_live_picks(self):
        self.assertEqual(self.scope(), ['m1-r2', 'm2'])
        bakery.write(self.piece / 'verdicts.jsonl', json.dumps({'option_id': 'm1-r1', 'verdict': 'picked'}) + '\n')
        self.assertEqual(self.scope(), ['m1-r1', 'm1-r2', 'm2'])
        bakery.write(self.piece / 'verdicts.jsonl', ''.join(json.dumps({'option_id': o, 'verdict': 'picked'}) + '\n' for o in ('m1-r1', 'm1-r2')))
        self.assertEqual(self.scope(), ['m1-r2', 'm2'], 'a pick of a later round for the same moment replaces the earlier pick')

    def test_a_lane_name_narrows_it(self):
        bakery.loaf(self.piece, 'lane-b', 1, 'm9', spec={'recipe': {}})
        self.assertEqual(self.cli('scope', self.piece, '--lane', 'lane-b')[1], ['m9'])
        self.assertEqual(self.cli('scope', self.piece)[1], ['m1-r2', 'm2', 'm9'])


class Audit(GateCase):
    def link(self, folder: str, name: str, source: str):
        target = self.piece / 'lane-a' / folder
        target.mkdir(parents=True, exist_ok=True)
        os.link(self.piece / 'lane-a' / source / f'{name}.txt', target / f'{name}.txt')
        return target / f'{name}.txt'

    def test_a_linked_file_whose_item_has_an_open_row_is_an_offender_and_is_held_back(self):
        link = self.link('ROUND 2 watch-these', 'm2', 'previews-round-2')
        code, out, _ = self.cli('audit', self.piece)
        self.assertEqual(code, 1)
        self.assertEqual([o['option'] for o in out['offenders']], ['m2'])
        self.assertIn('B1.1 (open)', out['offenders'][0]['rows'])
        self.assertTrue(link.exists())
        code, out, _ = self.cli('audit', self.piece, '--hold')
        held = self.piece / 'lane-a' / 'held-back' / 'm2.txt'
        self.assertEqual(out['moved_to_held_back'], [os.path.realpath(held)])
        self.assertTrue(held.exists() and not link.exists())
        self.assertTrue((self.piece / 'lane-a/previews-round-2/m2.txt').exists(), 'the offered file itself is never touched')

    def test_a_ruling_the_person_owes_waits_and_is_never_held(self):
        link = self.link('ROUND 2 watch-these', 'm2', 'previews-round-2')
        self.answer('B1.1')
        for check, option in (('B1.R1', 'm2'),):
            self.answer(check, answer='fail', evidence='UNCERTAIN: maybe a raw egg', option=option)
        self.run_machine_rows('m2')
        code, out, _ = self.cli('audit', self.piece, '--hold')
        self.assertEqual(out['offenders'], [], out)
        self.assertEqual([w['option'] for w in out['waits_for_person']], ['m2'])
        self.assertTrue(link.exists())

    def run_machine_rows(self, option):
        self.assertEqual(self.cli('run-gates', self.piece, '--lane-dir', self.piece / 'lane-a', '--option', option, '--at', 'review')[0], 0)
        self.assertEqual(self.cli('sweep', self.piece, '--previews', 'lane-a/previews-round-2', '--only', option)[0], 0)

    def test_files_of_an_older_round_and_replaced_picks_are_not_audited(self):
        self.link('ROUND 1 watch-these', 'm1-r1', 'previews-round-1')
        self.link('ROUND 2 watch-these', 'm2', 'previews-round-2')
        _, out, _ = self.cli('audit', self.piece)
        self.assertEqual([o['option'] for o in out['offenders']], ['m2'])
        self.assertEqual(out['superseded_not_audited']['files'], 1)
        bakery.write(self.piece / 'verdicts.jsonl', ''.join(json.dumps({'option_id': o, 'verdict': 'picked'}) + '\n' for o in ('m1-r1', 'm1-r2')))
        _, out, _ = self.cli('audit', self.piece)
        self.assertEqual([s['option'] for s in out['superseded_picks']], ['m1-r1'])

    def test_a_file_about_to_be_shown_is_checked_and_a_stranger_is_refused(self):
        offered = self.piece / 'lane-a/previews-round-2/m2.txt'
        stranger = bakery.write(self.lib / 'elsewhere' / 'stray.txt', 'not an offered file')
        code, out, _ = self.cli('audit', self.piece, '--file', offered, '--file', stranger)
        self.assertEqual(code, 1)
        files = {o['file']: o for o in out['offenders']}
        self.assertIn('B1.1 (open)', files[str(offered)]['rows'])
        self.assertIn('no check covers it', files[str(stranger)]['rows'][0])


class RunGates(GateCase):
    def run_lane(self, *options, at='final'):
        args = ['run-gates', self.piece, '--lane-dir', self.piece / 'lane-a', '--at', at]
        if options:
            args += ['--option', ','.join(options)]
        return self.cli(*args)

    def test_a_gate_row_is_recorded_under_the_gate_name_with_the_gate_pin(self):
        code, out, _ = self.run_lane('m2')
        self.assertEqual((code, out['all_passed']), (0, True))
        row = self.rows()[-1]
        self.assertEqual((row['by'], row['option_id'], row['answer']), ('scale', 'm2', 'pass'))
        self.assertEqual(len(row['check_pin']), 64)
        _, g, _ = self.gate('m2')
        self.assertNotIn(('B1.G1', 'm2'), self.ids(g))

    def test_a_failing_gate_row_blocks_and_a_changed_gate_stales_every_row(self):
        (self.piece / 'lane-a/previews-round-2/m2.txt').write_text('an OVERWEIGHT loaf')
        code, out, _ = self.run_lane('m2')
        self.assertEqual((code, out['all_passed']), (1, False))
        _, g, _ = self.gate('m2')
        self.assertEqual(self.ids(g, 'failed_must'), [('B1.G1', 'm2')])
        (self.piece / 'lane-a/previews-round-2/m2.txt').write_text('a fine loaf')
        self.run_lane('m2')
        self.assertNotIn(('B1.G1', 'm2'), self.ids(self.gate('m2')[1]))
        bakery.write(self.lib / 'tools' / 'gate-words.txt', 'light; heavy; and a new word\n')      # the gate's own words changed: its old rows no longer count
        self.assertIn(('B1.G1', 'm2'), self.ids(self.gate('m2')[1]))

    def test_an_item_the_gate_cannot_judge_is_listed_and_records_nothing(self):
        (self.piece / 'lane-a/previews-round-2/m2.txt').write_text('NOMEASURE')
        (self.piece / 'lane-a/previews-round-2/m1-r2.txt').write_text('NOSPEC')
        code, out, _ = self.run_lane('m2', 'm1-r2')
        self.assertEqual(code, 1 if not out['all_passed'] else 0)
        self.assertEqual(self.rows(), [])
        self.assertEqual(sorted(next(k for k in r if k != 'option') for r in out['rows']), ['not_measured', 'problem'])

    def test_a_gate_that_answers_for_an_unlisted_gate_or_prints_no_json_is_an_error(self):
        schema = json.loads(self.schema.read_text())
        schema['runs']['lane']['gates'] = ['another-gate']
        other = bakery.write(self.lib / 'other-schema.json', json.dumps(schema))
        code, _, err = self.cli('run-gates', self.piece, '--lane-dir', self.piece / 'lane-a', '--option', 'm2', schema=other)
        self.assertEqual(code, 2)
        self.assertIn('does not list for it', err)
        schema['runs']['lane']['command'] = ['{python}', '-I', '-V']
        other.write_text(json.dumps(schema))
        code, _, err = self.cli('run-gates', self.piece, '--lane-dir', self.piece / 'lane-a', '--option', 'm2', schema=other)
        self.assertEqual(code, 2)
        self.assertIn('printed no JSON last line', err)

    def test_run_files_takes_only_files_the_piece_offers(self):
        offered = self.piece / 'lane-a/previews-round-2/m2.txt'
        stranger = bakery.write(self.lib / 'elsewhere' / 'stray.txt', 'x')
        code, out, _ = self.cli('run-files', self.piece, '--file', offered, '--file', stranger, '--at', 'final')
        self.assertEqual(code, 1)
        self.assertEqual([r.get('option') for r in out['rows'] if r.get('answer')], ['m2'])
        self.assertIn('not a file monday offers', [r['problem'] for r in out['rows'] if 'problem' in r][0])


class ReportAndSweep(GateCase):
    def answers_from(self, report, *extra):
        return self.cli('answers-from-report', self.piece, '--json', report, *extra)

    def clean_report(self, name='m2'):
        return self.report({self.real(f'{name}.txt'): {'crust': [{'status': 'PASS', 'message': 'crust ok'}],
                                                         'crumb': [{'status': 'PASS', 'message': '4 slices cut, all fine'}]}})

    def test_a_report_records_one_row_per_mapped_rule_with_the_reviewed_pin(self):
        code, out, _ = self.answers_from(self.clean_report())
        self.assertEqual(code, 0, out)
        got = {(r['check_id'], r['answer']) for r in out['rows']}
        self.assertEqual(got, {('B1.Q1', 'pass'), ('B1.Q2', 'pass'), ('B1.Q3', 'pass')})
        rows = {r['check_id']: r for r in self.rows()}
        self.assertEqual({r['by'] for r in rows.values()}, {'taste-checker'})
        self.assertEqual(rows['B1.Q1']['check_pin'], 'p-crust-1')
        self.assertIn('4 slices linted, no finding left unmapped', rows['B1.Q3']['evidence'])
        _, g, _ = self.gate('m2')
        self.assertFalse({'B1.Q1', 'B1.Q2', 'B1.Q3'} & {i['id'] for i in g['unanswered_must']})

    def test_a_fail_finding_is_a_fail_row_and_one_no_rule_names_fails_the_catch_all(self):
        report = self.report({self.real('m2.txt'): {'crust': [{'status': 'FAIL', 'message': 'crust is burnt'}],
                                                      'crumb': [{'status': 'FAIL', 'message': 'dense at slice 3'}]}})
        self.answers_from(report)
        rows = {r['check_id']: r for r in self.rows()}
        self.assertEqual(rows['B1.Q1']['answer'], 'fail')
        self.assertEqual(rows['B1.Q2']['answer'], 'pass', 'the crumb rule is named only by findings that start with "open"')
        self.assertEqual(rows['B1.Q3']['answer'], 'fail')
        self.assertIn('matches no mapped rule', rows['B1.Q3']['evidence'])

    def test_a_check_that_is_not_the_reviewed_version_records_nothing(self):
        self.set_pins(crust='p-crust-1', crumb='p-crumb-OLD')
        code, out, _ = self.answers_from(self.clean_report())
        self.assertEqual(code, 0)
        self.assertEqual({r['check_id'] for r in self.rows()}, {'B1.Q1'})
        self.assertIn('crumb', out['checks_not_recorded'])
        self.assertIn('is not the reviewed version', out['checks_not_recorded']['crumb'])
        _, g, _ = self.gate('m2')
        self.assertIn(('B1.Q2', 'm2'), self.ids(g))

    def test_a_report_made_by_another_version_of_the_check_records_nothing_for_it(self):
        report = self.report({self.real('m2.txt'): {'crust': [{'status': 'PASS', 'message': 'ok'}]}}, meta={'check_pins': {'crust': 'p-crust-0', 'crumb': 'p-crumb-1'}, 'config_overridden': False})
        out = self.answers_from(report)[1]
        self.assertEqual(self.rows(), [])
        self.assertIn('another version', out['checks_not_recorded']['crust'])

    def test_a_row_written_under_pins_that_have_since_changed_does_not_count(self):
        self.answers_from(self.clean_report())
        self.set_pins(crust='p-crust-2', crumb='p-crumb-1')
        _, g, _ = self.gate('m2')
        self.assertIn(('B1.Q1', 'm2'), self.ids(g))
        self.assertNotIn(('B1.Q2', 'm2'), self.ids(g))

    def test_a_report_with_no_pins_or_made_with_an_override_or_on_a_file_not_offered_is_refused(self):
        self.assertIn('has no _taste check_pins', self.answers_from(self.report({}, meta={}))[2])
        self.assertIn('--config override', self.answers_from(self.report({}, meta={'check_pins': {}, 'config_overridden': True}))[2])
        stranger = bakery.write(self.lib / 'elsewhere' / 'stray.txt', 'x')
        report = self.report({str(stranger): {'crust': [{'status': 'PASS', 'message': 'ok'}]}})
        self.assertIn('not a file monday offers', self.answers_from(report)[2])

    def test_a_file_changed_after_its_report_is_refused(self):
        report = self.clean_report()
        os.utime(report, (time.time() - 100, time.time() - 100))
        (self.piece / 'lane-a/previews-round-2/m2.txt').write_text('changed after the report')
        self.assertIn('was changed after', self.answers_from(report)[2])

    def test_a_check_the_checker_could_not_measure_for_long_records_nothing_but_a_blip_does_not_matter(self):
        long_gap = {'status': 'PASS', 'message': 'could not read', 't': 0, 't_end': 5, 'data': {'not_measured': True}}
        blip = {'status': 'PASS', 'message': 'blink', 't': 0, 't_end': 0.2, 'data': {'not_measured': True}}
        report = self.report({self.real('m2.txt'): {'crust': [long_gap], 'crumb': [blip]}})
        self.answers_from(report)
        self.assertEqual({r['check_id'] for r in self.rows()}, {'B1.Q2', 'B1.Q3'})

    def test_a_report_with_no_current_pins_command_is_a_plain_error(self):
        schema = json.loads(self.schema.read_text())
        del schema['checkers']['current_pins_command']
        other = bakery.write(self.lib / 'other-schema.json', json.dumps(schema))
        code, _, err = self.cli('answers-from-report', self.piece, '--json', self.clean_report(), schema=other)
        self.assertEqual(code, 2)
        self.assertIn('names no checkers.current_pins_command', err)

    def test_the_sweep_records_the_checker_rows_and_its_own_and_lists_faults_by_rule(self):
        (self.piece / 'lane-a/previews-round-2/m1-r2.txt').write_text('a BURNT loaf')
        code, out, _ = self.cli('sweep', self.piece, '--previews', 'lane-a/previews-round-2')
        self.assertEqual(code, 1)
        self.assertEqual(out['options'], ['m1-r2', 'm2'])
        self.assertEqual(sorted(out['faults_by_rule']), ['B1.Q1'])
        self.assertEqual([f['option'] for f in out['faults_by_rule']['B1.Q1']], ['m1-r2'])
        rows = {(r['check_id'], r['option_id']): r for r in self.rows()}
        self.assertEqual(rows[('B1.Q4', 'm2')]['by'], 'sweeper')
        self.assertEqual(rows[('B1.Q4', 'm2')]['check_pin'], 'sweep-pin-1')
        self.assertEqual(out['options_not_fully_measured'], [], 'a failed rule is a measured one: the sweep row is recorded and the fault is listed')
        self.assertIn(('B1.Q4', 'm1-r2'), rows)
        self.assertEqual(len(list((self.piece / 'lane-a').glob('sweep-*-report.json'))), 1)

    def test_the_sweep_lists_items_with_no_spec_and_refuses_a_missing_folder(self):
        (self.piece / 'lane-a/specs-round-2/m2.json').unlink()
        code, out, _ = self.cli('sweep', self.piece, '--previews', 'lane-a/previews-round-2')
        self.assertEqual(code, 1)
        self.assertEqual([Path(p).stem for p in out['previews_without_a_spec']], ['m2'])
        self.assertEqual(self.cli('sweep', self.piece, '--previews', 'lane-a/nowhere')[0], 2)

    def test_everything_answered_passes_the_gate(self):
        self.answer('B1.1')
        self.answer('B1.R1', option='m2')
        self.assertEqual(self.cli('run-gates', self.piece, '--lane-dir', self.piece / 'lane-a', '--option', 'm2', '--at', 'final')[0], 0)
        self.assertEqual(self.cli('sweep', self.piece, '--previews', 'lane-a/previews-round-2', '--only', 'm2')[0], 0)
        code, out, _ = self.gate('m2', at='final')
        self.assertEqual((code, out['all_passed']), (0, True), out)


class SchemaReading(GateCase):
    def test_a_missing_section_and_a_missing_reference_name_themselves(self):
        schema = json.loads(self.schema.read_text())
        del schema['audit']
        broken = bakery.write(self.lib / 'broken.json', json.dumps(schema))
        code, _, err = self.cli('audit', self.piece, schema=broken)
        self.assertEqual(code, 2)
        self.assertIn('the schema has no "audit" section', err)
        schema = json.loads(self.schema.read_text())
        schema['checkers']['report_pins'] = {'$ref': {'file': 'reviewed-pins.json', 'path': 'nope'}}
        broken.write_text(json.dumps(schema))
        code, _, err = self.cli('gate', self.piece, '--stage', 'B1', schema=broken)
        self.assertEqual(code, 2)
        self.assertIn('which has no nope', err)

    def test_a_value_with_an_owner_is_read_from_the_owner(self):
        self.set_pins(crust='p-crust-1', crumb='p-crumb-1', extra='x')
        self.assertEqual(self.answers_ok(), 0)

    def answers_ok(self):
        report = bakery.write(self.lib / 'reports' / 'checker-1.json', json.dumps({'_taste': {'check_pins': {'crust': 'p-crust-1', 'crumb': 'p-crumb-1'}, 'config_overridden': False}}))
        return self.cli('answers-from-report', self.piece, '--json', report)[0]


if __name__ == '__main__':
    unittest.main()

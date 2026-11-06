"""Tests of the delivery checklist gate (read-data/delivery_gate.py and its commands), on a made-up library of films (test/fixtures/delivery)
copied to a temporary folder. Ported one to one from the launch-video tests of cis.py (classes Gate, FilmDefaults and Audition); every
film, option, rule, line and verdict row here is made up. The person's branch of their Checks list is a stand-in records door file
(fixtures/delivery/data/check-records.json), read by the real copy check where a test runs it.

Needs python3 with numpy (the render check's modules), BLAKE3 (the blake3 module or b3sum), node, and ffmpeg/ffprobe for the audition
tests. Run: python3 -I -m unittest discover -s tools/keep-a-record-library-valid/test -v   (or npm test)"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'delivery'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import delivery_gate as dg  # noqa: E402
import keep_a_record_library as cli  # noqa: E402
from library import Store  # noqa: E402

HAS = {name: importlib.util.find_spec(name) is not None for name in ('numpy', 'blake3')}
READY = HAS['numpy'] and (HAS['blake3'] or shutil.which('b3sum')) and shutil.which('node')
needs_tools = unittest.skipUnless(READY, 'needs numpy, BLAKE3 (blake3 module or b3sum) and node')
needs_ffmpeg = unittest.skipUnless(READY and shutil.which('ffmpeg') and shutil.which('ffprobe'), 'needs ffmpeg and ffprobe')

HEADER = """# SCRIPT

## Piece header
```
piece:            test-piece
medium:           video
source:           data:git
shape:            list          (changelog)
flags:            voice clone music sfx sound rebuilt example hf ref changes
length:           38 s
```
"""


def novel_artifact(store, file, extra, held=False, only=None, exclude=None):
    """The copy check's result on an artifact with nothing of the person's that judges it, read the gate's way."""
    return dg.copy_gate_verdict([{'verdict': 'uncertain', 'text': Path(file).name, 'uncertain': [{'rule': 'novel-no-verdict-no-row'}]}], held, only, exclude)


def qa_report(store, path, body, **meta):
    """A check-a-rendered-video --json report, run with the library's limits, with these findings."""
    dg.film_qa_tool()
    from rendercheck import config as fq_config, pins as fq_pins
    cfg = fq_config.load(str(dg.render_check_limits(store)))
    record = {'limits_blake3': fq_config.fingerprint(cfg), 'check_pins': fq_pins.check_pins(cfg), **meta}
    Path(path).write_text(json.dumps({'_run': record, **body}))


@needs_tools
class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='delivery-gate-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'library'
        shutil.copytree(FIXTURE, self.root)
        dg.film_qa_tool()
        from rendercheck import config as fq_config, pins as fq_pins
        schema = json.loads((self.root / 'schema.json').read_text())
        schema['delivery_gate']['film_qa_check_pins'] = fq_pins.check_pins(fq_config.load(str(self.root / 'data' / 'render-check-limits.json')))
        (self.root / 'schema.json').write_text(json.dumps(schema, indent=1))
        self.piece = self.root / 'films' / 'test-piece'
        self.piece.mkdir(parents=True)
        (self.piece / 'SCRIPT.md').write_text(HEADER)
        (self.piece / 'RESULT.md').write_text('result v1\n')
        (self.piece / 'film-gate.json').write_text('{}')      # declares no shipped previews; FilmDefaults tests a film with no config file
        self.store = self.new_store()
        dg.branch_rules.__defaults__[1].clear()

    def new_store(self):
        store = Store(self.root, self.root / 'schema.json')
        store.gate_run = {'door': ['--door-records', str(self.root / 'data' / 'check-records.json')], 'checker_args': ['--no-model']}
        return store

    def set_gate(self, key, value):
        schema = json.loads((self.root / 'schema.json').read_text())
        schema['delivery_gate'][key] = value
        (self.root / 'schema.json').write_text(json.dumps(schema, indent=1))
        self.store = self.new_store()

    def stub(self, name, value):
        self.addCleanup(setattr, dg, name, getattr(dg, name))
        setattr(dg, name, value)

    def answer_all(self, out, answer='pass', machine_rows=True):
        machine = dg.machine_checks(self.store)
        for item in out['unanswered_must']:
            if item['id'] in machine and machine_rows:
                dg.record_answer(self.store, self.piece, item['id'], answer, 'evidence for ' + item['id'], 'render-check', item['option'], machine=True, check_pin=dg.required_pin(self.store, self.piece, item['id']))
            elif item['id'] in machine:
                dg.record_answer(self.store, self.piece, item['id'], answer, 'agent claims ' + item['id'], 'test', item['option'])
            else:
                dg.record_answer(self.store, self.piece, item['id'], answer, 'evidence for ' + item['id'], 'test', item['option'])


class Gate(Base):
    def setUp(self):
        super().setUp()
        (self.piece / 'SCRIPT.md').write_text(HEADER.replace('voice clone music sfx sound rebuilt example hf ref changes', 'hf'))

    def gate(self, stages=('S5',), options=()):
        return dg.gate(self.store, self.piece, list(stages), list(options))

    def test_a_failed_judgment_row_on_a_rebuild_of_a_picked_design_waits_for_the_person_and_does_not_block(self):
        lane = self.piece / 'craft' / 'options-ch9'
        (lane / 'specs-round-7').mkdir(parents=True)
        for name, spec in (('b-r7-1', {'rebuild_of': 'b-r6-1'}), ('c-r7-1', {}), ('d-r7-1', {'rebuild_of': 'd-r6-1'})):
            (lane / 'specs-round-7' / f'{name}.json').write_text(json.dumps(spec))
        (self.piece / 'verdicts.jsonl').write_text(json.dumps({'option_id': 'b-r6-1', 'verdict': 'picked'}) + '\n' + json.dumps({'option_id': 'd-r6-1', 'verdict': 'rejected'}) + '\n')
        (self.piece / 'film-gate.json').write_text(json.dumps({'verdict_file': 'verdicts.jsonl', 'picked_verdicts': ['picked']}))
        judgment, other = 'S5.R62', 'S5.R02'      # a reviewer-answered judgment rule and a lane-answered one
        for opt in ('b-r7-1', 'c-r7-1', 'd-r7-1'):
            dg.record_answer(self.store, self.piece, judgment, 'fail', 'the reviewer: reads as a rushed edit at 0:12', 'test', opt)
        dg.record_answer(self.store, self.piece, other, 'fail', 'a move that serves nothing', 'test', 'b-r7-1')
        out = self.gate(options=['b-r7-1', 'c-r7-1', 'd-r7-1'])
        self.assertEqual([(w['id'], w['option'], w['rebuild_of']) for w in out['waits_for_the_person_picked_design']], [(judgment, 'b-r7-1', 'b-r6-1')])
        failed = {(f['id'], f['option']) for f in out['failed_must']}
        self.assertIn((judgment, 'c-r7-1'), failed)          # no rebuild_of: the builder's own design
        self.assertIn((judgment, 'd-r7-1'), failed)          # rebuild of a design that was not picked
        self.assertNotIn((judgment, 'b-r7-1'), failed)
        self.assertIn((other, 'b-r7-1'), failed)             # a row that is not a judgment rule still blocks
        self.assertFalse(out['all_passed'])

    def test_gate_starts_investigation_and_lists_unanswered_must(self):
        self.assertFalse((self.piece / 'investigation.json').exists())
        out = self.gate()
        self.assertTrue((self.piece / 'investigation.json').is_file())
        self.assertFalse(out['all_passed'])
        ids = {i['id'] for i in out['unanswered_must']}
        self.assertIn('S5.1', ids)
        self.assertNotIn('S5.R01', ids, 'per-option checks wait for an option id')
        self.assertIn('S5.R01', out['per_option_checks_not_evaluated'])

    def test_option_asks_per_option_checks_and_answers_close_the_gate(self):
        out = self.gate(options=['m01-1'])
        self.assertIn(('S5.R01', 'm01-1'), {(i['id'], i['option']) for i in out['unanswered_must']})
        self.answer_all(out)
        self.assertTrue(self.gate(options=['m01-1'])['all_passed'])
        again = self.gate(options=['m01-1', 'm02-1'])
        self.assertFalse(again['all_passed'])
        self.assertTrue(all(i['option'] == 'm02-1' for i in again['unanswered_must'] if i['id'].startswith('S5.R')))

    def test_failed_must_blocks_until_a_newer_pass(self):
        self.answer_all(self.gate(options=['a']))
        dg.record_answer(self.store, self.piece, 'S5.R19', 'fail', 'render check in-frame FAIL at 3.2 s', 'render-check', 'a', machine=True, check_pin=dg.required_pin(self.store, self.piece, 'S5.R19'))
        out = self.gate(options=['a'])
        self.assertEqual([f['id'] for f in out['failed_must']], ['S5.R19'])
        dg.record_answer(self.store, self.piece, 'S5.R19', 'pass', 'render check in-frame PASS after fix', 'render-check', 'a', machine=True, check_pin=dg.required_pin(self.store, self.piece, 'S5.R19'))
        self.assertTrue(self.gate(options=['a'])['all_passed'])

    def test_answer_validation(self):
        rec = lambda *a, **k: dg.record_answer(self.store, self.piece, *a, **k)
        with self.assertRaisesRegex(ValueError, 'per option'):
            rec('S5.R01', 'pass', 'long enough evidence', 'test')
        with self.assertRaisesRegex(ValueError, 'once per piece'):
            rec('S5.1', 'pass', 'long enough evidence', 'test', 'a')
        with self.assertRaisesRegex(ValueError, 'evidence is required'):
            rec('S5.1', 'pass', ' short ', 'test')
        with self.assertRaisesRegex(ValueError, 'never n/a'):
            rec('S5.1', 'n/a', 'long enough evidence', 'test')
        with self.assertRaisesRegex(ValueError, 'not a check'):
            rec('S5.99', 'pass', 'long enough evidence', 'test')
        self.assertEqual(rec('S5.R16', 'n/a', 'no paper pieces exist: grep of spec found 0', 'test', 'a')['answer'], 'n/a')

    def test_missing_header_fails_the_gate(self):
        (self.piece / 'SCRIPT.md').unlink()
        out = self.gate()
        self.assertFalse(out['all_passed'])
        self.assertIn('Piece header', out['problems'][0])

    def test_unknown_stage_is_an_error(self):
        with self.assertRaisesRegex(ValueError, 'unknown stage'):
            self.gate(stages=['S99'])

    def test_render_check_report_records_mapped_rules(self):
        report = self.tmp / 'qa.json'
        qa_report(self.store, report, {'/x/previews/m09-1.mp4': {
            'in-frame': [{'check': 'in-frame', 'status': 'FAIL', 'message': 'card off right edge'}],
            'joins': [{'check': 'joins', 'status': 'INFO', 'message': 'ok'}]}})
        self.assertEqual(dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')['recorded'], 2)
        rows = dg.read_answers(self.store, self.piece)
        self.assertEqual(rows[('S5.R19', 'm09-1')]['answer'], 'fail')
        self.assertEqual(rows[('S5.R22', 'm09-1')]['answer'], 'pass')

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = cli.main(['--library', str(self.root), '--schema', str(self.root / 'schema.json'),
                               '--door-records', str(self.root / 'data' / 'check-records.json'), *argv])
        return status, out.getvalue(), err.getvalue()

    def test_cli_gate_exit_code_and_answer(self):
        self.assertEqual(self.run_cli('gate', str(self.piece), '--stage', 'S5,S6')[0], 1)
        status, out, err = self.run_cli('answer', str(self.piece), '--check', 'S5.1', '--answer', 'pass', '--evidence', 'the overlay lint output: 0 errors', '--by', 'test')
        self.assertEqual(status, 0, err)
        self.assertEqual(json.loads(out)['check_id'], 'S5.1')
        self.assertEqual(self.run_cli('answer', str(self.piece), '--check', 'S5.1', '--answer', 'pass', '--evidence', 'claimed by the machine name', '--by', 'sweep')[0], 2)

    def test_long_video_header_routes_rule_checks(self):
        for medium in ('long', 'video', 'swipe'):
            (self.piece / 'SCRIPT.md').write_text(HEADER.replace('medium:           video', f'medium:           {medium}'))
            out = self.gate(stages=('S5', 'S6'), options=['a'])
            self.assertGreater(out['per_option_rule_checks_routed'], 15, medium)
            self.assertFalse(any('WARNING' in p for p in out['problems']), medium)

    def test_zero_routed_rule_checks_is_a_loud_problem(self):
        (self.piece / 'SCRIPT.md').write_text(HEADER.replace('medium:           video', 'medium:           text'))
        out = self.gate(stages=('S5',), options=['a'])
        self.assertEqual(out['per_option_rule_checks_routed'], 0)
        self.assertTrue(any('WARNING: 0 per-option rule checks' in p for p in out['problems']))
        self.assertFalse(out['all_passed'])

    def test_render_check_text_findings_split_by_kind(self):
        report = self.tmp / 'qa2.json'
        qa_report(self.store, report, {'/x/p/m1.mp4': {'text': [
            {'status': 'FAIL', 'message': 'card "a," ends with "," (a transcript fragment, not a finished phrase)'},
            {'status': 'FAIL', 'message': 'label: text is white on a background of luminance 0.9: contrast 1.2:1 (needs 4.5:1)'},
            {'status': 'INFO', 'message': '3 on-screen string(s) linted'}]}})
        dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        rows = dg.read_answers(self.store, self.piece)
        by_rule = {dg.checks(self.store)[k[0]]['rule_id']: v['answer'] for k, v in rows.items()}
        self.assertEqual(by_rule, {'no-transcript-punctuation': 'fail', 'text-colour-contrast': 'fail', 'text-shadow-no-outline': 'pass', 'captions-placement': 'pass'})

    def test_render_check_unmatched_text_fail_fails_closed(self):
        report = self.tmp / 'qa3.json'
        qa_report(self.store, report, {'/x/p/m2.mp4': {'text': [{'status': 'FAIL', 'message': 'a brand new wording the check invented'}]}})
        self.answer_all(self.gate(options=['m2']))
        dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        rows = dg.read_answers(self.store, self.piece, True)
        by_rule = {dg.checks(self.store)[k[0]]['rule_id']: v for k, v in rows.items()}
        self.assertEqual(by_rule['text-must-earn-it']['answer'], 'fail')
        self.assertIn('unmapped finding', by_rule['text-must-earn-it']['evidence'])
        self.assertEqual(by_rule['no-transcript-punctuation']['answer'], 'pass')
        self.assertEqual([f['id'] for f in self.gate(options=['m2'])['failed_must']], ['S5.R30'])

    def test_render_check_not_measured_records_nothing(self):
        report = self.tmp / 'qa4.json'
        qa_report(self.store, report, {'/x/p/m3.mp4': {'dwell': [{'status': 'WARN', 'message': 'not measured', 'data': {'not_measured': True}}]}})
        self.assertEqual(dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')['recorded'], 0)

    def test_render_check_fail_with_not_measured_is_still_recorded(self):
        report = self.tmp / 'qa5.json'
        qa_report(self.store, report, {'/x/p/m4.mp4': {'type-sync': [
            {'status': 'FAIL', 'message': 'no key sound'}, {'status': 'WARN', 'message': 'u', 'data': {'not_measured': True}}]}})
        self.assertEqual(dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')['recorded'], 1)

    def test_a_check_that_differs_from_its_reviewed_pin_is_not_recorded_and_the_others_are(self):
        pins = dict(self.store.schema['delivery_gate']['film_qa_check_pins'], text='0' * 64)
        self.set_gate('film_qa_check_pins', pins)
        report = self.tmp / 'qa7.json'
        qa_report(self.store, report, {'/x/p/m6.mp4': {'text': [{'status': 'INFO', 'message': 'ok'}], 'in-frame': [{'status': 'INFO', 'message': 'ok'}]}})
        out = dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        self.assertIn('not the reviewed version', out['checks_not_recorded']['text'])
        self.assertEqual([r['check_id'] for r in out['rows']], ['S5.R19'])

    def test_a_dwell_pin_change_voids_dwell_rows_and_leaves_movement_rows_valid(self):
        self.answer_all(self.gate(options=['m6']))
        self.assertTrue(self.gate(options=['m6'])['all_passed'])
        self.set_gate('film_qa_check_pins', dict(self.store.schema['delivery_gate']['film_qa_check_pins'], dwell='1' * 64))
        ids = {i['id'] for i in dg.gate(self.store, self.piece, ['S5'], ['m6'])['unanswered_must']}
        self.assertEqual(ids, {'S5.R43'})
        self.assertNotIn('S5.R53', ids)       # movement

    def test_a_report_measured_by_another_version_of_one_check_skips_only_that_check(self):
        from rendercheck import config as fq_config, pins as fq_pins
        body = {'/x/p/m5.mp4': {'movement': [{'status': 'INFO', 'message': 'ok'}], 'in-frame': [{'status': 'INFO', 'message': 'ok'}]}}
        report = self.tmp / 'qa6.json'
        stale = dict(fq_pins.check_pins(fq_config.load(str(dg.render_check_limits(self.store)))), movement='2' * 64)
        qa_report(self.store, report, body, check_pins=stale)
        out = dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        self.assertIn('another version', out['checks_not_recorded']['movement'])
        self.assertEqual([r['check_id'] for r in out['rows']], ['S5.R19'])

    def test_render_check_result_from_other_limits_or_without_pins_is_refused(self):
        body = {'/x/p/m5.mp4': {'text': [{'status': 'INFO', 'message': 'ok'}]}}
        report = self.tmp / 'qa6.json'
        qa_report(self.store, report, body, limits_blake3='3' * 64)
        with self.assertRaisesRegex(ValueError, 'other limits'):
            dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        report.write_text(json.dumps(body))
        with self.assertRaisesRegex(ValueError, 'no _run check_pins record'):
            dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        qa_report(self.store, report, body)
        self.assertGreaterEqual(dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')['recorded'], 1)

    def test_render_check_measured_checks_count_only_on_its_own_rows(self):
        self.answer_all(self.gate(options=['m7']), machine_rows=False)     # an agent answers everything, including the measured rows
        ids = {i['id'] for i in self.gate(options=['m7'])['unanswered_must']}
        self.assertIn('S5.R19', ids)                 # in-frame
        self.assertIn('S5.R43', ids)                 # dwell-by-content
        self.assertNotIn('S5.R16', ids)
        with self.assertRaisesRegex(ValueError, 'reserved'):
            dg.record_answer(self.store, self.piece, 'S5.R19', 'pass', 'claimed in-frame is fine here', 'render-check', 'm7')
        report = self.tmp / 'qa8.json'
        qa_report(self.store, report, {'/x/p/m7.mp4': {'in-frame': [{'status': 'INFO', 'message': 'ok'}]}})
        dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        self.assertNotIn('S5.R19', {i['id'] for i in self.gate(options=['m7'])['unanswered_must']})

    def test_a_render_check_row_from_an_older_checker_does_not_count(self):
        self.answer_all(self.gate(options=['m8']))
        self.assertTrue(self.gate(options=['m8'])['all_passed'])
        dg.record_answer(self.store, self.piece, 'S5.R19', 'pass', 'old checker said fine here', 'render-check', 'm8', machine=True, check_pin='0' * 64)
        self.assertEqual([i['id'] for i in self.gate(options=['m8'])['unanswered_must']], ['S5.R19'])

    def test_text_must_earn_it_is_the_render_checks_answer_from_the_text_lint(self):
        self.answer_all(self.gate(options=['m9']), machine_rows=False)
        self.assertIn('S5.R30', {i['id'] for i in self.gate(options=['m9'])['unanswered_must']})      # an agent's claim does not count
        report = self.tmp / 'qa9.json'
        qa_report(self.store, report, {'/x/p/m9.mp4': {'text': [{'status': 'FAIL', 'message': 'a wording nobody mapped'}]}})
        dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        self.assertEqual([f['id'] for f in self.gate(options=['m9'])['failed_must'] if f['id'] == 'S5.R30'], ['S5.R30'])
        qa_report(self.store, report, {'/x/p/m9.mp4': {'text': [{'status': 'INFO', 'message': '7 on-screen string(s) linted'}]}})
        dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        self.assertIn('7 on-screen strings linted', dg.read_answers(self.store, self.piece, True)[('S5.R30', 'm9')]['evidence'])
        self.assertNotIn('S5.R30', {i['id'] for i in self.gate(options=['m9'])['unanswered_must']})

    def test_empty_set_skip_and_short_not_measured_blip_do_not_withhold_the_answer(self):
        report = self.tmp / 'qa10.json'
        qa_report(self.store, report, {'/x/p/m10.mp4': {
            'cutout-bottom': [{'status': 'INFO', 'message': 'no cut-out element in the spec', 'data': {'empty_set': True}}],
            'dwell': [{'status': 'INFO', 'message': 'graphic holds 6.5 s', 't': 7.0, 't_end': 13.0},
                      {'status': 'WARN', 'message': 'no text', 't': 6.24, 't_end': 6.74, 'data': {'not_measured': True}}]}})
        out = dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        by_rule = {dg.checks(self.store)[r['check_id']]['rule_id']: r['answer'] for r in out['rows']}
        self.assertEqual(by_rule['cutout-sits-on-frame'], 'pass')
        self.assertEqual(by_rule['dwell-by-content'], 'pass')
        qa_report(self.store, report, {'/x/p/m11.mp4': {'dwell': [{'status': 'WARN', 'message': 'no text', 't': 6.0, 't_end': 9.0, 'data': {'not_measured': True}}]}})
        self.assertEqual(dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')['recorded'], 0)

    def test_a_render_check_report_older_than_its_preview_is_refused(self):
        preview = self.tmp / 'm12.mp4'
        preview.write_bytes(b'x')
        report = self.tmp / 'qa11.json'
        qa_report(self.store, report, {str(preview): {'in-frame': [{'status': 'INFO', 'message': 'ok'}]}})
        later = datetime.now().timestamp() + 60
        os.utime(preview, (later, later))
        with self.assertRaisesRegex(ValueError, 'changed after'):
            dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')

    def test_a_render_check_report_on_a_non_shipped_copy_is_refused(self):
        (self.piece / 'previews').mkdir()
        (self.piece / 'work' / 'pending').mkdir(parents=True)
        shipped, pending = self.piece / 'previews' / 'm13.mp4', self.piece / 'work' / 'pending' / 'm13.mp4'
        shipped.write_bytes(b'x')
        pending.write_bytes(b'x')
        (self.piece / 'film-gate.json').write_text(json.dumps({'checklist_gate': {'option_globs': ['previews/*.mp4']}}))
        report = self.tmp / 'qa12.json'
        qa_report(self.store, report, {str(pending): {'in-frame': [{'status': 'INFO', 'message': 'ok'}]}})
        with self.assertRaisesRegex(ValueError, 'not a shipped preview'):
            dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')
        qa_report(self.store, report, {str(shipped): {'in-frame': [{'status': 'INFO', 'message': 'ok'}]}})
        self.assertEqual(dg.answers_from_render_check(self.store, self.piece, report, None, 'render-check')['recorded'], 1)

    def test_the_fact_gate_is_one_file_for_every_film_named_in_data_and_a_film_may_override_it(self):
        tool = dg.fact_gate_tool(self.store, self.piece)
        self.assertTrue(tool.is_file())
        self.assertFalse(tool.is_relative_to(self.piece))
        pin = dg.content_gate_pin(self.store, self.piece, 'fact-gate')
        (self.piece / 'film-gate.json').write_text(json.dumps({'checklist_gate': {'fact_gate': 'data/plans.json'}}))
        self.assertEqual(dg.fact_gate_tool(self.store, self.piece), self.root / 'data/plans.json')
        self.assertNotEqual(dg.content_gate_pin(self.store, self.piece, 'fact-gate'), pin)      # a row run by another gate does not count for this one

    def test_a_preview_finds_its_spec_through_the_films_spec_globs_newest_round_first(self):
        lane = self.piece / 'rough'
        for rnd in ('specs-round-9', 'specs-round-10'):
            (lane / rnd).mkdir(parents=True)
            (lane / rnd / 'cut.json').write_text('{}')
        self.assertEqual(dg.lane_spec(self.store, self.piece, lane, 'cut'), lane / 'specs-round-10' / 'cut.json')
        (lane / 'plans').mkdir()
        (lane / 'plans' / 'cut.spec.json').write_text('{}')
        (self.piece / 'film-gate.json').write_text(json.dumps({'checklist_gate': {'spec_globs': ['plans/{name}.spec.json']}}))
        self.assertEqual(dg.lane_spec(self.store, self.piece, lane, 'cut'), lane / 'plans' / 'cut.spec.json')
        self.assertIsNone(dg.lane_spec(self.store, self.piece, lane, 'other'))

    def sweep_lane(self):
        (self.piece / 'previews-round-9').mkdir()
        (self.piece / 'specs-round-9').mkdir()
        for o in ('m20-r9-1', 'm20-r9-2'):
            (self.piece / 'previews-round-9' / f'{o}.mp4').write_bytes(b'x')
            (self.piece / 'specs-round-9' / f'{o}.json').write_text('{}')
        self.stub('branch_rules', lambda store, rules_out=None: (rules_out and Path(rules_out).write_text('{"rows": []}'), {'verdict_ids': [], 'copy_blake3': 'c', 'verdict_blake3': 'v'})[1])

    def test_sweep_runs_the_render_check_over_every_option_and_records_its_own_row(self):
        self.sweep_lane()
        results = {name: [{'status': 'INFO', 'message': 'ok', 'data': {}}] for name in self.store.schema['delivery_gate']['film_qa_checks']}
        results['text'] = [{'status': 'INFO', 'message': '3 on-screen string(s) linted'}]
        results['cutout-bottom'] = [{'status': 'INFO', 'message': 'no cut-out element', 'data': {'empty_set': True}}]
        results['in-frame'] = [{'status': 'FAIL', 'message': 'card off the right edge'}]          # a fault in the second option only
        seen = []

        def fake_run(cmd, **kw):
            seen.append(cmd)
            if cmd[2] == 'review-pack':      # [python, check_a_rendered_video.py, command, folder, ...]
                for o in ('m20-r9-1', 'm20-r9-2'):
                    (Path(cmd[cmd.index('--out') + 1]) / o).mkdir(parents=True)
                return None
            out = Path(cmd[cmd.index('--json') + 1])
            body = {str(p): (results if p.stem == 'm20-r9-2' else {**results, 'in-frame': [{'status': 'INFO', 'message': 'ok'}]}) for p in sorted(Path(cmd[3]).glob('*.mp4'))}
            qa_report(self.store, out, body)
            return None
        self.stub('subprocess', type('S', (), {'run': staticmethod(fake_run)}))
        out = dg.sweep(self.store, self.piece, ['previews-round-9'])
        self.assertEqual(out['options'], ['m20-r9-1', 'm20-r9-2'])
        self.assertEqual([Path(p).name for p in out['review_packs']], ['m20-r9-1', 'm20-r9-2'])
        self.assertEqual(seen[0][1], str(dg.RENDER_CHECK / 'check_a_rendered_video.py'))      # the render check beside this tool
        self.assertEqual(Path(seen[0][seen[0].index('--limits') + 1]), self.root / 'data' / 'render-check-limits.json')
        self.assertEqual({(o['option'], rule) for rule, rows in out['faults_by_rule'].items() for o in rows if o['state'] == 'failed'}, {('m20-r9-2', 'S5.R19')})
        sweep_rows = {k: v for k, v in dg.read_answers(self.store, self.piece, True).items() if k[0] == 'S5.R55'}
        self.assertEqual(set(k[1] for k in sweep_rows), {'m20-r9-1', 'm20-r9-2'})
        self.assertTrue(all(v['by'] == 'sweep' for v in sweep_rows.values()))
        with self.assertRaisesRegex(ValueError, 'reserved'):
            dg.record_answer(self.store, self.piece, 'S5.R55', 'pass', 'I swept it myself honestly', 'sweep', 'm20-r9-1')

    def test_sweep_only_passes_option_ids_to_the_render_check_as_a_list(self):
        self.sweep_lane()
        seen = []
        self.stub('subprocess', type('S', (), {'run': staticmethod(lambda cmd, **kw: seen.append(cmd))}))
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            cli.main(['--library', str(self.root), '--schema', str(self.root / 'schema.json'), 'sweep', str(self.piece), '--previews', 'previews-round-9', '--only', 'm20-r9-1,m20-r9-2'])
        self.assertEqual(seen[0][seen[0].index('--ids') + 1], 'm20-r9-1,m20-r9-2')

    def lane(self, events, voice=None):
        lane = self.piece / 'options-ch9'
        (lane / 'specs-round-1').mkdir(parents=True)
        (lane / 'previews-round-1').mkdir()
        (lane / 'previews-round-1' / 'c9m01-r1-1.mp4').write_bytes(b'x')
        spec = {'events': events}
        if voice:
            (lane / 'v.words.json').write_text(json.dumps({'words': [{'text': w} for w in voice.split()]}))
            spec['voice'] = {'words': str(lane / 'v.words.json')}
        (lane / 'specs-round-1' / 'c9m01-r1-1.json').write_text(json.dumps(spec))
        return lane

    def in_craft(self, lane):
        os.makedirs(self.piece / 'craft', exist_ok=True)
        os.replace(lane, self.piece / 'craft' / 'options-ch9')
        return self.piece / 'craft' / 'options-ch9'

    def rows_of(self, option='c9m01-r1-1'):
        got = dg.read_answers(self.store, self.piece, True)
        return {dg.checks(self.store)[k[0]]['rule_id']: v for k, v in got.items() if k[1] == option and 'gate_run' in dg.checks(self.store)[k[0]]}

    def test_only_drawn_text_reaches_the_gates(self):
        lane = self.lane([
            {'type': 'marker_note', 'id': 'a', 'lines': ['line one', 'line two'], 'insert': {'text': 'inserted'}, 'face': 'Made-Bold.ttf', 'sounds': ['pop']},
            {'type': 'label_highlight', 'id': 'b', 'title': 'T', 'text': 'Made-up protein, the label', 'marks': [{'phrase': 'Made-up protein'}]},
            {'type': 'pictogram', 'id': 'c', 'icon': 'parcel', 'caption': {'text': 'cap', 'source': 'src'}},
            {'type': 'object_cutout', 'id': 'd', 'file': 'x.png'},
            {'type': 'callout', 'id': 'e', 'out_dir': 'W', 'labels': [{'text': 'shown label', 'at': 1.0}]},
            {'type': 'unlisted_type', 'id': 'f', 'label': 'a label', 'side': 'right', 'font': 'x.ttf'}])
        _, strings, _, unresolved = dg.option_words(self.store, self.piece, lane, 'c9m01-r1-1')
        self.assertEqual(unresolved, [])
        self.assertEqual(strings, ['shown label', 'line one', 'line two', 'inserted', 'T', 'Made-up protein, the label', 'cap', 'src', 'a label'])

    def test_a_pick_replaced_by_a_later_pick_of_the_same_moment_is_superseded_not_an_offender(self):
        lane = self.in_craft(self.lane([{'type': 'pause', 'at': 0.0}]))
        rows = [{'option_id': o, 'verdict': 'picked'} for o in ('m02-r2-2', 'm02-r4-2', 'm05-r2-1')]
        (self.piece / 'verdicts.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
        (self.piece / 'film-gate.json').write_text(json.dumps({'verdict_file': 'verdicts.jsonl', 'picked_verdicts': ['picked'], 'checklist_gate': {'option_globs': ['craft/options-ch9/previews*/*.mp4']}}))
        (lane / 'ROUND 1 - watch these').mkdir()
        for k, o in enumerate(('m02-r2-2', 'm05-r2-1')):
            (lane / 'previews-round-1' / f'{o}.mp4').write_bytes(b'a' * (k + 1))
            os.link(lane / 'previews-round-1' / f'{o}.mp4', lane / 'ROUND 1 - watch these' / f'{o}.mp4')
        out = dg.audit_watch(self.store, self.piece, False)
        self.assertEqual([p['option'] for p in out['superseded_picks']], ['m02-r2-2'])
        self.assertEqual([o['option'] for o in out['offenders']], ['m05-r2-1'])

    def test_scope_options_is_the_latest_round_plus_live_picks(self):
        lane = self.in_craft(self.lane([{'type': 'pause', 'at': 0.0}]))
        (lane / 'previews-round-2').mkdir()
        for name, rnd in (('m02-r1-1', 1), ('m02-r2-1', 2), ('m05-r1-1', 1), ('m05-r2-1', 2), ('m09-r1-1', 1), ('m09-r2-1', 2)):
            (lane / f'previews-round-{rnd}' / f'{name}.mp4').write_bytes(b'x')
        rows = [{'option_id': o, 'verdict': 'picked'} for o in ('m02-r1-1', 'm05-r1-1', 'm05-r2-1')]
        (self.piece / 'verdicts.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
        (self.piece / 'film-gate.json').write_text(json.dumps({'verdict_file': 'verdicts.jsonl', 'picked_verdicts': ['picked'], 'checklist_gate': {'option_globs': ['craft/options-ch9/previews*/*.mp4']}}))
        self.assertEqual(dg.scope_options(self.store, self.piece, 'options-ch9'), ['m02-r1-1', 'm02-r2-1', 'm05-r2-1', 'm09-r2-1'])
        self.assertEqual(dg.scope_options(self.store, self.piece, 'options-ch1'), [])

    def test_a_round_one_pick_without_a_round_tail_and_a_renumbered_moment_are_superseded_too(self):
        lane = self.in_craft(self.lane([{'type': 'pause', 'at': 0.0}]))
        (lane / 'previews-round-2').mkdir()
        (lane / 'previews-round-3').mkdir()
        for name, rnd in (('m12-3', 1), ('m12-3-r2', 2), ('m07-1', 1), ('m11-r3-1', 3), ('m04-1', 1), ('m20-r3-1', 3)):
            (lane / f'previews-round-{rnd}' / f'{name}.mp4').write_bytes(b'x')
        rows = [{'option_id': o, 'verdict': 'picked'} for o in ('m12-3', 'm12-3-r2', 'm07-1', 'm11-r3-1', 'm04-1')]
        (self.piece / 'verdicts.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
        (self.piece / 'film-gate.json').write_text(json.dumps({'verdict_file': 'verdicts.jsonl', 'picked_verdicts': ['picked'], 'checklist_gate': {'option_globs': ['craft/options-ch9/previews*/*.mp4']}}))
        self.assertEqual(dg.option_moment_round(self.store, 'm12-3', {}), ('m12', 1))
        self.assertEqual(dg.option_moment_round(self.store, 'm07-1', {'m07-1': 'm11'}), ('m11', 1))
        self.assertEqual(dg.scope_options(self.store, self.piece, 'options-ch9'), ['m04-1', 'm07-1', 'm11-r3-1', 'm12-3-r2', 'm20-r3-1'])
        self.store.schema['delivery_gate']['moment_aliases'] = {'m07-1': 'm11'}
        self.assertEqual(dg.scope_options(self.store, self.piece, 'options-ch9'), ['m04-1', 'm11-r3-1', 'm12-3-r2', 'm20-r3-1'])

    def test_an_event_that_should_draw_text_but_resolves_to_none_is_not_measured_and_records_no_row(self):
        lane = self.lane([{'type': 'pullquote', 'id': 'q', 'lines': ['You should share'], 'underline': {'phrase': 'share'}}, {'type': 'wordtext', 'id': 'w', 'at': 0.5}])
        _, strings, _, unresolved = dg.option_words(self.store, self.piece, lane, 'c9m01-r1-1')
        self.assertEqual(strings, ['You should share'])
        self.assertEqual(unresolved, ['wordtext "w"'])
        out = dg.content_gates(self.store, self.piece, lane, None)
        self.assertIn('not_measured', out['rows'][0])
        self.assertFalse(out['all_passed'])
        self.assertEqual(self.rows_of(), {})

    def test_audit_watch_lists_and_holds_linked_files_of_open_options_only(self):
        lane = self.in_craft(self.lane([{'type': 'pause', 'at': 0.0}]))
        (self.piece / 'film-gate.json').write_text(json.dumps({'checklist_gate': {'option_globs': ['craft/options-ch9/previews*/*.mp4']}}))
        preview = lane / 'previews-round-1' / 'c9m01-r1-1.mp4'
        whole = self.piece / 'craft' / 'WHOLE FILM - every option in film order'
        watch = lane / 'ROUND 1 - watch these'
        for d in (whole, watch):
            d.mkdir()
            os.link(preview, d / '01 x.mp4')
        out = dg.audit_watch(self.store, self.piece, False)
        self.assertFalse(out['all_passed'])
        self.assertEqual(len(out['offenders']), 2)
        self.assertTrue(preview.exists() and (watch / '01 x.mp4').exists())
        out = dg.audit_watch(self.store, self.piece, True)
        self.assertEqual(len(out['moved_to_held_back']), 2)
        self.assertTrue(all('/options-ch9/held-back-from-watch/' in p for p in out['moved_to_held_back']))
        self.assertTrue(preview.exists() and not (watch / '01 x.mp4').exists())
        self.assertEqual(dg.audit_watch(self.store, self.piece, False)['linked_files_audited'], 0)

    def test_audit_watch_skips_older_rounds_unless_picked_and_separates_waits_for_the_person(self):
        lane = self.in_craft(self.lane([{'type': 'pause', 'at': 0.0}]))
        (lane / 'previews-round-1' / 'c9m02-r1-1.mp4').write_bytes(b'y')
        (self.piece / 'verdicts.jsonl').write_text(json.dumps({'option_id': 'c9m02-r1-1', 'verdict': 'picked'}) + '\n')
        (self.piece / 'film-gate.json').write_text(json.dumps({'verdict_file': 'verdicts.jsonl', 'picked_verdicts': ['picked'], 'checklist_gate': {'option_globs': ['craft/options-ch9/previews*/*.mp4']}}))
        for rnd, opt in ((1, 'c9m01-r1-1'), (2, 'c9m03-r1-1')):
            (lane / 'previews-round-1' / f'{opt}.mp4').write_bytes(b'z' * rnd)
        (lane / 'ROUND 1 - watch these').mkdir()
        (lane / 'ROUND 2 - watch these').mkdir()
        os.link(lane / 'previews-round-1' / 'c9m01-r1-1.mp4', lane / 'ROUND 1 - watch these' / 'old.mp4')           # older round, not a pick
        os.link(lane / 'previews-round-1' / 'c9m02-r1-1.mp4', lane / 'ROUND 1 - watch these' / 'picked.mp4')        # older round, a pick
        os.link(lane / 'previews-round-1' / 'c9m03-r1-1.mp4', lane / 'ROUND 2 - watch these' / 'new.mp4')           # latest round
        out = dg.audit_watch(self.store, self.piece, False)
        self.assertEqual(out['superseded_not_audited']['files'], 1)
        self.assertEqual({o['option'] for o in out['offenders']}, {'c9m02-r1-1', 'c9m03-r1-1'})
        item = lambda opt, i, ev='': {'id': i, 'option': opt, 'check': 'c', 'verify': 'v', 'answer_with': 'a', 'evidence': ev}
        self.stub('gate', lambda *a, **k: {'unanswered_must': [item('c9m02-r1-1', 'S5.R19')], 'failed_must': [item('c9m03-r1-1', 'S5.G01', 'copy gate onscreen 3 line(s): UNCERTAIN (waits for the person) x')]})
        out = dg.audit_watch(self.store, self.piece, True)
        self.assertEqual([o['option'] for o in out['waits_for_the_person']], ['c9m03-r1-1'])
        self.assertEqual([o['option'] for o in out['offenders']], ['c9m02-r1-1'])
        self.assertEqual(len(out['moved_to_held_back']), 1)
        self.assertTrue((lane / 'ROUND 2 - watch these' / 'new.mp4').exists())                  # waiting on the person: never held
        self.assertTrue((lane / 'ROUND 1 - watch these' / 'old.mp4').exists())                  # superseded: never held

    def test_audit_watch_prints_waits_for_picked_designs_and_hold_never_moves_them(self):
        lane = self.in_craft(self.lane([{'type': 'pause', 'at': 0.0}]))
        (self.piece / 'film-gate.json').write_text(json.dumps({'checklist_gate': {'option_globs': ['craft/options-ch9/previews*/*.mp4']}}))
        (lane / 'ROUND 1 - watch these').mkdir()
        os.link(lane / 'previews-round-1' / 'c9m01-r1-1.mp4', lane / 'ROUND 1 - watch these' / 'rebuild.mp4')
        wait = {'id': 'S5.R62', 'option': 'c9m01-r1-1', 'check': 'world-class-craft-bar', 'verify': 'v', 'answer_with': 'a', 'evidence': 'reads as a rushed edit at 0:12', 'rebuild_of': 'c9m01-r0-1'}
        self.stub('gate', lambda *a, **k: {'unanswered_must': [], 'failed_must': [], 'waits_for_the_person_picked_design': [wait]})
        out = dg.audit_watch(self.store, self.piece, True)
        self.assertEqual((out['offenders'], out['moved_to_held_back']), ([], []))
        self.assertTrue((lane / 'ROUND 1 - watch these' / 'rebuild.mp4').exists())
        entry = out['waits_for_the_person_picked_design'][0]
        self.assertEqual((entry['option'], entry['rebuild_of'], [r['id'] for r in entry['rules']]), ('c9m01-r1-1', 'c9m01-r0-1', ['S5.R62']))
        self.assertEqual(len(entry['files']), 1)

    def test_an_option_with_no_string_and_no_spoken_line_passes_copy_and_fact_gates_as_an_empty_set_and_its_spec_is_still_judged(self):
        lane = self.lane([{'type': 'pause', 'at': 0.0}])
        self.stub('run_check_mjs', novel_artifact)
        rows = {r['check']: r['answer'] for r in dg.content_gates(self.store, self.piece, lane, None, 'review')['rows']}
        self.assertEqual(rows, {'copy-gate': 'pass', 'verdict-rules': 'advisory', 'fact-gate': 'pass'})
        self.assertIn('empty set', self.rows_of()['copy-gate']['evidence'])

    def test_a_spec_nothing_of_the_persons_names_is_held_at_review_and_fails_at_final_never_a_pass_on_silence(self):
        lane = self.lane([{'type': 'pause', 'at': 0.0}])      # the real copy check, on the made-up branch: no row of theirs names option-spec
        got = {stage: {r['check']: r for r in dg.content_gates(self.store, self.piece, lane, None, stage)['rows']}['verdict-rules'] for stage in ('review', 'final')}
        self.assertEqual((got['review']['answer'], got['final']['answer']), ('advisory', 'fail'), got)
        self.assertIn('novel-no-verdict-no-row', self.rows_of()['verdict-rules']['evidence'])
        self.assertEqual(sorted(p.name for p in (lane / 'specs-round-1').iterdir()), ['c9m01-r1-1.json'])      # the check's result never lands beside the spec

    def test_the_verdict_rules_row_runs_their_rows_on_the_spec_at_the_stage_and_records_it_by_verdict_rules(self):
        lane = self.lane([{'type': 'pause', 'at': 0.0}])
        seen = []
        self.stub('run_check_mjs', lambda store, file, extra, held=False, only=None, exclude=None: (seen.append((extra, only)), ('fail', 'FAIL "plan" (too-many)'))[1])
        out = dg.content_gates(self.store, self.piece, lane, None, 'review')
        self.assertFalse(out['all_passed'])
        row = self.rows_of()['verdict-rules']
        self.assertEqual((row['answer'], row['by']), ('fail', 'verdict-rules'))
        self.assertEqual(len(seen), 1)       # the spec is the only artifact: no on-screen string and no spoken line
        self.assertEqual(seen[0][0], ['--artifact-kind', 'option-spec', '--stage', 'review'])
        self.assertEqual(seen[0][1], {'their-leverage', 'their-teapot', 'their-stance', 'novel-no-verdict-no-row'})      # read from the branch, never a file

    def test_an_unknown_delivery_stage_is_refused_by_content_gates(self):
        lane = self.lane([{'type': 'pause', 'at': 0.0}])
        with self.assertRaises(ValueError):
            dg.content_gates(self.store, self.piece, lane, None, 'someday')

    def test_the_verdict_rules_pin_follows_their_rows_and_the_checker(self):
        pin = dg.content_gate_pin(self.store, self.piece, 'verdict-rules')
        copy_pin = dg.content_gate_pin(self.store, self.piece, 'copy-gate')
        self.assertNotEqual(pin, copy_pin)
        self.assertEqual(pin, dg.content_gate_pin(self.store, self.piece, 'verdict-rules'))
        records = json.loads((self.root / 'data' / 'check-records.json').read_text())
        next(r for r in records if r['id'] == 'record:check:their-teapot')['value']['words'] = ['kettle']
        changed = self.root / 'data' / 'check-records-2.json'
        changed.write_text(json.dumps(records))
        self.store.gate_run = {'door': ['--door-records', str(changed)]}
        self.assertNotEqual(dg.content_gate_pin(self.store, self.piece, 'verdict-rules'), pin)      # a verdict row changed: its rows no longer count
        self.assertEqual(dg.content_gate_pin(self.store, self.piece, 'copy-gate'), copy_pin)       # the generic rows did not
        self.store.gate_run = {}
        self.assertIsNone(dg.content_gate_pin(self.store, self.piece, 'copy-gate'))                 # no door: the pin cannot be known

    def copy_row(self, answer, evidence):
        lane = getattr(self, '_copy_lane', None) or self.lane([{'type': 'wordtext', 'id': 'w', 'at': 0.5, 'text': 'tofu ice cream'}])
        self._copy_lane = lane
        self.stub('run_copy_gate', lambda store, strings, voice, stage, plan=None: (answer, evidence))
        self.stub('run_fact_gate', lambda *args: ('pass', 'stub fact gate'))
        self.stub('run_verdict_rules', lambda *args: ('pass', 'stub verdict rows'))
        dg.content_gates(self.store, self.piece, lane, None)
        return {stage: dg.gate(self.store, self.piece, ['S5'], ['c9m01-r1-1'], at=stage) for stage in ('review', 'final')}

    def test_a_line_uncertain_only_from_unqualified_decider_rows_is_advisory_at_review_and_fails_at_final(self):
        answer, detail = dg.copy_gate_verdict([{'text': 'Hold on.', 'verdict': 'uncertain', 'advisory': True, 'breaks': [],
                                                'uncertain': [{'rule': 'decider-x-38', 'p_fail': 0.97, 'qualified': False}]}])
        self.assertEqual((answer, detail), ('advisory', 'ADVISORY (decider not qualified) "Hold on." (decider-x-38 0.97)'))
        got = self.copy_row(answer, f'copy gate onscreen 1 line(s): {detail}')
        self.assertNotIn('S5.G01', {i['id'] for i in got['review']['failed_must']})
        self.assertEqual([(i['id'], i['option']) for i in got['review']['advisory']], [('S5.G01', 'c9m01-r1-1')])
        self.assertIn('decider-x-38 0.97', got['review']['advisory'][0]['pick_line'])
        self.assertIn('S5.G01', {i['id'] for i in got['final']['failed_must']})
        self.assertEqual(got['final']['advisory'], [])

    def test_a_judge_word_hit_or_a_qualified_uncertain_line_fails_at_review_and_at_final(self):
        for results in ([{'text': 'Density is a dial.', 'verdict': 'fail', 'breaks': [{'rule': 'no-abstract-agent'}], 'uncertain': [], 'advisory': False}],
                        [{'text': 'Hold on.', 'verdict': 'uncertain', 'advisory': False, 'breaks': [], 'uncertain': [{'rule': 'decider-x-38', 'p_fail': 0.99}]}],
                        [{'text': 'Ok.', 'verdict': 'pass', 'breaks': [], 'uncertain': []}, {'text': 'add', 'verdict': 'fail', 'breaks': [{'rule': 'no-hedge'}], 'uncertain': []}]):
            answer, detail = dg.copy_gate_verdict(results)
            self.assertEqual(answer, 'fail')
            got = self.copy_row(answer, f'copy gate onscreen: {detail}')
            for stage in ('review', 'final'):
                self.assertIn('S5.G01', {i['id'] for i in got[stage]['failed_must']}, stage)

    def test_advisory_is_a_machine_answer_on_an_advisory_check_only(self):
        with self.assertRaisesRegex(ValueError, 'answer must be one of'):
            dg.record_answer(self.store, self.piece, 'S5.G01', 'advisory', 'I think it is fine', 'agent', 'c9m01-r1-1')
        with self.assertRaisesRegex(ValueError, 'no delivery stage'):
            dg.record_answer(self.store, self.piece, 'S5.G02', 'advisory', 'fact gate said so', 'fact-gate', 'c9m01-r1-1', machine=True)
        with self.assertRaisesRegex(ValueError, 'unknown delivery stage'):
            dg.gate(self.store, self.piece, ['S5'], ['c9m01-r1-1'], at='someday')

    def test_their_recorded_lines_and_the_inserted_asker_line_are_both_checked_when_the_spec_names_its_whole_spoken_track(self):
        lane = self.lane([{'type': 'pause', 'at': 0.0}], voice='Where do I start?')       # voice: the inserted asker line only
        spec_file = lane / 'specs-round-1' / 'c9m01-r1-1.json'
        (lane / 'all.words.json').write_text(json.dumps({'words': [{'text': w} for w in 'The world becomes clear. Where do I start?'.split()]}))
        spec_file.write_text(json.dumps({**json.loads(spec_file.read_text()), 'spoken': {'words': str(lane / 'all.words.json')}, 'plan': 'films/fixture/plans/c9m01.json'}))
        self.assertEqual(dg.option_words(self.store, self.piece, lane, 'c9m01-r1-1')[2], 'The world becomes clear. Where do I start?')
        seen = []
        self.stub('run_check_mjs', lambda store, file, extra, held=False, only=None, exclude=None: (seen.append((Path(file).read_text(), extra, exclude)), ('pass', 'pass'))[1])
        dg.content_gates(self.store, self.piece, lane, None, 'review')
        copy_voice = [text for text, extra, exclude in seen if extra[:2] == ['--kind', 'voiceover'] and exclude is not None]
        self.assertEqual(copy_voice, ['The world becomes clear.\nWhere do I start?\n'])      # both lines, bound to the plan's spans
        spec_file.write_text(json.dumps({k: v for k, v in json.loads(spec_file.read_text()).items() if k != 'spoken'}))
        self.assertEqual(dg.option_words(self.store, self.piece, lane, 'c9m01-r1-1')[2], 'Where do I start?')      # no whole track: its inserted voice

    def test_a_word_their_verdict_row_rejects_in_their_own_spoken_line_fails_the_cut_through_their_verdict_rows(self):
        lane = self.lane([{'type': 'pause', 'at': 0.0}], voice='Where do I start?')
        spec_file = lane / 'specs-round-1' / 'c9m01-r1-1.json'
        (lane / 'all.words.json').write_text(json.dumps({'words': [{'text': w} for w in 'You can leverage those insights later. Where do I start?'.split()]}))
        spec_file.write_text(json.dumps({**json.loads(spec_file.read_text()), 'spoken': {'words': str(lane / 'all.words.json')}}))
        self.stub('run_fact_gate', lambda *args: ('pass', 'stub fact gate'))
        for stage in ('review', 'final'):
            row = {r['check']: r for r in dg.content_gates(self.store, self.piece, lane, None, stage)['rows']}['verdict-rules']
            self.assertEqual(row['answer'], 'fail', (stage, row))
            self.assertIn('their-leverage', self.rows_of()['verdict-rules']['evidence'])

    def test_a_copy_rule_fault_fails_the_copy_gate_only_one_cause_one_row(self):
        lane = self.lane([{'type': 'wordtext', 'id': 'w', 'at': 0.5, 'text': 'A glorp line.'}])      # a generic row of the branch above the person's
        self.stub('run_fact_gate', lambda *args: ('pass', 'stub fact gate'))
        rows = {r['check']: r['answer'] for r in dg.content_gates(self.store, self.piece, lane, None, 'review')['rows']}
        self.assertEqual(rows['copy-gate'], 'fail')
        self.assertNotEqual(rows['verdict-rules'], 'fail', self.rows_of()['verdict-rules']['evidence'])
        self.assertNotIn('no-glorp', self.rows_of()['verdict-rules']['evidence'])

    def test_the_copy_gate_binds_each_line_to_the_plan_the_cut_was_built_from(self):
        lane = self.lane([{'type': 'wordtext', 'id': 'w', 'at': 0.5, 'text': 'tofu ice cream'}], voice='The world becomes clear.')
        spec_file = lane / 'specs-round-1' / 'c9m01-r1-1.json'
        spec_file.write_text(json.dumps({**json.loads(spec_file.read_text()), 'plan': 'films/fixture/plans/c9m01.json'}))
        seen = []
        self.stub('run_check_mjs', lambda store, file, extra, held=False, only=None, exclude=None: (seen.append(extra), ('pass', 'pass'))[1])
        self.stub('run_fact_gate', lambda *args: ('pass', 'stub fact gate'))
        dg.content_gates(self.store, self.piece, lane, None)
        line_runs = [extra for extra in seen if '--artifact-kind' not in extra]
        self.assertEqual(len(line_runs), 4)        # on-screen strings and the spoken line, by the copy row and by the verdict row
        self.assertTrue(all(extra[-2:] == ['--plan', 'films/fixture/plans/c9m01.json'] for extra in line_runs), line_runs)

    def test_content_gate_rows_come_only_from_the_gates_and_an_agent_cannot_write_them(self):
        with self.assertRaisesRegex(ValueError, 'reserved'):
            dg.record_answer(self.store, self.piece, 'S5.G01', 'pass', 'I ran the gate honestly', 'copy-gate', 'c9m01-r1-1')

    def test_an_option_with_words_and_no_fact_claims_fails_the_fact_row_and_blocks_the_gate(self):
        lane = self.lane([{'type': 'wordtext', 'id': 'w', 'at': 0.5, 'text': 'tofu ice cream'}], voice='Hold on.')
        self.stub('run_copy_gate', lambda store, strings, voice, stage, plan=None: ('pass', f'stub copy gate {len(strings)} string(s), voice {voice!r}'))
        out = dg.content_gates(self.store, self.piece, lane, None)
        rows = self.rows_of()
        self.assertEqual(rows['copy-gate']['answer'], 'pass')
        self.assertEqual(rows['fact-gate']['answer'], 'fail')
        self.assertIn('no shots and claims file', rows['fact-gate']['evidence'])
        self.assertFalse(out['all_passed'])
        self.assertIn('S5.G02', {i['id'] for i in dg.gate(self.store, self.piece, ['S5'], ['c9m01-r1-1'])['failed_must']})

    def test_a_fact_shot_that_lacks_the_rendered_words_or_line_fails_and_one_that_carries_them_runs_the_fact_gate(self):
        lane = self.lane([{'type': 'wordtext', 'id': 'w', 'at': 0.5, 'text': 'tofu ice cream'}], voice='Hold on.')
        (lane / 'fact' / 'shots').mkdir(parents=True)
        (lane / 'fact' / 'claims').mkdir()
        (lane / 'fact' / 'claims' / 'c9m01.json').write_text('{"ok": true}')
        (lane / 'fact' / 'shots' / 'c9m01.json').write_text(json.dumps({'voice': {'script': 'c9m01.txt'}, 'events': [{'type': 'text', 'text': 'something else'}]}))
        answer, ev = dg.run_fact_gate(self.store, self.piece, lane, 'c9m01-r1-1', ['tofu ice cream'], 'Hold on.')
        self.assertEqual(answer, 'fail')
        self.assertIn('does not carry the on-screen string', ev)
        (lane / 'fact' / 'shots' / 'c9m01.json').write_text(json.dumps({'voice': {'script': 'c9m01.txt'}, 'events': [{'type': 'text', 'text': 'tofu ice cream'}]}))
        (lane / 'fact' / 'c9m01.txt').write_text('Another line.')
        self.assertIn('not the line the spec speaks', dg.run_fact_gate(self.store, self.piece, lane, 'c9m01-r1-1', ['tofu ice cream'], 'Hold on.')[1])
        (lane / 'fact' / 'c9m01.txt').write_text('[calm] Hold on.')
        self.assertEqual(dg.run_fact_gate(self.store, self.piece, lane, 'c9m01-r1-1', ['tofu ice cream'], 'Hold on.'), ('pass', 'fact gate c9m01: c9m01: every claim sourced'))
        (lane / 'fact' / 'claims' / 'r1-c9m01-r1-1.json').write_text('{}')      # the round layout is tried after the lane's own

    def test_a_round_option_finds_its_fact_files_in_the_round_layout(self):
        roots = dg.fact_layouts(self.store, self.piece, self.piece / 'options-ch9', 'c9m01-r3-2')
        self.assertEqual(roots, [(self.piece / 'options-ch9' / 'fact', ['c9m01-r3-2', 'c9m01']), (self.piece / 'narrator', ['r3-c9m01-r3-2'])])
        self.assertEqual(len(dg.fact_layouts(self.store, self.piece, self.piece / 'options-ch9', 'c9m01')), 1)      # no round: the round layout is not tried


class FilmDefaults(Base):
    """A folder under the films folder with no config file is still a film: film_defaults name its previews, and audit-watch --file judges a file before it is shown."""
    answer_all = Base.answer_all

    def setUp(self):
        super().setUp()
        (self.piece / 'SCRIPT.md').write_text(HEADER.replace('voice clone music sfx sound rebuilt example hf ref changes', 'hf'))
        (self.piece / 'film-gate.json').unlink()
        r3 = self.piece / 'rough' / 'r3'
        (self.piece / 'rough' / 'work' / 'r3' / 'a').mkdir(parents=True)
        r3.mkdir(parents=True)
        for name in ('a', 'b', '_ALL'):
            (r3 / f'{name}.mp4').write_bytes(name.encode())
        (self.piece / 'rough' / 'work' / 'r3' / 'a' / 'seg.mp4').write_bytes(b's')
        self.r3 = r3

    def audit(self, *names):
        return dg.audit_watch(self.store, self.piece, False, [self.r3 / n for n in names])

    def answer_options(self, *options):
        self.answer_all(dg.gate(self.store, self.piece, ['S5', 'S6'], list(options), at='review'))

    def test_defaults_name_the_previews_and_leave_work_files_out(self):
        self.assertEqual(dg.film_config(self.store, self.piece), dg.gate_cfg(self.store)['film_defaults'])
        self.assertEqual([p.name for p in dg.film_previews(self.store, self.piece)], ['_ALL.mp4', 'a.mp4', 'b.mp4'])
        self.assertEqual(dg.film_config(self.store, self.root / 'data'), {})      # not under the films folder: not a film

    def test_an_unchecked_file_is_an_offender_and_a_checked_one_passes(self):
        out = self.audit('a.mp4')
        self.assertFalse(out['all_passed'])
        self.assertEqual(out['offenders'][0]['option'], 'rough/r3/a')
        self.answer_options('rough/r3/a')
        self.assertTrue(self.audit('a.mp4')['all_passed'])

    def test_a_compilation_stands_for_every_preview_in_its_folder(self):
        self.answer_options('rough/r3/a')
        out = self.audit('_ALL.mp4')
        self.assertFalse(out['all_passed'])
        self.assertEqual({o['option'] for o in out['offenders']}, {'rough/r3/b'})
        self.answer_options('rough/r3/b')
        self.assertTrue(self.audit('_ALL.mp4')['all_passed'])

    def test_a_path_option_id_finds_its_spec_in_the_lane_by_file_name(self):
        (self.piece / 'rough' / 'specs-round-3').mkdir()
        (self.piece / 'rough' / 'specs-round-3' / 'a.json').write_text(json.dumps({'events': [{'type': 'pause', 'at': 0.0}]}))
        self.stub('run_check_mjs', novel_artifact)
        out = dg.content_gates(self.store, self.piece, self.piece / 'rough', ['rough/r3/a'], 'review')
        self.assertEqual({(r['option'], r['check'], r['answer']) for r in out['rows']},
                         {('rough/r3/a', 'copy-gate', 'pass'), ('rough/r3/a', 'verdict-rules', 'advisory'), ('rough/r3/a', 'fact-gate', 'pass')})

    def test_a_file_that_is_no_shipped_preview_is_an_offender(self):
        out = dg.audit_watch(self.store, self.piece, False, [self.piece / 'rough' / 'work' / 'r3' / 'a' / 'seg.mp4'])
        self.assertFalse(out['all_passed'])
        self.assertIn('not a shipped preview', out['offenders'][0]['rows'][0])

    def test_a_row_on_other_bytes_is_stale_and_a_touch_alone_is_not(self):
        self.answer_options('rough/r3/a')
        later = datetime.now().timestamp() + 60
        os.utime(self.r3 / 'a.mp4', (later, later))
        self.assertTrue(self.audit('a.mp4')['all_passed'])      # rows pin the bytes they judged; a new change time with the same bytes changes nothing
        (self.r3 / 'a.mp4').write_bytes(b'a re-rendered')
        out = self.audit('a.mp4')
        self.assertFalse(out['all_passed'])
        self.assertTrue(any(r.endswith('(stale)') for r in out['offenders'][0]['rows']))

    def test_the_gate_applies_the_same_staleness_as_audit_watch(self):
        self.answer_options('rough/r3/a')
        self.assertTrue(dg.gate(self.store, self.piece, ['S5', 'S6'], ['rough/r3/a'], at='review')['all_passed'])
        (self.r3 / 'a.mp4').write_bytes(b'a re-rendered')
        out = dg.gate(self.store, self.piece, ['S5', 'S6'], ['rough/r3/a'], at='review')
        self.assertFalse(out['all_passed'])
        self.assertTrue(out['unanswered_must'] and all('other bytes' in item['stale'] for item in out['unanswered_must']), out['unanswered_must'][:2])

    def test_a_piece_level_row_goes_stale_when_any_file_it_covers_changes(self):
        self.answer_options('rough/r3/a', 'rough/r3/b')
        both = ['rough/r3/a', 'rough/r3/b']
        self.assertTrue(dg.gate(self.store, self.piece, ['S5', 'S6'], both, at='review')['all_passed'])
        (self.r3 / 'b.mp4').write_bytes(b'b re-rendered')
        out = dg.gate(self.store, self.piece, ['S5', 'S6'], both, at='review')
        piece_rows = [item for item in out['unanswered_must'] if item['option'] is None]
        self.assertTrue(piece_rows and all('rough/r3/b' in item['stale'] for item in piece_rows), out['unanswered_must'][:3])
        self.assertEqual({item['option'] for item in out['unanswered_must']}, {None, 'rough/r3/b'})      # a's own rows still hold

    def test_a_row_written_before_rows_carried_pins_is_judged_by_time(self):
        self.answer_options('rough/r3/a')
        path = dg.answers_file(self.store, self.piece)
        rows = [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
        path.write_text(''.join(json.dumps({k: v for k, v in r.items() if k != 'file_pins'}) + '\n' for r in rows))
        self.assertTrue(self.audit('a.mp4')['all_passed'])
        later = datetime.now().timestamp() + 60
        os.utime(self.r3 / 'a.mp4', (later, later))
        self.assertFalse(self.audit('a.mp4')['all_passed'])

    def test_people_comes_from_the_render_checks_face_output_and_is_unknown_until_it_ran(self):
        tags = lambda: dg.gate(self.store, self.piece, ['S5'], ['rough/r3/a'], at='review')
        out = tags()
        face_rows = lambda out: {i['id'] for i in out['unanswered_must']} & {'S5.R40', 'S5.R66', 'S5.Q07'}
        self.assertEqual(out['flags_unknown'], {'rough/r3/a': ['people']})       # no report yet: unknown, so people rows route as open
        self.assertIn('people', out['tags'])
        self.assertEqual(face_rows(out), {'S5.R40', 'S5.R66', 'S5.Q07'})
        report = self.piece / 'rough' / 'work' / 'r3' / 'a' / 'render-check.json'
        report.write_text(json.dumps({str(self.r3 / 'a.mp4'): {'face': [{'check': 'face', 'status': 'WARN', 'message': 'no face found', 'data': {'not_measured': True}}]}}))
        out = tags()
        self.assertEqual((out['flags_unknown'], 'people' in out['tags'], face_rows(out)), ({}, False, set()))      # no face found: no face rows
        report.write_text(json.dumps({str(self.r3 / 'a.mp4'): {'face': [{'check': 'face', 'status': 'INFO', 'message': 'face box found in 9/10 frames', 'data': {}}]}}))
        out = tags()
        self.assertEqual((out['flags_unknown'], 'people' in out['tags'], face_rows(out)), ({}, True, {'S5.R40', 'S5.R66', 'S5.Q07'}))       # a face found proves people
        older = datetime.now().timestamp() - 3600
        os.utime(report, (older, older))
        self.assertEqual(tags()['flags_unknown'], {'rough/r3/a': ['people']})       # a report older than the file judged other bytes

    def test_a_flag_its_spec_proves_routes_its_rows_though_the_header_omits_it(self):
        sfx_rows = lambda: {i['id'] for i in dg.gate(self.store, self.piece, ['S6'], ['rough/r3/a'], at='review')['unanswered_must']} & {'S6.R01', 'S6.3'}
        self.assertEqual(sfx_rows(), set())
        (self.piece / 'rough' / 'specs-round-3').mkdir(parents=True)
        (self.piece / 'rough' / 'specs-round-3' / 'a.json').write_text(json.dumps({'events': [{'type': 'slip', 'sounds': {'enter': ['paper']}}]}))
        self.assertEqual(sfx_rows(), {'S6.R01', 'S6.3'})      # a placed sound proves sfx: the header can add flags, never remove a proven one

    def test_a_missing_piece_header_holds_every_file(self):
        self.answer_options('rough/r3/a')
        (self.piece / 'SCRIPT.md').unlink()
        out = self.audit('a.mp4')
        self.assertFalse(out['all_passed'])
        self.assertTrue(any('Piece header' in r for r in out['offenders'][0]['rows']))

    def test_a_piece_with_no_header_or_no_medium_fails_with_routes_undeclared(self):
        (self.piece / 'SCRIPT.md').unlink()
        out = dg.gate(self.store, self.piece, ['S1'], [], at='review')
        self.assertFalse(out['all_passed'])
        self.assertTrue(out['problems'][0].startswith('routes undeclared'))
        (self.piece / 'SCRIPT.md').write_text(HEADER.replace('medium:           video\n', ''))
        out = dg.gate(self.store, self.piece, ['S1'], [], at='review')
        self.assertFalse(out['all_passed'])
        self.assertTrue(any(p.startswith('routes undeclared') and 'no medium' in p for p in out['problems']))

    def test_watch_folders_include_ready_and_skip_work(self):
        for d in ('ready', 'rough/work/ROUND 1 - watch these', 'ROUND 2 - watch these', 'already'):
            (self.piece / d).mkdir(parents=True)
        self.assertEqual([p.name for p in dg.watch_folders(self.store, self.piece)], ['ROUND 2 - watch these', 'ready'])


@needs_ffmpeg
class Audition(Base):
    """An audio-only listen file is a medium of its own (header medium audition): only the rows that apply to one sound file are routed,
    and audition-gates measures each file and runs the person's verdict rows on its take."""

    def setUp(self):
        super().setUp()
        (self.piece / 'film-gate.json').unlink()
        (self.piece / 'SCRIPT.md').write_text(HEADER.replace('video', 'audition').replace('voice clone music sfx sound rebuilt example hf ref changes', 'voice sound'))
        self.takes = self.piece / 'voices' / 'voice-a'
        self.takes.mkdir(parents=True)
        self.good, self.loud = self.takes / 'q1.wav', self.takes / 'q2.wav'
        tone = 'sine=frequency=220:duration=1.5,loudnorm=I=-16:TP=-3,adelay=250,apad=pad_dur=0.1'
        for path, chain in ((self.good, tone), (self.loud, 'sine=frequency=220:duration=1.5,volume=7.9,adelay=250,apad=pad_dur=0.1')):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', chain, '-ar', '48000', str(path)], check=True)
        past = datetime.now().timestamp() - 120
        for path in (self.good, self.loud):
            os.utime(path, (past, past))
        self.stub('run_check_mjs', lambda store, file, extra, held=False, only=None, exclude=None: ('advisory', 'ADVISORY waits for the person: no stance on this voice'))

    def test_only_the_rows_that_apply_to_one_sound_file_are_routed(self):
        out = dg.gate(self.store, self.piece, ['S5', 'S6'], ['voices/voice-a/q1'], at='review')
        ids = {i['id'] for i in out['unanswered_must']}
        self.assertIn('audition', out['tags'])
        self.assertTrue({'S6.G01', 'S5.G03', 'S6.R07'} <= ids)
        self.assertFalse(ids & {'S6.1', 'S6.2', 'S5.G01', 'S5.2'})
        self.assertFalse(any(i.startswith('S5.R') for i in ids))

    def test_a_film_of_cuts_and_auditions_routes_picture_rows_to_cuts_and_sound_file_rows_to_auditions(self):
        (self.piece / 'SCRIPT.md').write_text(HEADER.replace('video', 'video audition').replace('voice clone music sfx sound rebuilt example hf ref changes', 'voice sound'))
        (self.piece / 'rough').mkdir()
        (self.piece / 'rough' / 'cut.mp4').write_bytes(b'x')
        out = dg.gate(self.store, self.piece, ['S5', 'S6'], ['voices/voice-a/q1', 'rough/cut'], at='review')
        rows = {}
        for i in out['unanswered_must']:
            rows.setdefault(i['option'], set()).add(i['id'])
        self.assertTrue({'S6.G01', 'S5.G03'} <= rows['voices/voice-a/q1'] and not any(r.startswith('S5.R') for r in rows['voices/voice-a/q1']))
        self.assertTrue('S5.R01' in rows['rough/cut'] and 'S6.G01' not in rows['rough/cut'])
        self.assertTrue({'S6.1', 'S6.2'} <= rows[None])       # the cuts keep the piece-level sound rows
        held = {Path(o['file']).name: o['rows'] for o in dg.audit_watch(self.store, self.piece, False, [self.good, self.piece / 'rough' / 'cut.mp4'])['offenders']}
        self.assertIn('S5.2 (open)', held['cut.mp4'])          # a piece-level picture row holds the cut ...
        self.assertNotIn('S5.2 (open)', held['q1.wav'])       # ... and not the audition
        self.assertNotIn('S6.1 (open)', held['q1.wav'])

    def test_a_measured_file_inside_its_marks_passes_and_one_outside_is_refused(self):
        out = dg.audition_gates(self.store, self.piece, [self.good, self.loud], 'review')
        measured = {r['option']: r for r in out['rows'] if r['check'] == 'audio-measure'}
        self.assertEqual(measured['voices/voice-a/q1']['answer'], 'pass', measured['voices/voice-a/q1']['evidence'])
        self.assertEqual(measured['voices/voice-a/q2']['answer'], 'fail')
        self.assertIn('true peak dBTP', measured['voices/voice-a/q2']['evidence'])
        rest = dg.gate(self.store, self.piece, ['S5', 'S6'], ['voices/voice-a/q1', 'voices/voice-a/q2'], at='review')
        for item in rest['unanswered_must']:      # the rows a person answers (pronunciation), with evidence
            dg.record_answer(self.store, self.piece, item['id'], 'pass', 'evidence for ' + item['id'], 'test', item['option'])
        self.assertTrue(dg.audit_watch(self.store, self.piece, False, [self.good])['all_passed'])
        refused = dg.audit_watch(self.store, self.piece, False, [self.loud])
        self.assertFalse(refused['all_passed'])
        self.assertIn('S6.G01 (failed)', refused['offenders'][0]['rows'])
        with self.good.open('ab') as f:
            f.write(b'\0\0')      # other bytes
        self.assertIn('S6.G01 (stale)', dg.audit_watch(self.store, self.piece, False, [self.good])['offenders'][0]['rows'])

    def test_a_take_waiting_for_their_ruling_is_held_at_review_and_a_rejected_voice_fails(self):
        def answer(check, stage):
            return next(r['answer'] for r in dg.audition_gates(self.store, self.piece, [self.good], stage)['rows'] if r['check'] == check)
        dg.run_check_mjs = lambda store, file, extra, held=False, only=None, exclude=None: dg.copy_gate_verdict([{'verdict': 'uncertain', 'text': '{voice}', 'uncertain': [{'rule': 'take-voice-has-their-verdict'}]}], held)
        self.assertEqual((answer('verdict-rules', 'review'), answer('verdict-rules', 'final')), ('advisory', 'fail'))
        dg.run_check_mjs = lambda store, file, extra, held=False, only=None, exclude=None: dg.copy_gate_verdict([{'verdict': 'fail', 'text': '{voice}', 'breaks': [{'rule': 'take-voice-has-their-verdict'}]}], held)
        self.assertEqual(answer('verdict-rules', 'review'), 'fail')

    def test_their_verdict_on_the_take_is_advisory_at_review_and_fails_at_final(self):
        dg.audition_gates(self.store, self.piece, [self.good], 'review')
        review = dg.gate(self.store, self.piece, ['S5'], ['voices/voice-a/q1'], at='review')
        final = dg.gate(self.store, self.piece, ['S5'], ['voices/voice-a/q1'], at='final')
        self.assertIn(('S5.G03', 'voices/voice-a/q1'), [(i['id'], i['option']) for i in review['advisory']])
        self.assertIn('S5.G03', {i['id'] for i in final['failed_must']})


@needs_tools
class SettingsAndHelpers(unittest.TestCase):
    """The schema as a list:settings row, the branch helper and the measure-reference command (new with the port)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='delivery-gate-helpers-'))
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_the_schema_may_be_the_persons_settings_row_read_with_the_shared_reader(self):
        schema = json.loads((FIXTURE / 'schema.json').read_text())
        row = lambda scope, value, status='active': {'id': f'record:setting:keep-a-record-library-valid~person~{scope}', 'type': 'record:setting',
                                                     'value': {'name': 'A made-up library', 'tool': 'tool:check-a-record-library', 'scope_kind': 'person', 'scope_id': scope,
                                                               'settings': json.dumps(value), 'from': 'made-up@0', 'status': status}}
        one = self.tmp / 'row.json'
        one.write_text(json.dumps(row('made-up', schema)))
        self.assertEqual(Store(FIXTURE, one).schema['delivery_gate']['answers_file'], 'checklist-answers.jsonl')
        two = self.tmp / 'rows.json'
        other = {**schema, 'delivery_gate': {**schema['delivery_gate'], 'answers_file': 'other.jsonl'}}
        two.write_text(json.dumps([row('made-up', schema), row('someone-else', other)]))
        self.assertEqual(Store(FIXTURE, two, [('person', 'someone-else')]).schema['delivery_gate']['answers_file'], 'other.jsonl')
        with self.assertRaisesRegex(ValueError, 'no scope'):
            Store(FIXTURE, two)
        one.write_text(json.dumps(row('made-up', schema, 'retired')))
        with self.assertRaisesRegex(ValueError, 'retired'):
            Store(FIXTURE, one)

    def test_the_branch_helper_reads_the_verdict_ids_and_writes_the_rows_for_a_review_pack(self):
        out = self.tmp / 'rules.json'
        run = subprocess.run(['node', str(dg.BRANCH_RULES), '--branch', 'made-up-content', '--door-records', str(FIXTURE / 'data' / 'check-records.json'), '--rules-out', str(out)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        got = json.loads(run.stdout)
        self.assertEqual(got['verdict_ids'], ['novel-no-verdict-no-row', 'their-leverage', 'their-stance', 'their-teapot'])
        self.assertEqual(got['lineage'], ['made-up-content', 'made-up-base'])
        self.assertEqual(sorted(r['id'] for r in json.loads(out.read_text())['rows']), ['no-glorp', 'their-leverage', 'their-teapot'])
        bad = subprocess.run(['node', str(dg.BRANCH_RULES), '--branch', 'no-such-branch', '--door-records', str(FIXTURE / 'data' / 'check-records.json')], capture_output=True, text=True)
        self.assertEqual(bad.returncode, 2)

    def fake(self, name, body):
        path = self.tmp / 'bin' / name
        path.parent.mkdir(exist_ok=True)
        path.write_text('#!/bin/sh\n' + body)
        path.chmod(0o755)
        return path

    def test_measure_reference_runs_each_program_it_is_given_and_answers_one_json_line(self):
        log = self.tmp / 'calls.log'
        hf = self.fake('hf-media', f'echo "hf-media $*" >> {log}\nfor a in "$@"; do last="$a"; done\nmkdir -p "$last"\necho {{}}\n')
        ffprobe = self.fake('ffprobe', f'echo "ffprobe $*" >> {log}\ncase "$*" in *format=duration\\ *) echo 3.5;; *stream=duration*) echo 3.4;; *) echo "{{}}";; esac\n')
        node = self.fake('node', f'echo "node $*" >> {log}\necho "{{\\"rhythm\\": 1}}"\n')
        earshot = self.fake('earshot-python', f'echo "earshot $*" >> {log}\n[ "$1" = -c ] && exit 0\necho "0.0 speech"\n')
        tools = self.tmp / 'motion'
        tools.mkdir()
        (tools / 'motion-rhythm.mjs').write_text('// made up\n')
        video = self.tmp / 'clip.mp4'
        video.write_bytes(b'not a real video')
        programs = ['--hf-media', str(hf), '--earshot-python', str(earshot), '--ffprobe', str(ffprobe), '--node', str(node)]
        command = [sys.executable, '-I', str(TOOL / 'do-work' / 'keep_a_record_library.py'), 'measure-reference', str(video)]
        run = subprocess.run([*command, str(self.tmp / 'out'), '--motion-tools', str(tools), *programs], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(len(run.stdout.strip().splitlines()), 1)
        got = json.loads(run.stdout)
        self.assertTrue(got['measured'])
        self.assertEqual(got['duration_s'], 3.4)      # the shorter of the container and the picture
        calls = log.read_text()
        self.assertIn('evidence frames ' + str(video) + ' --times [0.0,1.0,2.0,3.0] --max-width 320 --sheet-columns 6', calls)
        self.assertIn('--times [0.0,0.167,0.333', calls)
        self.assertIn('evidence temporal-scan ' + str(video), calls)
        self.assertIn(f'node {tools / "motion-rhythm.mjs"} {video}', calls)
        self.assertIn(f'earshot -m earshot timeline {video}', calls)
        self.assertEqual((self.tmp / 'out' / 'rhythm.json').read_text().strip(), '{"rhythm": 1}')
        self.assertEqual(set(got['files']), {'probe.json', 'sheet-1fps', 'sheet-hook', 'scan', 'scan.json', 'rhythm.json', 'earshot-timeline.txt'})
        refused = subprocess.run([*command, str(self.tmp / 'out2'), '--motion-tools', str(self.tmp), *programs], capture_output=True, text=True)
        self.assertEqual(refused.returncode, 2)
        self.assertIn('--motion-tools, the folder holding motion-rhythm.mjs', refused.stderr)
        self.assertFalse((self.tmp / 'out2').exists(), 'a missing program is refused before any media work')


if __name__ == '__main__':
    unittest.main()

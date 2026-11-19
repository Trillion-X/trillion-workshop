"""Stdlib tests for byte-bounded commands, merged duplicate rows and a stable basis time in the records:write builder, and for the write
planner (read-data/record_write_plan.py, do-work/plan_record_write.py): what to write, what to keep, the refresh of source fields, and the
readback. Nothing here reaches a store: every test hands the target records in as `held`, as the caller's AI reads them."""
from __future__ import annotations

import io
import json
import re
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'pantry'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import record_write_plan as planner  # noqa: E402
import records_write  # noqa: E402
import plan_record_write as cli  # noqa: E402

AT = '2026-01-01T00:00:00.000Z'
TARGET, PREFIX = 'sample-row', 'sample-list:'


def rec(record_id, value, record_type=TARGET):
    return {'id': record_id, 'type': record_type, 'value': value}


def pay(*records):
    return {'commands': [{'input': {'records': list(records)}}]}


def config(**extra):
    return {'per_command': 4, 'command_bytes': 4000, 'request_key_prefix': 'pantry-load', **extra}


def request(payload, held=(), **extra):
    return {'payload': payload, 'target_type': TARGET, 'target_prefix': PREFIX, 'held': list(held), 'config': extra.pop('config', config()), **extra}


def written(answer):
    return {record['id']: record for command in answer['commands'] for record in command['input']['records']}


def store_after(held, answer):
    """The store's records once each command is written the way a store writes it: a record with expected must still hold it."""
    store = {record['id']: dict(record) for record in held}
    for command in answer['commands']:
        for record in command['input']['records']:
            current = store.get(record['id'])
            if 'expected' in record:
                expected = record['expected']
                if expected is None and current is not None or expected is not None and (current is None or current['value'] != expected['value']):
                    raise AssertionError(f'The store refuses {record["id"]}: it no longer holds the expected value.')
            if record['value'] is None:
                store.pop(record['id'], None)
            else:
                store[record['id']] = {'id': record['id'], 'type': record['type'], 'value': record['value']}
    return list(store.values())


class Pantry(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='record-write-send-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'pantry'
        shutil.copytree(FIXTURE, self.root)
        self.mapping = json.loads((self.root / 'mapping.json').read_text())

    def build(self, built_at=AT, **change):
        return records_write.build({**self.mapping, **change}, {'here': self.root, 'data': self.root}, built_at)


class Commands(Pantry):
    def test_commands_hold_at_most_the_bytes_and_the_count_given_and_keep_the_order(self):
        records = [{'id': f'r{i}', 'type': 't', 'value': {'words': 'x' * size}} for i, size in enumerate([10, 10, 60, 10, 10, 10])]
        commands = records_write.commands_of(records, {'per_command': 2, 'command_bytes': 150})
        self.assertEqual([[r['id'] for r in c['input']['records']] for c in commands], [['r0', 'r1'], ['r2'], ['r3', 'r4'], ['r5']])
        for command in commands:
            size = len(json.dumps({'records': command['input']['records']}, ensure_ascii=False,
                                  separators=(',', ':')).encode('utf-8'))
            self.assertLessEqual(size, 150)

    def test_one_record_bigger_than_a_command_takes_is_refused_by_its_id(self):
        with self.assertRaisesRegex(ValueError, 'r0 needs .* bytes, more than a command takes'):
            records_write.commands_of([{'id': 'r0', 'type': 't', 'value': {'w': 'x' * 200}}], {'per_command': 5, 'command_bytes': 150})

    def test_exact_records_envelope_boundary_is_included(self):
        record = {'id': 'record:goods:é', 'type': 'record:goods', 'value': {'name': '雪'}}
        envelope_bytes = len(json.dumps({'records': [record]}, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        commands = records_write.commands_of([record], {'per_command': 1, 'command_bytes': envelope_bytes})
        self.assertEqual(commands, [{'input': {'records': [record]}}])
        with self.assertRaisesRegex(ValueError, 'record:goods:é needs .* bytes'):
            records_write.commands_of([record], {'per_command': 1, 'command_bytes': envelope_bytes - 1})

    def test_the_payload_is_cut_by_bytes_when_the_mapping_gives_a_limit(self):
        payload = self.build(limits={**self.mapping['limits'], 'per_command': 100, 'command_bytes': 1500})
        self.assertGreater(len(payload['commands']), 1)
        for command in payload['commands']:
            self.assertLessEqual(len(json.dumps({'records': command['input']['records']}, ensure_ascii=False,
                                                separators=(',', ':')).encode('utf-8')), 1500)


class StableTime(Pantry):
    def test_a_basis_takes_its_time_from_the_mapping_so_two_builds_make_the_same_records(self):
        at = {'text': '{_generated}T00:00:00.000Z'}
        first, second = self.build('2026-05-05T05:05:05.000Z', at=at), self.build('2027-07-07T07:07:07.000Z', at=at)
        self.assertEqual(first['commands'], second['commands'])
        flour = next(r for c in first['commands'] for r in c['input']['records'] if r['id'] == 'record:goods:market:flour')
        self.assertEqual(flour['value']['_basis']['blurb']['at'], '2026-01-02T00:00:00.000Z')

    def test_without_one_a_basis_says_the_time_of_the_build(self):
        flour = next(r for c in self.build()['commands'] for r in c['input']['records'] if r['id'] == 'record:goods:market:flour')
        self.assertEqual(flour['value']['_basis']['blurb']['at'], AT)


class Duplicates(Pantry):
    def with_second_stores(self, policy):
        (self.root / 'more-stores.json').write_text(json.dumps({'stores': [
            {'id': 'corner', 'values': {'name': 'The Corner', 'hours': '9 to 5'}}, {'id': 'kiosk', 'values': {'name': 'Kiosk'}}]}))
        second = {'name': 'more-stores', 'list': 'stores', 'kind': 'rows', 'rows': {'file': {'root': 'here', 'path': 'more-stores.json'}, 'path': 'stores'},
                  'values': {'...': {'path': 'values'}}, **({'on_duplicate': policy} if policy else {})}
        return self.build(sources=[*self.mapping['sources'], second])

    def stores(self, payload):
        return {r['id']: r['value'] for c in payload['commands'] for r in c['input']['records'] if r['type'] == 'record:stores'}

    def test_two_sources_making_one_row_id_are_refused_without_a_policy(self):
        with self.assertRaisesRegex(ValueError, 'Two stores rows share the id corner'):
            self.with_second_stores(None)

    def test_fill_keeps_the_first_rows_values_takes_the_fields_it_lacks_and_reports_the_merge(self):
        payload = self.with_second_stores('fill')
        corner = self.stores(payload)['record:stores:corner']
        self.assertEqual((corner['name'], corner['hours'], corner['stocked']), ('Corner Store', '9 to 5', 4))
        self.assertIn('record:stores:kiosk', self.stores(payload))
        self.assertEqual(payload['merged'], [{'list': 'stores', 'id': 'corner', 'source': 'more-stores', 'kept': 'fill',
                                              'filled': ['hours'], 'differing': {'name': 'The Corner'}}])
        self.assertIn('notes', corner['_basis'], 'the first row keeps its basis')

    def test_over_lets_the_later_rows_values_win_and_the_first_fills_the_rest(self):
        payload = self.with_second_stores('over')
        corner = self.stores(payload)['record:stores:corner']
        self.assertEqual((corner['name'], corner['hours'], corner['url']), ('The Corner', '9 to 5', 'https://corner.test/'))
        self.assertEqual(payload['merged'][0]['differing'], {'name': 'Corner Store'})

    def test_an_unknown_policy_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'on_duplicate is one of fill, over'):
            self.with_second_stores('newest')


class Plan(Pantry):
    def test_a_plan_asks_for_what_the_store_lacks_or_holds_differently_and_counts_the_rest_out_of_scope(self):
        payload = pay(rec('sample-list:row-1', {'title': 'One'}), rec('sample-list:row-2', {'title': 'Two'}),
                      rec('sample-list:row-3', {'title': 'Three'}), rec('other:x', {'a': 1}, 'other'))
        held = [rec('sample-list:row-2', {'title': 'Old two'}), rec('sample-list:row-3', {'title': 'Three'})]
        answer = planner.plan(request(payload, held))
        self.assertEqual((answer['state'], answer['records'], answer['to_write'], answer['out_of_scope']), ('to_write', 3, 2, 1))
        self.assertEqual([r['id'] for c in answer['commands'] for r in c['input']['records']], ['sample-list:row-1', 'sample-list:row-2'])

    def test_a_store_that_holds_the_payload_plans_nothing_and_a_readback_matches(self):
        payload = pay(rec('sample-list:row-1', {'title': 'One'}), rec('sample-list:row-2', {'title': 'Two'}))
        answer = planner.plan(request(payload))
        after = store_after([], answer)
        self.assertEqual(planner.plan(request(payload, after))['state'], 'nothing_to_write')
        check = planner.readback(request(payload, after))
        self.assertEqual((check['state'], check['readback'][TARGET]), ('all_equal', {'payload': 2, 'held': 2, 'equal': 2, 'missing': [], 'differing': []}))

    def test_a_readback_names_a_record_that_is_missing_or_differs(self):
        payload = pay(rec('sample-list:row-1', {'title': 'One'}), rec('sample-list:row-2', {'title': 'Two'}))
        check = planner.readback(request(payload, [rec('sample-list:row-2', {'title': 'Other'})]))
        self.assertEqual(check['state'], 'readback_differs')
        self.assertEqual(check['readback'][TARGET]['missing'], ['sample-list:row-1'])
        self.assertEqual(check['readback'][TARGET]['differing'], ['sample-list:row-2'])

    def test_commands_hold_at_most_the_count_given_are_keyed_by_their_records_and_keep_the_order(self):
        payload = pay(*[rec(f'sample-list:row-{n}', {'title': 'x' * 3}) for n in range(5)])
        answer = planner.plan(request(payload, config=config(per_command=2)))
        self.assertEqual([[r['id'] for r in c['input']['records']] for c in answer['commands']],
                         [['sample-list:row-0', 'sample-list:row-1'], ['sample-list:row-2', 'sample-list:row-3'], ['sample-list:row-4']])
        first = answer['commands'][0]
        self.assertRegex(first['request_key'], r'^pantry-load-[0-9a-f]{32}$')
        again = planner.write_commands(config(per_command=2), first['input']['records'])
        self.assertEqual(again[0]['request_key'], first['request_key'], 'the same records make the same key, so a replay is the same write')
        self.assertNotEqual(first['request_key'], answer['commands'][1]['request_key'])

    def test_commands_hold_at_most_the_bytes_given(self):
        payload = pay(*[rec(f'sample-list:row-{n}', {'words': 'x' * 40}) for n in range(4)])
        answer = planner.plan(request(payload, config=config(command_bytes=200)))
        self.assertGreater(len(answer['commands']), 1)
        for command in answer['commands']:
            size = len(json.dumps({'records': command['input']['records']}, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            self.assertLessEqual(size, 200)

    def test_keep_held_never_writes_a_record_the_store_already_holds_whatever_its_value(self):
        payload = pay(rec('sample-list:row-1', {'title': 'As built'}), rec('sample-list:row-2', {'title': 'New'}))
        answer = planner.plan(request(payload, [rec('sample-list:row-1', {'title': 'Edited by hand'})], config=config(keep_held=True)))
        self.assertEqual([r['id'] for r in written(answer).values()], ['sample-list:row-2'])

    def test_a_removal_is_planned_only_while_the_store_holds_the_record(self):
        payload = pay(rec('sample-list:row-1', None), rec('sample-list:row-2', None))
        self.assertEqual(planner.plan(request(payload))['state'], 'nothing_to_write')
        answer = planner.plan(request(payload, [rec('sample-list:row-2', {'title': 'Held'})]))
        self.assertEqual(list(written(answer)), ['sample-list:row-2'])
        self.assertIsNone(written(answer)['sample-list:row-2']['value'])

    def test_a_held_record_outside_the_target_type_or_prefix_is_refused_never_ignored(self):
        payload = pay(rec('sample-list:row-1', {'title': 'One'}))
        with self.assertRaisesRegex(ValueError, 'outside the target type and prefix'):
            planner.plan(request(payload, [rec('sample-list:row-9', {}, 'other')]))
        with self.assertRaisesRegex(ValueError, 'outside the target type and prefix'):
            planner.plan(request(payload, [rec('other:row-9', {})]))

    def test_the_target_type_prefix_and_config_are_required_and_checked(self):
        payload = pay(rec('sample-list:row-1', {'title': 'One'}))
        with self.assertRaisesRegex(ValueError, 'target_type and target_prefix'):
            planner.plan({**request(payload), 'target_prefix': ''})
        with self.assertRaisesRegex(ValueError, 'per_command is a whole number'):
            planner.plan(request(payload, config=config(per_command=0)))
        with self.assertRaisesRegex(ValueError, 'needs command_bytes'):
            planner.plan(request(payload, config={'per_command': 1, 'request_key_prefix': 'x'}))
        with self.assertRaisesRegex(ValueError, 'duplicate record ids'):
            planner.plan(request(pay(rec('sample-list:row-1', {}), rec('sample-list:row-1', {}))))

    def test_baseline_refresh_keeps_live_edits_and_their_basis_and_adds_source_fields(self):
        original = {'name': 'Imported', 'description': 'Original', '_basis': {'name': {'by': 'source'}, 'description': {'by': 'source'}}}
        record = rec('record:stores:one', original, 'record:stores')
        baseline = pay(record)
        live = {'name': 'Person edit', 'description': 'Original', 'personal_note': 'Keep me', '_basis': {'name': {'by': 'person'}, 'description': {'by': 'source'}}}
        desired = {'name': 'Source changed', 'description': 'Source improved', 'mechanism': ['repeat'],
                   '_basis': {'name': {'by': 'new-source'}, 'description': {'by': 'new-source'}, 'mechanism': {'by': 'new-source'}}}
        payload = pay({**record, 'value': desired})
        held = [rec(record['id'], live, 'record:stores')]
        answer = planner.plan(request(payload, held, baseline=baseline, target_type='record:stores', target_prefix='record:stores:'))
        self.assertEqual(answer['to_write'], 1)
        self.assertEqual(answer['conflicts'], [{'id': record['id'], 'path': ['name'], 'reason': 'live_changed'}])
        saved = written(answer)[record['id']]['value']
        self.assertEqual((saved['name'], saved['description'], saved['mechanism'], saved['personal_note']),
                         ('Person edit', 'Source improved', ['repeat'], 'Keep me'))
        self.assertEqual((saved['_basis']['name'], saved['_basis']['description']), ({'by': 'person'}, {'by': 'new-source'}))
        self.assertEqual(written(answer)[record['id']]['expected'], {'type': 'record:stores', 'value': live}, 'the store must still hold live')
        after = store_after(held, answer)
        again = planner.plan(request(payload, after, baseline=baseline, target_type='record:stores', target_prefix='record:stores:'))
        self.assertEqual(again['to_write'], 0, 'the same baseline recovers an interrupted write without rewriting preserved edits')
        check = planner.readback(request(payload, after, baseline=baseline, target_type='record:stores', target_prefix='record:stores:'))
        self.assertEqual(check['state'], 'readback_differs', 'a live conflict is never all_equal')
        self.assertTrue(check['conflicts'])

    def test_an_empty_baseline_value_adds_fields_to_held_rows_by_id_and_keeps_every_other_field(self):
        ids = [f'record:stores:{n}' for n in range(2)]
        baseline = pay(*[rec(i, {}, 'record:stores') for i in ids])
        payload = pay(rec(ids[0], {'verdict': 'Checked', 'paths': ['a.md']}, 'record:stores'), rec(ids[1], {'verdict': 'Checked'}, 'record:stores'))
        held = [rec(ids[0], {'name': 'One', 'lives': '{"where_now": "x"}'}, 'record:stores'), rec(ids[1], {'name': 'Two', 'verdict': 'Checked'}, 'record:stores')]
        answer = planner.plan(request(payload, held, baseline=baseline, target_type='record:stores', target_prefix='record:stores:'))
        self.assertEqual(answer['conflicts'], [])
        self.assertEqual([r['id'] for c in answer['commands'] for r in c['input']['records']], [ids[0]])
        self.assertEqual(written(answer)[ids[0]]['value'], {'name': 'One', 'lives': '{"where_now": "x"}', 'verdict': 'Checked', 'paths': ['a.md']})

    def test_baseline_does_not_resurrect_a_deleted_record_or_remove_an_edited_one(self):
        old = [rec(f'record:stores:{n}', {'name': 'Original'}, 'record:stores') for n in range(3)]
        baseline = pay(*old)
        target = [{**old[0], 'value': {'name': 'Changed'}}, {**old[1], 'value': None}, {**old[2], 'value': None}]
        held = [rec(old[1]['id'], {'name': 'Live edit'}, 'record:stores'), rec(old[2]['id'], {'name': 'Original'}, 'record:stores')]
        answer = planner.plan(request(pay(*target), held, baseline=baseline, target_type='record:stores', target_prefix='record:stores:'))
        self.assertEqual([c['reason'] for c in answer['conflicts']], ['live_deleted', 'unsafe_removal'])
        self.assertEqual(sorted(written(answer)), [old[2]['id']], 'the removal of a record the store holds unchanged is planned; the rest is not')

    def test_baseline_nested_removals_do_not_erase_peer_changes_or_attach_rejected_basis(self):
        record = {'id': 'a', 'type': 't', 'value': {'settings': {'x': 1, 'y': 2}, 'title': 'Old', '_basis': {'title': {'by': 'source'}}}}
        baseline = {'commands': [{'input': {'records': [record]}}]}
        fresh = {**record, 'value': {'settings': {'x': 3}, 'title': 'New', '_basis': {'title': {'by': 'new-source'}}}}
        held = {'a': {'settings': {'x': 1, 'y': 4, 'z': 5}, 'title': 'Peer', '_basis': {}}}
        result, conflicts = planner.refresh_records([fresh], baseline, held)
        self.assertEqual(result[0]['value'], {'settings': {'x': 3, 'y': 4, 'z': 5}, 'title': 'Peer', '_basis': {}})
        self.assertEqual([c['path'] for c in conflicts], [['settings', 'y'], ['title']])

    def test_baseline_handles_scalar_edits_new_records_after_removal_and_duplicate_id_refusal(self):
        baseline = {'commands': [{'input': {'records': [{'id': 'a', 'type': 't', 'value': None}]}}]}
        record = {'id': 'a', 'type': 't', 'value': {'name': 'New'}}
        records, conflicts = planner.refresh_records([record], baseline, {})
        self.assertEqual((records, conflicts), ([record], []))
        records, conflicts = planner.refresh_records([{**record, 'value': 'Changed'}], baseline, {'a': {'name': 'Live'}})
        self.assertEqual(records[0]['value'], {'name': 'Live'})
        self.assertEqual(conflicts[0]['path'], [])
        with self.assertRaisesRegex(ValueError, 'duplicate record ids'):
            planner.refresh_records([record, record], baseline, {})

    def test_baseline_and_keep_held_cannot_be_combined(self):
        payload = pay(rec('sample-list:row-1', {'title': 'One'}))
        with self.assertRaisesRegex(ValueError, 'cannot be combined'):
            planner.plan(request(payload, baseline=pay(), config=config(keep_held=True)))


class PlanCommandLine(Pantry):
    def run_cli(self, mode, given):
        out, err = io.StringIO(), io.StringIO()
        with patch('sys.stdin', io.StringIO(json.dumps(given))), redirect_stdout(out), redirect_stderr(err):
            code = cli.main([mode])
        return code, out.getvalue(), err.getvalue()

    def test_the_command_line_plans_then_reads_back_what_the_store_holds(self):
        payload = pay(rec('sample-list:row-1', {'title': 'One'}))
        code, out, err = self.run_cli('plan', request(payload))
        self.assertEqual((code, json.loads(out)['state']), (0, 'to_write'), err)
        after = store_after([], json.loads(out))
        code, out, err = self.run_cli('readback', request(payload, after))
        self.assertEqual((code, json.loads(out)['state']), (0, 'all_equal'), err)
        code, out, err = self.run_cli('readback', request(payload, []))
        self.assertEqual((code, json.loads(out)['state']), (1, 'readback_differs'))

    def test_the_command_line_refuses_an_input_it_cannot_read_with_exit_2(self):
        for given in ([1, 2], request(pay(rec('sample-list:row-1', {})), [rec('x', {}, 'other')])):
            code, out, err = self.run_cli('plan', given)
            self.assertEqual(code, 2)
            self.assertIn('Error', err)
            self.assertEqual(out, '')
        out, err = io.StringIO(), io.StringIO()
        with patch('sys.stdin', io.StringIO('not json')), redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(cli.main(['plan']), 2)


if __name__ == '__main__':
    unittest.main()

"""Stdlib tests for byte-bounded commands, merged duplicate rows and a stable basis time in the records:write builder, and for the sender
that writes only what an account lacks, against a made-up door (test/fixtures/fake_record_door.py) and the made-up pantry library."""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'pantry'
DOOR = Path(__file__).resolve().parent / 'fixtures' / 'fake_record_door.py'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
import record_write_send as sender  # noqa: E402
import records_write  # noqa: E402
import send_record_write as cli  # noqa: E402

AT = '2026-01-01T00:00:00.000Z'


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


class Door(Pantry):
    def setUp(self):
        super().setUp()
        self.account = self.tmp / 'account.json'
        os.environ['FAKE_DOOR'] = str(self.account)
        self.addCleanup(os.environ.pop, 'FAKE_DOOR', None)
        self.account.write_text(json.dumps({'records': {}, 'keys': {}, 'calls': []}))
        self.config = {'transport': {'kind': 'call', 'argv': [sys.executable, '-I', str(DOOR), '{plan}', '{result}']}, 'address': '@made-up', 'list_method': 'list',
                       'write_method': 'write', 'page_limit': 2, 'per_command': 4, 'command_bytes': 4000, 'request_key_prefix': 'pantry-load'}
        (self.tmp / 'config.json').write_text(json.dumps(self.config))
        self.payload = self.build()
        (self.tmp / 'payload.json').write_text(json.dumps(self.payload))
        self.status = self.tmp / 'status.json'

    def door(self):
        return sender.Door(self.config, self.tmp / 'work')

    def held(self):
        return json.loads(self.account.read_text())

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(['--config', str(self.tmp / 'config.json'), '--work', str(self.tmp / 'work'), *args])
        return code, out.getvalue(), err.getvalue()

    def test_a_send_writes_every_record_in_bounded_commands_keyed_by_their_content_and_logs_each(self):
        logged = []
        status = sender.send(self.door(), self.payload, self.status, logged.append)
        self.assertEqual(status['state'], 'all_written')
        self.assertEqual(len(self.held()['records']), self.payload['counts']['records'])
        writes = [c for c in self.held()['calls'] if c['method'] == 'write']
        self.assertTrue(all(c['records'] <= 4 for c in writes))
        self.assertEqual(len(logged), len(writes))
        first = json.loads(logged[0])
        self.assertRegex(first['request_key'], r'^pantry-load-[0-9a-f]{32}$')
        self.assertRegex(first['at'], r'(AM|PM) ')

    def test_a_second_send_reads_the_account_and_writes_nothing(self):
        sender.send(self.door(), self.payload, self.status, lambda _: None)
        before = [c for c in self.held()['calls'] if c['method'] == 'write']
        status = sender.send(self.door(), self.payload, self.status, lambda _: None)
        self.assertEqual((status['state'], status['to_write'], status['commands']), ('all_written', 0, 0))
        self.assertEqual([c for c in self.held()['calls'] if c['method'] == 'write'], before)
        self.assertEqual(sender.plan(self.door(), self.payload)['to_write'], 0)

    def test_after_new_rows_are_added_only_they_are_written(self):
        sender.send(self.door(), self.payload, self.status, lambda _: None)
        extra = {'id': 'record:stores:kiosk', 'type': 'record:stores', 'value': {'name': 'Kiosk'}}
        grown = {**self.payload, 'commands': [*self.payload['commands'], {'input': {'records': [extra]}}]}
        logged = []
        status = sender.send(self.door(), grown, self.status, logged.append)
        self.assertEqual((status['to_write'], len(logged)), (1, 1))
        self.assertEqual(self.held()['records']['record:stores:kiosk']['value'], {'name': 'Kiosk'})

    def test_the_same_records_make_the_same_request_key_and_a_repeated_key_is_a_replay(self):
        records = sender.records_of(self.payload)[:3]
        one, two = sender.write_commands(self.config, records), sender.write_commands(self.config, [dict(r) for r in records])
        self.assertEqual(one[0]['request_key'], two[0]['request_key'])
        self.assertNotEqual(one[0]['request_key'], sender.write_commands(self.config, records[:2])[0]['request_key'])

    def test_the_first_refused_command_stops_the_run_and_the_status_names_it(self):
        refused = sender.records_of(self.payload)[5]['id']
        account = self.held()
        account['refuse_id'] = refused
        self.account.write_text(json.dumps(account))
        status = sender.send(self.door(), self.payload, self.status, lambda _: None)
        self.assertEqual(status['state'], 'stopped_on_refusal')
        self.assertEqual(status['last_refusal']['command'], 2)
        self.assertIn('record_refused', status['last_refusal']['answer'])
        self.assertEqual(json.loads(self.status.read_text())['state'], 'stopped_on_refusal')
        self.assertNotIn(refused, self.held()['records'])

    def test_a_command_the_door_had_no_time_for_is_sent_in_halves_with_keys_of_their_own(self):
        account = self.held()
        account['slow_over'] = 1
        self.account.write_text(json.dumps(account))
        self.config['write_halve_if'] = ['too_slow']
        logged = []
        status = sender.send(self.door(), self.payload, self.status, logged.append)
        self.assertEqual((status['state'], status['written']), ('all_written', self.payload['counts']['records']))
        self.assertEqual(len(self.held()['records']), self.payload['counts']['records'])
        self.assertTrue(any('halved' in json.loads(line) for line in logged))
        self.assertTrue(all(c['records'] <= 1 for c in self.held()['calls'] if c['method'] == 'write' and c['request_key'] in self.held()['keys']))

    def test_without_a_halving_rule_a_slow_command_stops_the_run(self):
        account = self.held()
        account['slow_over'] = 1
        self.account.write_text(json.dumps(account))
        status = sender.send(self.door(), self.payload, self.status, lambda _: None)
        self.assertEqual((status['state'], status['last_refusal']['command']), ('stopped_on_refusal', 1))
        self.assertIn('too_slow', status['last_refusal']['answer'])

    def test_an_answer_that_may_have_written_is_replayed_under_the_same_key_and_recovers_its_answer(self):
        account = self.held()
        account['unknown_first'] = True
        self.account.write_text(json.dumps(account))
        self.config['write_replay_if'] = ['outcome_unknown']
        logged = []
        status = sender.send(self.door(), self.payload, self.status, logged.append)
        self.assertEqual(status['state'], 'all_written')
        first = [json.loads(line) for line in logged][:2]
        self.assertIn('replaying', first[0])
        self.assertEqual((first[1]['replays'], first[1]['request_key']), (1, first[0]['replaying']))
        writes = [c for c in self.held()['calls'] if c['method'] == 'write']
        self.assertEqual(writes[0]['request_key'], writes[1]['request_key'])

    def test_a_removal_is_sent_only_while_the_account_holds_the_record(self):
        sender.send(self.door(), self.payload, self.status, lambda _: None)
        gone = {'commands': [{'input': {'records': [{'id': 'record:stores:corner', 'type': 'record:stores', 'value': None}]}}]}
        self.assertEqual(sender.plan(self.door(), gone)['to_write'], 1)
        sender.send(self.door(), gone, self.tmp / 'status-2.json', lambda _: None)
        self.assertNotIn('record:stores:corner', self.held()['records'])
        self.assertEqual(sender.plan(self.door(), gone)['to_write'], 0)

    def test_the_command_line_sends_reads_back_and_exports_every_page(self):
        code, out, _ = self.run_cli('send', '--payload', str(self.tmp / 'payload.json'), '--status', str(self.status))
        self.assertEqual(code, 0, out)
        code, out, _ = self.run_cli('readback', '--payload', str(self.tmp / 'payload.json'))
        self.assertEqual(code, 0)
        back = json.loads(out.splitlines()[-1])
        self.assertEqual(back['record:stores'], {'payload': 3, 'held': 3, 'equal': 3, 'missing': [], 'differing': []})
        code, out, _ = self.run_cli('export', '--type', 'record:goods', '--out', str(self.tmp / 'backup'))
        self.assertEqual(code, 0)
        exported = json.loads(Path(json.loads(out)['file']).read_text())
        goods = sum(1 for r in sender.records_of(self.payload) if r['type'] == 'record:goods')
        self.assertEqual((exported['count'], len(exported['records'])), (goods, goods), 'pages of 2 are all read')

    def test_a_readback_names_a_record_whose_value_differs(self):
        sender.send(self.door(), self.payload, self.status, lambda _: None)
        account = self.held()
        account['records']['record:stores:market']['value']['name'] = 'Changed in the app'
        self.account.write_text(json.dumps(account))
        code, out, _ = self.run_cli('readback', '--payload', str(self.tmp / 'payload.json'))
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)['record:stores']['differing'], ['record:stores:market'])

    def test_a_config_without_a_transport_an_unknown_one_and_a_failed_call_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'The config needs transport'):
            sender.Door({k: v for k, v in self.config.items() if k != 'transport'}, self.tmp / 'work')
        with self.assertRaisesRegex(ValueError, 'transport.kind is mcp or call'):
            sender.Door({**self.config, 'transport': {'kind': 'pigeon'}}, self.tmp / 'work')
        with self.assertRaisesRegex(ValueError, 'names the door.s url'):
            sender.Door({**self.config, 'transport': {'kind': 'mcp', 'url': 'http://127.0.0.1:9/mcp'}}, self.tmp / 'work')
        broken = sender.Door({**self.config, 'transport': {'kind': 'call', 'argv': [sys.executable, '-I', str(DOOR), '{plan}', '{result}', 'extra']}}, self.tmp / 'work')
        self.account.write_text('not json')
        with self.assertRaisesRegex(ValueError, 'did not answer list'):
            broken.read_type('record:stores')

    def test_baseline_refresh_preserves_live_edits_and_their_basis_and_adds_source_fields(self):
        original = {'name': 'Imported', 'description': 'Original', '_basis': {'name': {'by': 'source'}, 'description': {'by': 'source'}}}
        record = {'id': 'record:stores:one', 'type': 'record:stores', 'value': original}
        baseline = {'commands': [{'input': {'records': [record]}}]}
        live = {'name': 'Person edit', 'description': 'Original', 'personal_note': 'Keep me', '_basis': {'name': {'by': 'person'}, 'description': {'by': 'source'}}}
        desired = {'name': 'Source changed', 'description': 'Source improved', 'mechanism': ['repeat'],
                   '_basis': {'name': {'by': 'new-source'}, 'description': {'by': 'new-source'}, 'mechanism': {'by': 'new-source'}}}
        payload = {'commands': [{'input': {'records': [{**record, 'value': desired}]}}]}
        state = self.held()
        state['records'][record['id']] = {'type': record['type'], 'value': live}
        self.account.write_text(json.dumps(state))
        preview = sender.plan(self.door(), payload, baseline)
        self.assertEqual(preview['to_write'], 1)
        self.assertEqual(preview['conflicts'], [{'id': record['id'], 'path': ['name'], 'reason': 'live_changed'}])
        status = sender.send(self.door(), payload, self.status, lambda _: None, baseline)
        self.assertEqual(status['state'], 'written_with_conflicts')
        saved = self.held()['records'][record['id']]['value']
        self.assertEqual(saved['name'], 'Person edit')
        self.assertEqual(saved['description'], 'Source improved')
        self.assertEqual(saved['mechanism'], ['repeat'])
        self.assertEqual(saved['personal_note'], 'Keep me')
        self.assertEqual(saved['_basis']['name'], {'by': 'person'})
        self.assertEqual(saved['_basis']['description'], {'by': 'new-source'})
        # The same baseline can recover an interrupted send without rewriting preserved edits.
        second = sender.send(self.door(), payload, self.status, lambda _: None, baseline)
        self.assertEqual(second['to_write'], 0)
        self.assertTrue(sender.readback(self.door(), payload, baseline)['_refresh']['conflicts'])

    def test_baseline_does_not_resurrect_a_deleted_record_or_remove_an_edited_one(self):
        old = [{'id': f'record:stores:{n}', 'type': 'record:stores', 'value': {'name': 'Original'}} for n in range(3)]
        baseline = {'commands': [{'input': {'records': old}}]}
        target = [{**old[0], 'value': {'name': 'Changed'}}, {**old[1], 'value': None}, {**old[2], 'value': None}]
        payload = {'commands': [{'input': {'records': target}}]}
        state = self.held()
        state['records'] = {old[1]['id']: {'type': 'record:stores', 'value': {'name': 'Live edit'}},
                            old[2]['id']: {'type': 'record:stores', 'value': {'name': 'Original'}}}
        self.account.write_text(json.dumps(state))
        status = sender.send(self.door(), payload, self.status, lambda _: None, baseline)
        self.assertEqual(status['written'], 1)
        self.assertEqual([c['reason'] for c in status['conflicts']], ['live_deleted', 'unsafe_removal'])
        self.assertNotIn(old[0]['id'], self.held()['records'])
        self.assertIn(old[1]['id'], self.held()['records'])
        self.assertNotIn(old[2]['id'], self.held()['records'])

    def test_baseline_nested_removals_do_not_erase_peer_changes_or_attach_rejected_basis(self):
        record = {'id': 'a', 'type': 't', 'value': {'settings': {'x': 1, 'y': 2}, 'title': 'Old', '_basis': {'title': {'by': 'source'}}}}
        baseline = {'commands': [{'input': {'records': [record]}}]}
        fresh = {**record, 'value': {'settings': {'x': 3}, 'title': 'New', '_basis': {'title': {'by': 'new-source'}}}}
        held = {'a': {'settings': {'x': 1, 'y': 4, 'z': 5}, 'title': 'Peer', '_basis': {}}}
        result, conflicts = sender.refresh_records([fresh], baseline, held)
        self.assertEqual(result[0]['value'], {'settings': {'x': 3, 'y': 4, 'z': 5}, 'title': 'Peer', '_basis': {}})
        self.assertEqual([c['path'] for c in conflicts], [['settings', 'y'], ['title']])

    def test_baseline_handles_scalar_edits_new_records_after_removal_and_duplicate_id_refusal(self):
        baseline = {'commands': [{'input': {'records': [{'id': 'a', 'type': 't', 'value': None}]}}]}
        record = {'id': 'a', 'type': 't', 'value': {'name': 'New'}}
        records, conflicts = sender.refresh_records([record], baseline, {})
        self.assertEqual((records, conflicts), ([record], []))
        records, conflicts = sender.refresh_records([{**record, 'value': 'Changed'}], baseline, {'a': {'name': 'Live'}})
        self.assertEqual(records[0]['value'], {'name': 'Live'})
        self.assertEqual(conflicts[0]['path'], [])
        with self.assertRaisesRegex(ValueError, 'duplicate record ids'):
            sender.refresh_records([record, record], baseline, {})

    def test_scoped_reads_do_not_scan_unrelated_rows_and_refuse_uncovered_targets(self):
        payload = {'commands': [{'input': {'records': [{'id': 'record:stores:target', 'type': 'record:stores', 'value': {'name': 'Target'}}]}}]}
        state = self.held()
        state['records'] = {f'record:stores:unrelated-{n}': {'type': 'record:stores', 'value': {'name': 'Other'}} for n in range(20)}
        self.account.write_text(json.dumps(state))
        self.config['read_prefixes'] = {'record:stores': ['record:stores:target']}
        self.assertEqual(sender.plan(self.door(), payload)['to_write'], 1)
        self.assertEqual(len(self.held()['calls']), 1)
        self.config['read_prefixes'] = {'record:stores': ['record:stores:wrong']}
        with self.assertRaisesRegex(ValueError, 'does not cover every target'):
            sender.plan(self.door(), payload)
        self.assertEqual(len(self.held()['calls']), 1, 'scope refusal occurs before reads or writes')

    def test_multiple_prefix_reads_have_different_keys_and_malformed_reads_never_become_absence(self):
        door = self.door()
        replies = iter([{'records': [], 'next': 'continue'},
                        {'records': [{'id': 'record:stores:a', 'type': 'record:stores', 'value': {}}], 'next': None},
                        {'records': [], 'next': None}])
        keys = []
        def answer(method, key, given):
            keys.append(key)
            return {'answer': next(replies)}
        door.play = answer
        self.assertEqual(len(door.read_type('record:stores', 'record:stores:a')), 1, 'an empty nonterminal page is followed')
        self.assertEqual(door.read_type('record:stores', 'record:stores:b'), [])
        self.assertEqual(len(set(keys)), 3)
        door.play = lambda *args: {'answer': {'records': [{'id': 'wrong', 'type': 'record:stores', 'value': {}}], 'next': None}}
        with self.assertRaisesRegex(ValueError, 'outside its requested type/prefix'):
            door.read_type('record:stores', 'record:stores:a')
        door.play = lambda *args: {'answer': {'records': [{'id': 'record:stores:a', 'type': 'record:stores'}], 'next': None}}
        with self.assertRaisesRegex(ValueError, 'outside its requested type/prefix'):
            door.read_type('record:stores', 'record:stores:a')
        door.play = lambda *args: {'answer': {'records': [], 'next': 'same'}}
        with self.assertRaisesRegex(ValueError, 'repeated continuation cursor'):
            door.read_type('record:stores')

    def test_cli_baseline_plan_send_and_readback_share_refresh_semantics(self):
        record = {'id': 'record:stores:one', 'type': 'record:stores', 'value': {'name': 'One'}}
        baseline = {'commands': [{'input': {'records': [record]}}]}
        fresh = {'commands': [{'input': {'records': [{**record, 'value': {'name': 'One', 'mechanism': ['cause']}}]}}]}
        (self.tmp / 'baseline.json').write_text(json.dumps(baseline))
        (self.tmp / 'fresh.json').write_text(json.dumps(fresh))
        sender.send(self.door(), baseline, self.status, lambda _: None)
        common = ['--payload', str(self.tmp / 'fresh.json'), '--baseline', str(self.tmp / 'baseline.json')]
        prefix = ['--read-prefix', 'record:stores=record:stores:one']
        code, out, err = self.run_cli(*prefix, 'plan', *common)
        self.assertEqual((code, json.loads(out)['to_write']), (0, 1), err)
        code, out, err = self.run_cli(*prefix, 'send', *common, '--status', str(self.status))
        self.assertEqual(code, 0, err)
        code, out, err = self.run_cli(*prefix, 'readback', *common)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)['_refresh']['conflicts'], [])
        self.config['keep_held'] = True
        with self.assertRaisesRegex(ValueError, 'cannot be combined'):
            sender.plan(self.door(), fresh, baseline)
        wrong_type = {'commands': [{'input': {'records': [{**record, 'type': 'other'}]}}]}
        with self.assertRaisesRegex(ValueError, 'changes type'):
            sender.refresh_records(sender.records_of(wrong_type), baseline, {})


class McpDoor(unittest.TestCase):
    """The mcp transport against a made-up door on a loopback port: run_resource_operation as JSON-RPC tools/call, the key from the
    credential handle as the Bearer token, a streamed answer read from its last data line."""

    KEY = 'made-up-key-0123456789'

    def setUp(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        self.records = {f'record:shelf:{n}': {'type': 'record:shelf', 'value': {'n': n}} for n in range(5)}
        self.seen, self.flaked, test = [], False, self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                test.seen.append({'auth': self.headers.get('Authorization'), 'body': body})
                if self.headers.get('Authorization') != f'Bearer {McpDoor.KEY}':
                    reply = {'jsonrpc': '2.0', 'id': body['id'], 'error': {'code': -32001, 'message': 'unauthorized'}}
                else:
                    args = body['params']['arguments']
                    if args['method'] == 'busy':
                        data = json.dumps({'code': 'busy_now', 'outcome': 'not_started', 'request_key': args['request_key']}).encode()
                        self.send_response(503)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Content-Length', str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    if args['method'] == 'leak':
                        result = {'structuredContent': {'echo': McpDoor.KEY}, 'isError': False}
                    elif args['method'] == 'list' and args['input']['type'] == 'record:flaky' and not test.flaked:
                        test.flaked = True
                        result = {'structuredContent': {'code': 'not_now'}, 'isError': True}
                    elif args['method'] == 'list':
                        ids = sorted(i for i, r in test.records.items() if r['type'] == args['input']['type'])
                        start = ids.index(args['input']['after']) + 1 if args['input'].get('after') in ids else 0
                        page = ids[start:start + args['input']['limit']]
                        nxt = page[-1] if start + args['input']['limit'] < len(ids) else None
                        result = {'structuredContent': {'records': [{'id': i, **test.records[i]} for i in page], 'next': nxt}, 'isError': False}
                    else:
                        result = {'structuredContent': {'code': 'refused', 'request_key': args['request_key']}, 'isError': True}
                    reply = {'jsonrpc': '2.0', 'id': body['id'], 'result': result}
                data = f'event: message\ndata: {json.dumps(reply)}\n\n'.encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.tmp = Path(tempfile.mkdtemp(prefix='record-write-mcp-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.config = {'transport': {'kind': 'mcp', 'url': f'http://127.0.0.1:{self.server.server_port}/mcp', 'credential': {'keychain_item': 'made-up-item'}},
                       'address': '@made-up', 'list_method': 'list', 'write_method': 'write', 'page_limit': 2, 'per_command': 4,
                       'command_bytes': 4000, 'request_key_prefix': 'shelf-load'}

    def door(self, key=KEY):
        handles = []
        door = sender.Door(self.config, self.tmp / 'work', key_of=lambda handle: handles.append(handle) or key)
        self.assertEqual(handles, [{'keychain_item': 'made-up-item'}], 'the key comes from the handle the config names')
        return door

    def test_pages_are_read_as_tools_call_with_the_handle_key_as_bearer_and_a_streamed_answer(self):
        records = self.door().read_type('record:shelf')
        self.assertEqual([r['id'] for r in records], sorted(self.records))
        call = self.seen[0]
        self.assertEqual(call['auth'], f'Bearer {self.KEY}')
        self.assertEqual((call['body']['method'], call['body']['params']['name']), ('tools/call', 'run_resource_operation'))
        self.assertEqual(call['body']['params']['arguments']['address'], '@made-up')
        self.assertFalse(any(self.KEY in path.read_text() for path in self.tmp.rglob('*') if path.is_file()), 'the key is never written')

    def test_a_refused_operation_is_an_error_line_and_a_wrong_key_is_refused_by_the_door(self):
        line = self.door().play('write', 'shelf-load-1', {'records': []})
        self.assertEqual((line['is_error'], line['answer']['code']), (True, 'refused'))
        with self.assertRaisesRegex(ValueError, 'Reading record:shelf page 1 was refused'):
            self.door(key='another-key').read_type('record:shelf')

    def test_a_refusal_under_a_non_2xx_status_is_an_error_line_with_the_doors_words(self):
        line = self.door().play('busy', 'shelf-load-3', {})
        self.assertEqual(line, {'is_error': True, 'answer': {'http_status': 503, 'code': 'busy_now', 'outcome': 'not_started', 'request_key': 'shelf-load-3'}})

    def test_an_answer_holding_the_key_is_refused_and_not_kept(self):
        with self.assertRaisesRegex(ValueError, 'held the key'):
            self.door().play('leak', 'shelf-load-2', {})

    def test_a_page_the_door_could_not_read_this_moment_is_read_again_and_without_the_rule_refused(self):
        self.records['record:flaky:1'] = {'type': 'record:flaky', 'value': {}}
        with self.assertRaisesRegex(ValueError, 'Reading record:flaky page 1 was refused'):
            self.door().read_type('record:flaky')
        self.flaked = False
        self.config.update({'page_retry_if': ['not_now'], 'page_retry_wait': 0})
        self.assertEqual([r['id'] for r in self.door().read_type('record:flaky')], ['record:flaky:1'])
        keys = [c['body']['params']['arguments']['request_key'] for c in self.seen[-2:]]
        self.assertNotEqual(keys[0], keys[1], 'a page read again has a key of its own, never a replay')

    def test_a_door_that_does_not_answer_is_refused(self):
        self.config['transport']['url'] = 'http://127.0.0.1:9/mcp'
        with self.assertRaisesRegex(ValueError, 'The door did not answer list'):
            self.door().read_type('record:shelf')

    def test_an_incomplete_http_reply_is_unknown_and_never_keeps_partial_bytes(self):
        from unittest.mock import MagicMock, patch
        import http.client
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = http.client.IncompleteRead(b'private-partial-body', 10)
        with patch('urllib.request.urlopen', return_value=response):
            answer = self.door().play('write', 'stable-original-key', {'records': []})
        self.assertTrue(answer['is_error'])
        self.assertEqual(answer['answer']['code'], 'resource_outcome_unknown')
        self.assertNotIn('private-partial-body', json.dumps(answer))

    def test_an_incomplete_read_retries_only_when_the_page_policy_allows_it(self):
        from unittest.mock import MagicMock, patch
        import http.client
        broken = MagicMock()
        broken.__enter__.return_value = broken
        broken.read.side_effect = http.client.IncompleteRead(b'', 1)
        good = MagicMock()
        good.__enter__.return_value = good
        good.headers.get.return_value = 'application/json'
        good.read.return_value = json.dumps({'result': {'structuredContent': {'records': [], 'next': None}}}).encode()
        self.config.update({'page_retry_if': ['resource_outcome_unknown'], 'page_retry_wait': 0})
        with patch('urllib.request.urlopen', side_effect=[broken, good]) as request:
            self.assertEqual(self.door().read_type('record:shelf'), [])
        self.assertEqual(request.call_count, 2)


if __name__ == '__main__':
    unittest.main()

"""Stable declaration keys and fresh source-write fences through the existing builder and sender.

All accounts, declarations and transport files here are temporary synthetic fixtures. The opponent changes the
actual fake owner's file after the sender reads it; the real sender must retain the owner's refusal.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL / 'read-data'))
import records_write
import record_write_send as sender

FAKE = Path(__file__).resolve().parent / 'fixtures' / 'fake_record_door.py'


def payload(records):
    return {'commands': [{'input': {'records': records}}]}


class RegistryIdentity(unittest.TestCase):
    def test_an_explicit_opaque_key_keeps_the_record_when_its_label_and_paths_change(self):
        with tempfile.TemporaryDirectory(prefix='registry-identity-') as temporary:
            root = Path(temporary)
            definition = {'lists': [{'id': 'capabilities', 'value': {'row_type': 'capability'}}], 'views': []}
            (root / 'lists.json').write_text(json.dumps(definition))
            declaration = {'id': 'same-job', 'capability': 'Keep a Namespace', 'entry': 'src/namespace.rs',
                           'owner': ['src/namespace.rs', 'src/namespace'], 'unknown': {'retain': True}}
            mapping = {'lists_file': {'root': 'here', 'path': 'lists.json'}, 'by': 'synthetic',
                       'emit_definitions': False, 'sources': [{
                           'name': 'declarations', 'list': 'capabilities', 'kind': 'rows',
                           'rows': {'file': {'root': 'here', 'path': 'registry.json'}, 'path': 'capabilities'},
                           'compute': {'repository': {'const': 'engine'},
                                       'short': {'first_set': [{'path': 'id'}, {'path': 'capability'}]},
                                       'id': {'text': '{repository}-{short}'}},
                           'values': {'capability': {'path': 'capability'}, 'entry': {'path': 'entry'},
                                      'owner': {'joined': {'of': {'path': 'owner'}, 'sep': '; '}}}}]}

            def build():
                (root / 'registry.json').write_text(json.dumps({'settings': {'untouched': True}, 'capabilities': [declaration]}))
                result = records_write.build(mapping, {'here': root}, '2026-01-01T00:00:00Z')
                return [r for command in result['commands'] for r in command['input']['records']]

            first = build()
            declaration.update(capability='Keep account files', entry='src/account_files/mod.rs',
                               owner=['src/account_files/mod.rs', 'src/account_files'])
            second = build()
            self.assertEqual([(r['id'], r['type']) for r in first], [('record:capability:engine-same-job', 'record:capability')])
            self.assertEqual([(r['id'], r['type']) for r in second], [(r['id'], r['type']) for r in first])
            self.assertEqual(second[0]['value']['entry'], 'src/account_files/mod.rs')
            self.assertEqual(second[0]['value']['owner'], 'src/account_files/mod.rs; src/account_files')
            self.assertEqual(json.loads((root / 'registry.json').read_text())['capabilities'][0]['unknown'], {'retain': True})

    def test_fresh_refresh_succeeds_but_edit_type_change_create_and_remove_races_refuse(self):
        rid, kind = 'record:capability:engine-same-job', 'record:capability'
        before = {'capability': 'Keep files', 'entry': 'src/old.rs', 'owner': 'src/old.rs'}
        after = {**before, 'entry': 'src/files/mod.rs', 'owner': 'src/files/mod.rs; src/files'}
        for scenario in ('positive', 'edit', 'type', 'create', 'remove'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(prefix='registry-fence-') as temporary:
                root = Path(temporary)
                account = root / 'account.json'
                initial = {} if scenario == 'create' else {rid: {'type': kind, 'value': before}}
                account.write_text(json.dumps({'records': initial, 'keys': {}, 'calls': []}))
                config = {'transport': {'kind': 'call', 'argv': [sys.executable, '-I', str(FAKE), '{plan}', '{result}']},
                          'address': '@synthetic', 'list_method': 'list', 'write_method': 'write',
                          'page_limit': 10, 'per_command': 10, 'command_bytes': 8000, 'request_key_prefix': 'fresh-source'}
                competitor = {'type': 'another-kind' if scenario == 'type' else kind,
                              'value': {**before, 'entry': 'src/concurrent.rs'}}

                class Opponent(sender.Door):
                    def play(self, method, key, given):
                        if method == 'write' and scenario != 'positive':
                            state = json.loads(account.read_text())
                            state['records'][rid] = competitor
                            account.write_text(json.dumps(state))
                        return super().play(method, key, given)

                old = [] if scenario == 'create' else [{'id': rid, 'type': kind, 'value': before}]
                desired = [{'id': rid, 'type': kind, 'value': None if scenario == 'remove' else after}]
                with patch.dict(os.environ, {'FAKE_DOOR': str(account)}):
                    status = sender.send(Opponent(config, root / 'transport'), payload(desired), root / 'status.json',
                                         lambda _: None, payload(old))
                held = json.loads(account.read_text())
                if scenario == 'positive':
                    self.assertEqual(status['state'], 'all_written')
                    self.assertEqual(held['records'][rid]['value'], after)
                else:
                    self.assertEqual(status['state'], 'stopped_on_refusal')
                    self.assertIn('original_command_conflict', status['last_refusal']['answer'])
                    self.assertEqual(held['records'][rid], competitor)
                    self.assertEqual(held['keys'], {}, 'no refused write is recorded as an accepted effect')
                self.assertNotIn('expected', desired[0], 'the original fresh input was not rewritten in place')

    def test_a_pending_original_is_not_remerged_or_rekeyed(self):
        with tempfile.TemporaryDirectory(prefix='registry-pending-') as temporary:
            root = Path(temporary)
            path = root / 'status.json'
            original = {'state': 'stopped_on_refusal', 'done': {}, 'last_refusal': {
                'request_key': 'original-key', 'answer': json.dumps({'outcome': 'unknown', 'code': 'original_command_outcome_unknown'})}}
            path.write_text(json.dumps(original))
            class Unused:
                config = {}
                def play(self, *_):
                    raise AssertionError('no request may be dispatched')
            with self.assertRaisesRegex(ValueError, 'original command outcome recovered'):
                sender.send(Unused(), payload([]), path, baseline=payload([]))
            self.assertEqual(json.loads(path.read_text()), original)
            record = {'id': 'record:capability:engine-same-job', 'type': 'record:capability', 'value': {}, 'expected': None}
            with self.assertRaisesRegex(ValueError, 'fresh unconditioned'):
                sender.refresh_records([record], payload([]), {})


if __name__ == '__main__':
    if len(sys.argv) == 7 and sys.argv[1] == '--qualify-source':
        mapping_path, definitions_path, registry_root = map(Path, sys.argv[2:5])
        source_name, expected_id = sys.argv[5:7]
        mapping = json.loads(mapping_path.read_text())
        source = next(row for row in mapping['sources'] if row['name'] == source_name)
        mapping.update(sources=[source], emit=[source['list']], emit_definitions=False,
                       lists_file={'root': 'schema', 'path': definitions_path.name})
        roots = {source['rows']['file']['root']: registry_root, 'schema': definitions_path.parent}
        result = records_write.build(mapping, roots, '2026-01-01T00:00:00Z')
        records = [row for command in result['commands'] for row in command['input']['records']]
        selected = [row for row in records if row['id'] == expected_id]
        if len(selected) != 1 or not (registry_root / selected[0]['value']['entry']).is_file():
            raise AssertionError('The exact existing source identity and current entry were not retained.')
        print(json.dumps({'source': source_name, 'records': len(records), 'selected': selected[0]}, indent=2))
    else:
        unittest.main()

"""Stable declaration keys through the existing builder: an explicit key keeps its record when its label and paths change.

The fixtures are temporary synthetic files. The write planner's refresh and conflict checks are in test_record_write_plan.py.
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

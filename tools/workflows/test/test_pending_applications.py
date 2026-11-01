"""The maintained pending consumer, gate and native grant adapters share DATA."""
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'read-data'))
sys.path.insert(0, str(HERE.parent / 'do-work'))
import test_library_checks
from gate_library import Library
from gate_answers import gate, record_answer
from library_applications import pending_applications, record_applications, identity_of
import native_checklist_gate as native


class PendingApplications(test_library_checks.LibraryCheckCase):
    def context(self, identity='monday'):
        schema = json.loads(self.schema.read_text())
        schema['library_checks']['context'] = {'id': identity, 'targets': ['target.json'], 'purpose': 'Prepare this actual sandwich batch.'}
        self.write('target.json', {'batch': 'monday'})
        self.write('schema.json', schema)

    def judgment(self, row, disposition='not-applicable'):
        return {'source_id': row['source_id'], 'assessed_source_identity': row['source_identity'],
                'prior_identity': row['prior_identity'], 'disposition': disposition,
                'because': 'This task prepares dough; slicing is outside this target.',
                'review': {'assessment': 'Read continuous source: cooling matters for slicing, not this preparation-only task.', 'evidence': 'https://example.org/lesson#30'}}

    def submit(self, batch, judgments, remove=False):
        return record_applications(self.lib(), {'context_identity': batch['context']['identity'], 'by': 'baker-reviewer', 'judgments': judgments}, remove)

    def test_pending_advances_and_source_target_changes_reopen_exclusions(self):
        self.context()
        first = pending_applications(self.lib(), 1)
        self.assertEqual(first['batch'][0]['source_id'], 'bake-1')
        self.submit(first, [self.judgment(first['batch'][0])])
        second = pending_applications(self.lib(), 1)
        self.assertEqual(second['batch'][0]['source_id'], 'bake-2')
        self.assertEqual(second['pending_count'], 1)
        self.rows[0]['statement'] = 'Wash hands before preparation.'
        (self.root / 'sources.jsonl').write_text('\n'.join(json.dumps(row) for row in self.rows))
        self.assertEqual(pending_applications(self.lib(), 1)['batch'][0]['source_id'], 'bake-1')
        self.assertIn('bake-1', self.lib().checklist['library_coverage']['unassessed'])
        self.write('target.json', {'batch': 'tuesday'})
        self.assertEqual(pending_applications(self.lib(), 1)['pending_count'], 2)

    def test_other_context_live_edits_and_retry_are_preserved(self):
        self.context()
        first = pending_applications(self.lib(), 1)
        judgment = self.judgment(first['batch'][0])
        other = {'source_id': 'bake-1', 'context_id': 'other', 'because': 'Independent live edit.'}
        self.write('applications.json', [self.selection, other])
        self.submit(first, [judgment])
        before = json.loads((self.root / 'applications.json').read_text())
        self.submit(first, [judgment])
        self.assertEqual(before, json.loads((self.root / 'applications.json').read_text()))
        self.assertIn(other, before)
        legacy = json.loads(self.schema.read_text())
        del legacy['library_checks']['context']
        self.write('schema.json', legacy)
        self.assertEqual(self.lib().checklist['library_coverage']['applied'][0]['id'], 'L1.1')
        self.context()
        schema = json.loads(self.schema.read_text())
        schema['library_checks']['context']['id'] = 'another'
        self.write('schema.json', schema)
        self.assertEqual(pending_applications(self.lib(), 1)['pending_count'], 2)

    def test_stale_source_target_or_same_context_edit_is_refused_before_write(self):
        for changed in ('source', 'target', 'application'):
            self.setUp()
            self.context()
            first = pending_applications(self.lib(), 1)
            judgment = self.judgment(first['batch'][0])
            if changed == 'source':
                self.rows[0]['statement'] = 'Changed claim.'
                (self.root / 'sources.jsonl').write_text('\n'.join(json.dumps(row) for row in self.rows))
            elif changed == 'target':
                self.write('target.json', {'batch': 'changed'})
            else:
                self.write('applications.json', [{'source_id': 'bake-1', 'context_id': 'monday', 'because': 'Another reviewer saved this.'}])
            before = (self.root / 'applications.json').read_bytes()
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.submit(first, [judgment])
            self.assertEqual(before, (self.root / 'applications.json').read_bytes())

    def apply(self):
        first = pending_applications(self.lib(), 1)
        judgment = {**self.selection, 'prior_identity': first['batch'][0]['prior_identity'], 'review': {'assessment': 'Read continuous cooling advice.', 'evidence': 'https://example.org/lesson#30'}}
        self.submit(first, [judgment])
        return first, judgment

    def test_target_change_holds_applied_check_instead_of_removing_it(self):
        self.context()
        self.apply()
        self.write('target.json', {'batch': 'new'})
        self.assertEqual(self.lib().checklist['library_coverage']['held'][0]['id'], 'L1.1')
        with self.assertRaisesRegex(ValueError, 'is held'):
            record_answer(self.lib(), self.piece, 'L1.1', 'pass', 'An old answer does not prove this changed batch.', 'baker')

    def test_live_receipt_expiry_and_changed_rows_hold_and_reopen(self):
        self.context()
        schema = json.loads(self.schema.read_text())
        schema['library_checks']['sources'][0]['live_snapshot'] = {'file': 'live.json', 'at': 'read_at', 'records': 'records', 'max_age_seconds': 60}
        self.write('schema.json', schema)
        self.write('live.json', {'read_at': datetime.now(timezone.utc).isoformat(), 'records': self.rows})
        self.apply()
        for receipt in ({'read_at': (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat(), 'records': self.rows},
                        {'read_at': datetime.now(timezone.utc).isoformat(), 'records': []}):
            self.write('live.json', receipt)
            self.assertEqual(self.lib().checklist['library_coverage']['held'][0]['id'], 'L1.1')
            first = pending_applications(self.lib(), 1)
            self.assertEqual(first['batch'][0]['source_id'], 'bake-1')
            with self.assertRaisesRegex(ValueError, 'fresh live source'):
                self.submit(first, [self.judgment(first['batch'][0])])

    def test_removal_reopens_and_cannot_satisfy_a_required_check(self):
        self.context()
        self.apply()
        schema = json.loads(self.schema.read_text())
        schema['library_checks']['required_checks'] = ['L1.1']
        self.write('schema.json', schema)
        prior = next(row for row in json.loads((self.root / 'applications.json').read_text()) if row.get('context_id') == 'monday')
        batch = pending_applications(self.lib(), 1)
        removal = {'source_id': 'bake-1', 'prior_identity': identity_of(prior), 'because': 'Reopen this assessment for a new review.'}
        self.submit(batch, [removal], remove=True)
        self.submit(batch, [removal], remove=True)
        self.assertEqual(pending_applications(self.lib(), 1)['batch'][0]['source_id'], 'bake-1')
        report = gate(self.lib(), self.piece, [stage['id'] for stage in self.lib().checklist['stages']], [], start_first_record=False)
        self.assertFalse(report['all_passed'])
        self.assertIn('Expected library application checks were not evaluated', json.dumps(report))

    def test_held_response_is_bounded_and_not_repeated_as_new_work(self):
        self.context()
        first = pending_applications(self.lib(), 1)
        judgment = {**self.selection, 'disposition': 'held', 'held_until': 'Obtain safe temperature evidence.', 'prior_identity': first['batch'][0]['prior_identity'], 'review': {'assessment': 'Cooling advice lacks a safe temperature.', 'evidence': 'https://example.org/lesson#30'}}
        self.submit(first, [judgment])
        result = pending_applications(self.lib(), 1)
        self.assertEqual(result['held_count'], 1)
        self.assertLessEqual(len(result['held']), 1)
        self.assertEqual(result['batch'][0]['source_id'], 'bake-2')

    def test_grouped_import_snapshot_uses_existing_rows_without_another_store(self):
        self.context()
        self.write('import.json', {'commands': [{'input': {'records': [{'type': 'library', 'value': row} for row in self.rows] + [{'type': 'sources', 'value': {}}]}}]})
        schema = json.loads(self.schema.read_text())
        schema['library_checks']['sources'] = [{'file': 'import.json', 'row_groups': 'commands.input.records', 'where': {'type': 'library'}, 'fields': {'id': 'value.id', 'statement': 'value.statement', 'sources': 'value.sources'}}]
        self.write('schema.json', schema)
        self.assertEqual(pending_applications(self.lib(), 1)['available'], 2)

    def payload(self, command, writable=False):
        return {'input': {'schema': 'schema.json', 'command': command}, 'task': {'grants': {'change-a-folder' if writable else 'read-a-folder': {'folder': str(self.root)}}}}

    def test_managed_grant_adapters_read_assess_and_remove_through_same_owner(self):
        self.context()
        read = native.execute(self.payload('library-pending --limit 1'))
        self.assertEqual(read['exit_code'], 0)
        batch = read['result']
        self.write('submit.json', {'context_identity': batch['context']['identity'], 'by': 'baker', 'judgments': [self.judgment(batch['batch'][0])]})
        for command in ('library-assess --json submit.json', 'library-remove --json submit.json'):
            with self.assertRaisesRegex(ValueError, 'write-grant'):
                native.arguments(self.payload(command), False)
        saved = native.execute(self.payload('library-assess --json submit.json', True), True)
        self.assertEqual(saved['exit_code'], 0, saved)
        prior = next(row for row in json.loads((self.root / 'applications.json').read_text()) if row.get('context_id') == 'monday')
        self.write('remove.json', {'context_identity': batch['context']['identity'], 'by': 'baker', 'judgments': [{'source_id': 'bake-1', 'prior_identity': identity_of(prior), 'because': 'Reopen.'}]})
        removed = native.execute(self.payload('library-remove --json remove.json', True), True)
        self.assertEqual(removed['exit_code'], 0, removed)
        self.assertEqual(removed['result']['pending']['pending_count'], 2)
        with self.assertRaisesRegex(ValueError, 'read-only'):
            record_applications(Library(self.root, self.schema, read_only=True), {}, True)


if __name__ == '__main__':
    unittest.main()

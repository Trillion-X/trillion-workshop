"""Source advice becomes scoped checks in the existing gate, with fresh pins."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'read-data'))
import bakery
import checklist_rows
from gate_library import Library, blake3_of
from gate_answers import record_answer, gate
from library_checks import pending_applications, record_applications, context_state, source_identity_of

class LibraryCheckCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root, self.schema = bakery.build(Path(self.tmp.name))
        base = checklist_rows.generate(Library(self.root, self.schema))
        base['stages'].append({'id': 'L1', 'name': 'Chosen learning', 'checks': []})
        self.write('checklist.json', base)
        self.rows = [{'id': 'bake-1', 'statement': 'Let a loaf cool before slicing.', 'sources': [{'quote': 'let it cool first', 'url': 'https://example.org/lesson#30'}]},
                     {'id': 'bake-2', 'statement': 'Another possible technique.', 'sources': [{'quote': 'another technique'}]}]
        self.selection = {'source_id': 'bake-1', 'id': 'L1.1', 'disposition': 'apply', 'because': 'This batch will be sliced for a sandwich.', 'stage': 'L1', 'check': 'Was the loaf cooled before slicing?', 'verify': 'Record loaf temperature and slicing time.', 'routes': 'all'}
        schema = json.loads(self.schema.read_text())
        schema['library_checks'] = {'sources': [{'file': 'sources.jsonl', 'fields': {'id': 'id', 'statement': 'statement', 'sources': 'sources'}, 'citation': {'text': 'quote', 'locators': ['url']}}], 'applications': {'file': 'applications.json'}}
        self.write('schema.json', schema)
        identity = blake3_of(json.dumps(self.rows[0], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
        self.selection['assessed_source_identity'] = identity
        self.selection['support'] = {'status': 'supported', 'assessment': 'The source directly tells us to cool the loaf before slicing; this claim makes no stronger promise.', 'source_identity': identity, 'source_indices': [0]}
        self.save()
        self.piece = self.root / 'batches/monday'
    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))
    def save(self):
        (self.root / 'sources.jsonl').write_text('\n'.join(json.dumps(r) for r in self.rows))
        self.write('applications.json', [self.selection])
    def lib(self):
        return Library(self.root, self.schema)
    def test_source_application_reaches_gate_and_changed_quote_reopens_it(self):
        lib = self.lib()
        self.assertEqual(lib.checklist['library_coverage']['unassessed'], ['bake-2'])
        self.assertFalse(gate(lib, self.piece, ['L1'], [], start_first_record=False)['all_passed'])
        record_answer(lib, self.piece, 'L1.1', 'pass', 'Loaf measured 24C before the first slice.', 'baker')
        self.assertTrue(gate(self.lib(), self.piece, ['L1'], [], start_first_record=False)['all_passed'])
        self.rows[0]['sources'][0]['quote'] = 'cool it to room temperature first'
        self.save()
        report = gate(self.lib(), self.piece, ['L1'], [], start_first_record=False)
        self.assertFalse(report['all_passed'])
        self.assertIn('Review whether the current source supports', json.dumps(report))
    def test_quote_presence_cannot_substitute_for_support(self):
        for status in ('uncertain', 'unsupported'):
            self.selection['support']['status'] = status
            self.save()
            report = gate(self.lib(), self.piece, ['L1'], [], start_first_record=False)
            self.assertFalse(report['all_passed'])
            self.assertEqual(report['library_coverage']['held'], 1)
            with self.assertRaisesRegex(ValueError, 'is held'):
                record_answer(self.lib(), self.piece, 'L1.1', 'pass', 'Exact quote exists so the unsupported stronger claim is true.', 'writer')
        del self.selection['support']
        self.save()
        self.assertFalse(gate(self.lib(), self.piece, ['L1'], [], start_first_record=False)['all_passed'])

    def test_not_applicable_is_bound_to_the_assessed_source(self):
        self.selection['disposition'] = 'not-applicable'
        self.save()
        self.assertEqual(self.lib().checklist['library_coverage']['not_applicable'][0]['source_id'], 'bake-1')
        self.rows[0]['statement'] = 'Clean preparation surfaces before starting.'
        self.save()
        with self.assertRaisesRegex(ValueError, 'applicability assessment is missing or stale'):
            _ = self.lib().checklist

    def test_empty_source_citations_are_held_even_with_a_claimed_support_review(self):
        self.rows[0]['sources'] = [{}]
        identity = blake3_of(json.dumps(self.rows[0], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
        self.selection['assessed_source_identity'] = identity
        self.selection['support']['source_identity'] = identity
        self.save()
        self.assertEqual(self.lib().checklist['library_coverage']['held'][0]['source_id'], 'bake-1')

    def test_an_unmatched_route_is_reported_and_cannot_satisfy_a_required_application(self):
        self.selection['routes'] = 'medum:bread'
        self.save()
        report = gate(self.lib(), self.piece, ['L1'], [], start_first_record=False)
        self.assertEqual(report['library_evaluation']['evaluated'], [])
        self.assertEqual(report['library_evaluation']['not_evaluated'][0]['reason'], 'route did not match')
        schema = json.loads(self.schema.read_text())
        schema['library_checks']['required_checks'] = ['L1.1']
        self.write('schema.json', schema)
        report = gate(self.lib(), self.piece, ['L1'], [], start_first_record=False)
        self.assertFalse(report['all_passed'])
        self.assertIn('Expected library application checks were not evaluated', json.dumps(report))

    def test_a_held_source_cannot_be_marked_passed(self):
        self.selection.update(disposition='held', held_until='Find a source giving the safe temperature.')
        self.save()
        with self.assertRaisesRegex(ValueError, 'is held'):
            record_answer(self.lib(), self.piece, 'L1.1', 'pass', 'The writer believes it is fine.', 'baker')
        self.assertFalse(gate(self.lib(), self.piece, ['L1'], [], start_first_record=False)['all_passed'])
    def test_unknown_source_and_missing_applicability_are_refused(self):
        self.selection['source_id'] = 'absent'; self.save()
        with self.assertRaisesRegex(ValueError, 'source not found'):
            _ = self.lib().checklist
        self.selection['source_id'] = 'bake-1'; self.selection['because'] = ''; self.save()
        with self.assertRaisesRegex(ValueError, 'because'):
            _ = self.lib().checklist
    def test_removed_application_preserves_base(self):
        self.write('applications.json', [])
        self.assertEqual(self.lib().checklist['library_coverage']['unassessed'], ['bake-1', 'bake-2'])
        self.assertNotIn('L1.1', self.lib().checks())
        self.assertEqual(json.loads((self.root / 'checklist.json').read_text())['stages'][-1]['checks'], [])

    def context(self, identity='monday'):
        schema = json.loads(self.schema.read_text())
        schema['library_checks']['context'] = {'id': identity, 'targets': ['target.json'], 'purpose': 'Prepare this actual sandwich batch.'}
        self.write('target.json', {'batch': 'monday'})
        self.write('schema.json', schema)

    def judgment(self, item, disposition='not-applicable'):
        return {'source_id': item['source_id'], 'assessed_source_identity': item['source_identity'],
                'prior_identity': item['prior_identity'], 'disposition': disposition,
                'because': 'This is a preparation-only task; slicing is outside this target.',
                'review': {'assessment': 'The source speaks about slicing a cooled loaf, not preparation.', 'evidence': 'https://example.org/lesson#30, continuous source read'}}

    def submit(self, batch, judgments):
        return record_applications(self.lib(), {'context_identity': batch['context']['identity'], 'by': 'baker-reviewer', 'judgments': judgments})

    def test_pending_advances_without_a_cursor_and_changes_reopen_exclusions(self):
        self.context()
        first = pending_applications(self.lib(), 1)
        self.assertEqual(first['batch'][0]['source_id'], 'bake-1')
        self.submit(first, [self.judgment(first['batch'][0])])
        second = pending_applications(self.lib(), 1)
        self.assertEqual(second['batch'][0]['source_id'], 'bake-2')
        self.assertEqual(second['pending_count'], 1)
        self.rows[0]['statement'] = 'Wash hands before preparation.'
        (self.root / 'sources.jsonl').write_text('\n'.join(json.dumps(r) for r in self.rows))
        self.assertEqual(pending_applications(self.lib(), 1)['batch'][0]['source_id'], 'bake-1')
        self.assertIn('bake-1', self.lib().checklist['library_coverage']['unassessed'])
        self.rows[0]['statement'] = 'Let a loaf cool before slicing.'
        (self.root / 'sources.jsonl').write_text('\n'.join(json.dumps(r) for r in self.rows))
        self.write('target.json', {'batch': 'tuesday'})
        self.assertEqual(pending_applications(self.lib(), 1)['batch'][0]['source_id'], 'bake-1')

    def test_other_context_live_edit_and_retry_survive_a_bounded_submission(self):
        self.context()
        first = pending_applications(self.lib(), 1)
        judgment = self.judgment(first['batch'][0])
        other = {'source_id': 'bake-1', 'context_id': 'other', 'because': 'Keep this independent live edit.'}
        self.write('applications.json', [self.selection, other])
        self.submit(first, [judgment])
        before = json.loads((self.root / 'applications.json').read_text())
        self.submit(first, [judgment])
        after = json.loads((self.root / 'applications.json').read_text())
        self.assertEqual(before, after)
        self.assertIn(other, after)
        self.context('another-work-context')
        self.assertEqual(pending_applications(self.lib(), 1)['batch'][0]['source_id'], 'bake-1')

    def test_stale_source_target_or_same_context_edit_is_refused_before_write(self):
        for changed in ('source', 'target', 'application'):
            self.setUp()
            self.context()
            first = pending_applications(self.lib(), 1)
            judgment = self.judgment(first['batch'][0])
            if changed == 'source':
                self.rows[0]['statement'] = 'Changed claim.'
                (self.root / 'sources.jsonl').write_text('\n'.join(json.dumps(r) for r in self.rows))
            elif changed == 'target':
                self.write('target.json', {'batch': 'changed'})
            else:
                self.write('applications.json', [{'source_id': 'bake-1', 'context_id': 'monday', 'because': 'Another reviewer saved this.'}])
            before = (self.root / 'applications.json').read_bytes()
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.submit(first, [judgment])
            self.assertEqual(before, (self.root / 'applications.json').read_bytes())

    def test_target_change_holds_an_applied_check_instead_of_silently_removing_it(self):
        self.context()
        first = pending_applications(self.lib(), 1)
        judgment = {**self.selection, 'prior_identity': first['batch'][0]['prior_identity'], 'review': {'assessment': 'Read continuous cooling advice.', 'evidence': 'https://example.org/lesson#30'}}
        self.submit(first, [judgment])
        self.assertEqual(self.lib().checklist['library_coverage']['applied'][0]['id'], 'L1.1')
        self.write('target.json', {'batch': 'new'})
        self.assertEqual(self.lib().checklist['library_coverage']['held'][0]['id'], 'L1.1')
        with self.assertRaisesRegex(ValueError, 'is held'):
            record_answer(self.lib(), self.piece, 'L1.1', 'pass', 'An old answer is no longer evidence for this changed batch.', 'baker')

    def test_limits_missing_context_and_read_only_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'context'):
            pending_applications(self.lib())
        self.context()
        for limit in (0, 257, True):
            with self.assertRaises(ValueError):
                pending_applications(self.lib(), limit)
        first = pending_applications(self.lib(), 1)
        with self.assertRaisesRegex(ValueError, 'read-only'):
            record_applications(Library(self.root, self.schema, read_only=True), {'context_identity': first['context']['identity'], 'by': 'baker', 'judgments': [self.judgment(first['batch'][0])]})
if __name__ == '__main__':
    unittest.main()

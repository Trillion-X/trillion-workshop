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
if __name__ == '__main__':
    unittest.main()

"""Tests for the quote locator, the frame-manifest projection and the page journal, on made-up bytes and captions.
Run: python3 -I -m unittest discover -s tools/keep-a-record-library-valid/test -v   (or npm test)"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL / 'read-data'))
import frame_evidence  # noqa: E402
import quote_locator  # noqa: E402
from library import content_identity  # noqa: E402

HAS_BLAKE3 = importlib.util.find_spec('blake3') is not None or shutil.which('b3sum') is not None
needs_blake3 = unittest.skipUnless(HAS_BLAKE3, 'a file identity is BLAKE3: install the blake3 python module or the b3sum command')
HAS_PILLOW = importlib.util.find_spec('PIL') is not None

PROFILE = {
    'projection_schema': 'frames-blake3/v1',
    'journal_schema': 'page-journal@1',
    'journal_final_status': 'final',
    'observation_schema': 'page-observation@1',
    'readback_schema': 'page-readback@1',
    'state_field': 'held_state',
    'readback_hash_field': 'frame_blake3',
    'validation_scope': 'Structure and file identity only.',
}


class QuoteLocator(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='quote-locator-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.transcript = self.root / 'source.txt'
        self.json3 = self.root / 'source.json3'

    def sources(self, transcript: str, events: list[dict]):
        self.transcript.write_text(transcript, encoding='utf-8')
        self.json3.write_text(json.dumps({'events': events}), encoding='utf-8')

    def test_caption_seconds_do_not_become_physical_line_numbers_and_span_is_minimal(self):
        self.sources(
            'context before\n[00:17:40] A bright\nidea\nextra citation context\n',
            [
                {'tStartMs': 1000000, 'dDurationMs': 400, 'segs': [{'utf8': 'A bright'}]},
                {'tStartMs': 1000400, 'dDurationMs': 600, 'segs': [{'utf8': ' idea'}]},
            ],
        )
        result = quote_locator.locate_quote(self.transcript, self.json3, 'A bright\nidea')
        self.assertEqual(result['physical_lf_lines'], [2, 3])
        self.assertEqual(result['caption_exposure_seconds'], [1000.0, 1001.0])
        self.assertEqual(result['json3_event_indices'], [0, 1])

    def test_zero_start_is_valid_and_false_values_are_preserved(self):
        self.sources('zero time\n', [{'tStartMs': 0, 'dDurationMs': 0, 'segs': [{'utf8': 'zero time'}]}])
        result = quote_locator.locate_quote(self.transcript, self.json3, 'zero time')
        self.assertEqual(result['caption_exposure_seconds'], [0.0, 0.0])

    def test_lowercase_normalization_does_not_casefold_sharp_s(self):
        self.sources('straße\n', [{'tStartMs': 0, 'dDurationMs': 1, 'segs': [{'utf8': 'straße'}]}])
        with self.assertRaisesRegex(ValueError, 'transcript; found 0'):
            quote_locator.locate_quote(self.transcript, self.json3, 'strasse')

    def test_empty_punctuation_absent_and_repeated_quotes_are_refused(self):
        self.sources('one two\none two\n', [{'tStartMs': 0, 'dDurationMs': 1, 'segs': [{'utf8': 'one two'}]}])
        for quote in ('', '... !!!'):
            with self.subTest(quote=quote), self.assertRaisesRegex(ValueError, 'at least one'):
                quote_locator.locate_quote(self.transcript, self.json3, quote)
        with self.assertRaisesRegex(ValueError, 'transcript; found 2'):
            quote_locator.locate_quote(self.transcript, self.json3, 'one two')
        self.sources('one two\n', [{'tStartMs': 0, 'dDurationMs': 1, 'segs': [{'utf8': 'one two'}, {'utf8': ' one two'}]}])
        with self.assertRaisesRegex(ValueError, 'JSON3 source; found 2'):
            quote_locator.locate_quote(self.transcript, self.json3, 'one two')
        with self.assertRaisesRegex(ValueError, 'transcript; found 0'):
            quote_locator.locate_quote(self.transcript, self.json3, 'not here')
        self.sources('one two\n', [{'tStartMs': 0, 'dDurationMs': 1, 'segs': [{'utf8': 'other words'}]}])
        with self.assertRaisesRegex(ValueError, 'JSON3 source; found 0'):
            quote_locator.locate_quote(self.transcript, self.json3, 'one two')

    def test_missing_or_malformed_matching_timing_is_refused(self):
        cases = (
            ([{'dDurationMs': 1, 'segs': [{'utf8': 'exact words'}]}], 'requires numeric tStartMs'),
            ([{'tStartMs': 0, 'dDurationMs': '1', 'segs': [{'utf8': 'exact words'}]}], 'requires numeric dDurationMs'),
            ([{'tStartMs': 0, 'dDurationMs': -1, 'segs': [{'utf8': 'exact words'}]}], 'must be nonnegative'),
            ([{'tStartMs': -1, 'dDurationMs': 1, 'segs': [{'utf8': 'exact words'}]}], 'start times must be nonnegative'),
            ([{'tStartMs': 1e308, 'dDurationMs': 1e308, 'segs': [{'utf8': 'exact words'}]}], 'endpoint must be finite'),
        )
        for events, message in cases:
            with self.subTest(message=message):
                self.sources('exact words\n', events)
                with self.assertRaisesRegex(ValueError, message):
                    quote_locator.locate_quote(self.transcript, self.json3, 'exact words')
        self.sources('first second\n', [
            {'tStartMs': 3000, 'dDurationMs': 1, 'segs': [{'utf8': 'first'}]},
            {'tStartMs': 1000, 'dDurationMs': 1000, 'segs': [{'utf8': ' second'}]},
        ])
        with self.assertRaisesRegex(ValueError, 'must not precede its start'):
            quote_locator.locate_quote(self.transcript, self.json3, 'first second')

    def test_type_and_caption_structure_errors_are_precise(self):
        self.sources('quote\n', [{'tStartMs': 0, 'dDurationMs': 1, 'segs': [{'utf8': 'quote'}]}])
        with self.assertRaisesRegex(TypeError, 'quote must be text'):
            quote_locator.locate_quote(self.transcript, self.json3, None)
        with self.assertRaisesRegex(TypeError, 'source paths'):
            quote_locator.locate_quote(3, self.json3, 'quote')
        self.json3.write_text(json.dumps({'events': [{'segs': 'bad'}]}), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'segs must be an array'):
            quote_locator.locate_quote(self.transcript, self.json3, 'quote')

    def test_boolean_nonfinite_and_overflowed_caption_numbers_are_refused(self):
        for field in ('tStartMs', 'dDurationMs'):
            for value in (True, False, float('nan'), float('inf'), 10 ** 400):
                with self.subTest(field=field, value_type=type(value).__name__):
                    event = {'tStartMs': 0, 'dDurationMs': 1, 'segs': [{'utf8': 'exact words'}]}
                    event[field] = value
                    self.sources('exact words\n', [event])
                    with self.assertRaises(ValueError):
                        quote_locator.locate_quote(self.transcript, self.json3, 'exact words')

    def test_cli_reads_a_quote_file_without_a_library(self):
        self.sources('[999] exact words\n', [{'tStartMs': 0, 'dDurationMs': 5, 'segs': [{'utf8': 'exact words'}]}])
        quote = self.root / 'quote.txt'
        quote.write_text('exact words', encoding='utf-8')
        command = [sys.executable, '-I', str(TOOL / 'do-work' / 'keep_a_record_library.py'),
                   'locate-quote', '--transcript', str(self.transcript), '--json3', str(self.json3), '--quote-file', str(quote)]
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['physical_lf_lines'], [1, 1])
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)
        quote.write_text('!!!', encoding='utf-8')
        refused = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(refused.returncode, 2)
        self.assertEqual(refused.stdout, '')
        self.assertIn('at least one', refused.stderr)
        self.assertNotIn('Traceback', refused.stderr)


@needs_blake3
class FrameManifest(unittest.TestCase):
    def test_projection_keeps_order_and_only_computed_blake3_identities(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, f0, f1 = root / 'source.mp4', root / 'f0.png', root / 'f1.png'
            source.write_bytes(b'source')
            f0.write_bytes(b'frame-0')
            f1.write_bytes(b'frame-1')
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({
                'schema': 'vendor', 'vendor_hash': 'discard',
                'source': {'path': 'source.mp4', 'sha256': 'discard', 'blake3': 'discard', 'bytes': 6},
                'frames': [
                    {'index': 2, 'pts': 2, 'seconds': 2.0, 'path': 'f1.png', 'sha256': 'discard', 'blake3': 'discard'},
                    {'index': 1, 'pts': 1, 'seconds': 1.0, 'path': 'f0.png', 'vendor_hash': 'discard'},
                ],
            }))
            result = frame_evidence.normalize_manifest(manifest, PROFILE['projection_schema'])
            self.assertEqual(result['schema'], PROFILE['projection_schema'])
            self.assertEqual([row['index'] for row in result['frames']], [2, 1])
            self.assertEqual(result['frames'][0]['identity'], content_identity(f1))
            self.assertEqual(result['vendor_manifest']['identity'], content_identity(manifest))
            serialized = json.dumps(result).casefold()
            self.assertNotIn('sha256', serialized)
            self.assertNotIn('vendor_hash', serialized)
            self.assertEqual(result['source']['identity']['algorithm'], 'blake3')

    def test_a_profile_missing_a_label_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'journal_schema'):
            frame_evidence.check_profile({k: v for k, v in PROFILE.items() if k != 'journal_schema'})


class PageEvidence(unittest.TestCase):
    """A made-up source, two frames, one contact sheet and the notes a reviewer writes for them."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='page-journal-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.source = self.tmp / 'source.mp4'
        self.source.write_bytes(b'source')
        self.frames = []
        for index in range(2):
            path = self.tmp / f'frame-{index}.png'
            path.write_bytes(f'frame-{index}'.encode())
            self.frames.append({'index': index, 'pts': index * 1001, 'seconds': index * 1001 / 24000,
                                'path': str(path), 'identity': content_identity(path)})
        self.manifest = self.tmp / 'manifest.json'
        self._write(self.manifest, {'schema': 'vendor', 'source': {'path': str(self.source), 'video': {
            'time_base': '1/24000', 'first_pts': 0, 'origin_timestamp': 0}},
            'frames': [{k: row[k] for k in ('index', 'pts', 'seconds', 'path')} | {'sha256': 'vendor'} for row in self.frames]})
        self.sheet = self.tmp / 'contact.jpg'
        self.sheet.write_bytes(b'contact sheet')
        self.observation = self.tmp / 'PAGE-01-OBSERVATION.json'
        self.readback = self.tmp / 'PAGE-01-READBACK.json'
        sheet_identity = content_identity(self.sheet)
        self._write(self.observation, {'schema': PROFILE['observation_schema'], 'page': 1, 'readback': str(self.readback),
            'contact_sheet': str(self.sheet), 'contact_sheet_blake3': sheet_identity['value'], 'visual_review': 'Inspected contact sheet',
            'frames': [{'index': row['index'], 'pts': row['pts'], 'seconds': row['seconds'], 'path': row['path'],
                        'blake3': row['identity']['value'], 'visual_observation': 'Same hold remains visible.',
                        PROFILE['state_field']: 'hold'} for row in self.frames]})
        self._write(self.readback, {'schema': PROFILE['readback_schema'], 'page': 1, 'contact_sheet': str(self.sheet),
            'contact_sheet_blake3': sheet_identity['value'], 'contact_sheet_bytes': sheet_identity['bytes'],
            'frame_observations': 'reviewed; frame-specific rows are persisted in the paired observation record',
            'frame_observation_path': str(self.observation), 'frame_observation_blake3': content_identity(self.observation)['value'],
            'frames': [{'index': row['index'], 'pts': row['pts'], 'seconds': row['seconds'], 'path': row['path'],
                        'bytes': row['identity']['bytes'], PROFILE['readback_hash_field']: row['identity']['value']} for row in self.frames]})
        source_identity = content_identity(self.source)
        self.extraction = self.tmp / 'EXTRACTION-READBACK.json'
        self._write(self.extraction, {'source': {'bytes': source_identity['bytes'], 'blake3_before': source_identity['value'],
                                                 'blake3_after': source_identity['value']},
            'frames': [{'index': row['index'], 'bytes': row['identity']['bytes'], 'blake3': row['identity']['value']} for row in self.frames]})
        self.output = self.tmp / 'admission' / 'PAGE-READBACK.json'

    @staticmethod
    def _write(path, value):
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

    def _edit_readback(self, change):
        value = json.loads(self.readback.read_text())
        change(value)
        self._write(self.readback, value)

    def _finalize(self):
        return frame_evidence.finalize_page_journal(self.manifest, self.extraction, [self.observation], [self.readback], self.output, PROFILE)


@needs_blake3
class PageJournal(PageEvidence):
    def test_repeated_hold_notes_pass_and_validator_rechecks_current_bytes(self):
        result = self._finalize()
        self.assertEqual(result['frame_count'], 2)
        self.assertEqual(result['status'], 'valid')
        journal = json.loads(self.output.read_text())
        self.assertEqual((journal['schema'], journal['status']), (PROFILE['journal_schema'], PROFILE['journal_final_status']))
        self.assertEqual(frame_evidence.validate_page_journal(self.output, PROFILE)['status'], 'valid')
        self.sheet.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Stale page 1 contact sheet identity'):
            frame_evidence.validate_page_journal(self.output, PROFILE)

    def test_aggregate_note_cannot_drift_from_pinned_observation(self):
        self._finalize()
        journal = json.loads(self.output.read_text())
        journal['pages'][0]['frames'][0]['visual_observation'] = 'altered aggregate note'
        self._write(self.output, journal)
        with self.assertRaisesRegex(ValueError, 'aggregate note differs'):
            frame_evidence.validate_page_journal(self.output, PROFILE)

    def test_a_journal_in_another_status_or_schema_is_not_accepted(self):
        self._finalize()
        for member, value, message in (('status', 'pending', 'not in final status'), ('schema', 'other@1', 'Unsupported page journal schema')):
            journal = json.loads(self.output.read_text())
            journal[member] = value
            copy = self.output.with_name(f'{member}.json')
            self._write(copy, journal)
            with self.subTest(member=member), self.assertRaisesRegex(ValueError, message):
                frame_evidence.validate_page_journal(copy, PROFILE)

    def test_pending_readback_fails(self):
        self._edit_readback(lambda rb: rb.update(frame_observations='pending visual review'))
        with self.assertRaisesRegex(ValueError, 'not final'):
            self._finalize()
        self.assertFalse(self.output.exists())

    def test_missing_frame_join_fails(self):
        self._edit_readback(lambda rb: rb['frames'].pop())
        with self.assertRaisesRegex(ValueError, 'frame rows do not join'):
            self._finalize()

    def test_duplicate_frame_join_fails(self):
        self._edit_readback(lambda rb: rb['frames'][1].update(index=rb['frames'][0]['index']))
        with self.assertRaisesRegex(ValueError, 'duplicate readback frame join'):
            self._finalize()

    def test_stale_frame_identity_fails(self):
        self._edit_readback(lambda rb: rb['frames'][0].update({PROFILE['readback_hash_field']: '0' * 64}))
        with self.assertRaisesRegex(ValueError, 'BLAKE3 is stale'):
            self._finalize()

    def test_an_existing_journal_is_never_overwritten(self):
        self._finalize()
        with self.assertRaisesRegex(ValueError, 'Refusing to overwrite'):
            self._finalize()

    def test_the_cli_finalizes_and_validates_with_the_profile_from_the_schema(self):
        schema = self.tmp / 'schema.json'
        schema.write_text(json.dumps({'frame_evidence': PROFILE}))
        program = [sys.executable, '-I', str(TOOL / 'do-work' / 'keep_a_record_library.py'), '--schema', str(schema)]
        done = subprocess.run([*program, 'finalize-page-journal', '--manifest', str(self.manifest), '--extraction-readback', str(self.extraction),
                               '--page-observation', str(self.observation), '--page-readback', str(self.readback), '--output', str(self.output)],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        again = subprocess.run([*program, 'validate-page-journal', str(self.output)], capture_output=True, text=True)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)['status'], 'valid')
        missing = subprocess.run([sys.executable, '-I', str(TOOL / 'do-work' / 'keep_a_record_library.py'), 'validate-page-journal', str(self.output)],
                                 capture_output=True, text=True)
        self.assertEqual(missing.returncode, 2)
        self.assertIn('needs --schema', missing.stderr)


@unittest.skipUnless(HAS_PILLOW, 'review pages need Pillow')
class ReviewPages(unittest.TestCase):
    def setUp(self):
        from PIL import Image
        self.tmp = Path(tempfile.mkdtemp(prefix='review-pages-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        frames = []
        for index in range(5):
            path = self.tmp / f'f{index}.png'
            Image.new('RGB', (64, 36), (index * 40, 20, 90)).save(path)
            frames.append({'index': index, 'pts': index * 1001, 'seconds': index * 1001 / 24000, 'path': str(path)})
        source = self.tmp / 'source.mp4'
        source.write_bytes(b'source')
        self.manifest = self.tmp / 'manifest.json'
        self.manifest.write_text(json.dumps({'source': {'path': str(source), 'video': {'time_base': '1/24000', 'first_pts': 0, 'origin_timestamp': 0}},
                                             'frames': frames,
                                             'change_candidates': [{'index': 1}, {'index': 2}, {'index': 3}]}))

    @needs_blake3
    def test_pages_are_labelled_chunks_and_rebuilding_gives_the_same_bytes(self):
        first, second = self.tmp / 'a', self.tmp / 'b'
        result = frame_evidence.build_pages(self.manifest, first, 2, 160, 40)
        self.assertEqual((result['frame_count'], result['page_count']), (5, 3))
        frame_evidence.build_pages(self.manifest, second, 2, 160, 40)
        names = sorted(p.name for p in first.iterdir() if p.suffix == '.jpg')
        self.assertEqual(len(names), 3)
        for name in names:
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())

    @needs_blake3
    def test_candidate_pairs_pair_adjacent_frames(self):
        result = frame_evidence.build_candidate_pair_pages_from_manifest(self.manifest, self.tmp / "pairs", 2, 160, 40)
        self.assertEqual(result["pair_count"], 3)
        self.assertEqual(result['page_count'], 2)


if __name__ == '__main__':
    unittest.main()

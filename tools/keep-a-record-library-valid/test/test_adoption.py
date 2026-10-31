"""Tests for adopting a saved, reviewed packet of picture evidence, on a made-up greenhouse library and made-up frames.
Run: python3 -I -m unittest discover -s tools/keep-a-record-library-valid/test -v   (or npm test)"""
from __future__ import annotations

import copy
import io
import json
import shutil
import sys
import unittest
import unittest.mock
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'greenhouse'
TEMPLATE_TOOL = TOOL.parent / 'fill-a-template-without-changing-its-words'
sys.path.insert(0, str(TOOL / 'read-data'))
sys.path.insert(0, str(TOOL / 'do-work'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import adoption  # noqa: E402
import investigation  # noqa: E402
import json_patch  # noqa: E402
import keep_a_record_library as cli  # noqa: E402
from library import Store, content_identity, read_json, write_json  # noqa: E402
from test_frame_evidence import PROFILE as FRAME_PROFILE, PageEvidence, needs_blake3  # noqa: E402

QUESTION = 'QN-099'
LEAF = 'review'
PROFILE = {
    'registry': 'registry.json',
    'vocabulary': 'vocabulary.json',
    'spec_file': 'SPEC.json',
    'evidence_key': 'bed_evidence',
    'evidence_fields': {'journal_paths': 'journal_paths', 'retained_paths': 'retained_paths', 'retained_reviews': 'retained_reviews'},
    'review_kinds': {'finalized': 'finalized-pages', 'retained': 'retained-frame-notes'},
    'finalized_qualification': 'Finalized page structure only; no full review inferred.',
    'retained_qualification': 'Pinned saved files and clock joins only; no extraction record recovered.',
    'frame_ledger': {'artifact': 'frame_ledger', 'ledger_file': 'LEDGER.json', 'lessons_file': 'LESSONS.json'},
    'table': {'file': 'spans.tsv', 'reader': 'span_rows', 'id_column': '_id', 'id_prefix': 'span-', 'id_width': 2, 'start': 't0', 'end': 't1',
              'duration': 'secs', 'transition': 'cut_in', 'evidence': 'proof', 'scope': 'scope', 'unknown': 'unknown',
              'coverage_key': 'span_coverage', 'coverage_text': 'Partial:{rows} spans. {coverage}'},
    'scene_slot': {'id_prefix': 'scene-', 'type': 'SCENE', 'rule': 'R1', 'dims': ['span.action', 'span.place'], 'note': 'Replace the scene.'},
    'word': {'reader': 'word_rows', 'line_dim': 'text.word', 'slot_type': 'LABEL', 'rule': 'R1', 'slot_note': 'Replace the words.',
             'method': 'Reviewer reading', 'time_semantics': 'One readable frame.'},
    'files': {'journal': 'PAGE-READBACK.json', 'detail': 'DETAIL.json', 'detail_note': 'DETAIL.md', 'input_copy': 'ADOPTED-INPUT.json',
              'readback': 'ADOPTION-READBACK.json', 'membership_readback': 'MEMBERSHIP-READBACK.json', 'before_table': 'BEFORE-spans.tsv',
              'before_spec': 'BEFORE-SPEC.json', 'before_table_absent': 'BEFORE-spans-absent.json'},
    'membership_mode': 'bound_v1',
    'question': {'id': QUESTION, 'status': 'asked', 'label': 'Seen', 'note': 'Saved intervals adopted; consumer check follows.'},
    'source_evidence_only': {'schema': 'source_evidence_adoption@1', 'readback_schema': 'source_evidence_readback@1',
                             'before_spec': 'BEFORE-EVIDENCE-SPEC.json', 'before_investigation': 'BEFORE-EVIDENCE-INVESTIGATION.json',
                             'receipt': 'EVIDENCE-RECEIPT.json', 'pending_suffix': '.pending',
                             'preservation': 'Only the evidence member of the spec changed; the table and the question state stayed.'},
}


def run_cli(root, *argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        status = cli.main(['--library', str(root), '--schema', str(root / 'schema.json'), *argv])
    return status, out.getvalue(), err.getvalue()


@needs_blake3
class Adoption(PageEvidence):
    """The library (a copy of the made-up greenhouse) lives beside the evidence the base class writes, under one source root."""

    def setUp(self):
        super().setUp()
        self.root = self.tmp
        self.library = self.root
        shutil.copytree(FIXTURE, self.library, dirs_exist_ok=True)
        schema = read_json(self.library / 'schema.json')
        schema['frame_evidence'] = FRAME_PROFILE
        schema['adoption'] = PROFILE
        write_json(self.library / 'schema.json', schema)
        self.registry_seed = TEMPLATE_TOOL / 'read-data' / 'dimensions.json'
        (self.root / PROFILE['registry']).write_bytes(self.registry_seed.read_bytes())
        write_json(self.root / PROFILE['vocabulary'], {'fields': {}})
        self.store = Store(self.library, self.library / 'schema.json')
        self.piece = self.library / 'beds' / 'herb-bed'
        self.leaf = self.piece / LEAF
        self.leaf.mkdir()
        self.spec = self.piece / PROFILE['spec_file']
        self.spec_data = {'schema': 'spec@1', 'piece': {'id': 'herb-bed', PROFILE['evidence_key']: {
            'path': 'old/PHASES.json', 'scope': 'existing scope', 'additional_paths': ['prior.json']}},
            'slots': [{'id': 'old-slot'}], 'records': {'words': [{'id': 'old-word', 'fields': {'text': 'kept'}}]}}
        self.spec.write_text(json.dumps(self.spec_data, ensure_ascii=False, indent=2) + '\n')
        (self.piece / 'LOG.md').write_text('log\n')
        investigation.start(self.store, self.piece, 'spring-planting', limit=99)
        record_path, inv = investigation.load_inv(self.piece)
        inv['nodes'].append({'id': QUESTION, 'question': 'What is kept?', 'depends_on': [], 'status': 'asked', 'evidence': [],
                             'note': 'existing qualified note', 'label': 'Seen', 'defect': False, 'caught_by': []})
        write_json(record_path, inv)
        self.input_path = self.root / 'adoption-input.json'
        self.evidence_files = [self.manifest, self.extraction, self.observation, self.readback, self.sheet]
        self.finalized = False

    def finalize(self):
        self._finalize()
        self.finalized = True
        self.evidence_files = [*self.evidence_files, self.output]
        self.write_input(self.output, self.evidence_files)

    def rel(self, path):
        return str(Path(path).relative_to(self.root))

    def write_input(self, journal, evidence_files, **extra):
        self.input_path.write_text(json.dumps({
            'schema': PROFILE['source_evidence_only']['schema'], 'piece': self.rel(self.piece), 'leaf': LEAF,
            'spec_path': PROFILE['spec_file'], 'before_spec_identity': content_identity(self.spec), 'question_id': QUESTION,
            'journal_path': self.rel(journal), 'evidence_paths': [self.rel(p) for p in evidence_files],
            'appended_scope': 'Bounded page evidence with structural joins only.',
            'evidence_note': 'A bounded packet was validated; full coverage stays open.', **extra}, ensure_ascii=False, indent=2) + '\n')

    def adopt(self):
        return adoption.adopt_source_evidence_only(self.store, PROFILE | {'frame_evidence': FRAME_PROFILE}, self.input_path, self.root)

    def inv_path(self):
        return self.piece / 'investigation.json'

    def assert_nothing_written(self, spec_before, inv_before, occupied=()):
        self.assertEqual(self.spec.read_bytes(), spec_before)
        self.assertEqual(self.inv_path().read_bytes(), inv_before)
        for name in ('before_spec', 'before_investigation', 'receipt'):
            if name not in occupied:
                self.assertFalse((self.leaf / PROFILE['source_evidence_only'][name]).exists())

    def refuses(self, pattern, occupied=()):
        spec_before, inv_before = self.spec.read_bytes(), self.inv_path().read_bytes()
        with self.assertRaisesRegex(ValueError, pattern):
            self.adopt()
        self.assert_nothing_written(spec_before, inv_before, occupied)

    # ---------------------------------------------------------------- a retained review: pinned notes on original frames

    def make_retained_review(self, structured=True, index=12):
        retained = self.root / 'retained'
        if retained.exists():
            shutil.rmtree(retained)
        originals = retained / 'originals'
        originals.mkdir(parents=True)
        source = retained / 'original.mp4'
        source.write_bytes(b'fixture original source')
        frame_path = originals / f'frame-{index}.png'
        frame_path.write_bytes(b'fixture original frame')
        frame_identity = content_identity(frame_path)
        pts = index * 1001
        seconds = pts / 24000
        manifest = originals / 'manifest.json'
        manifest.write_text(json.dumps({'schema': 'vendor', 'source': {'path': str(source), 'video': {
            'time_base': '1/24000', 'first_pts': 0, 'origin_timestamp': 0.0}},
            'frames': [{'index': index, 'pts': pts, 'seconds': seconds, 'path': str(frame_path)}]}, ensure_ascii=False, indent=1) + '\n')
        note = f'Frame {index}: a retained picture shows a bounded visual state; nothing else is inferred.'
        if structured:
            journal_quote = note
            identity_quote = f'"index": {index},\n      "blake3": "{frame_identity["value"]}"'
            journal = retained / 'REVIEW-JOURNAL.json'
            journal.write_text('{\n  "frames": [\n    {\n      "index": %d,\n      "blake3": "%s",\n      "note": "%s"\n    }\n  ]\n}\n'
                               % (index, frame_identity['value'], note))
        else:
            journal_quote = f'- Frame {index}: {note}; BLAKE3 {frame_identity["value"]}.'
            identity_quote = None
            journal = retained / 'REVIEW-JOURNAL.md'
            journal.write_text('# Retained source review\n\n' + journal_quote + '\n')
        self.journal = journal
        self.review = {
            'journal': {'path': str(journal), 'identity': content_identity(journal)},
            'manifest': {'path': str(manifest), 'identity': content_identity(manifest)},
            'source': {'path': str(source), 'identity': content_identity(source)},
            'reviewed_frames': [{'index': index, 'pts': pts, 'seconds': seconds, 'path': str(frame_path), 'identity': frame_identity,
                                 'journal_quote': journal_quote, **({'journal_identity_quote': identity_quote} if identity_quote else {})}],
            'extraction_provenance': {'status': 'unknown', 'reason': 'No extraction invocation record was kept; the original files remain.'}}
        self.evidence_files = [journal, manifest, source, frame_path]
        self.write_input(journal, self.evidence_files, retained_original_review=self.review)

    def set_retained(self, review):
        data = json.loads(self.input_path.read_text())
        data['retained_original_review'] = review
        self.input_path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n')

    # ---------------------------------------------------------------- finalized journals

    def test_an_invalid_journal_refuses_before_any_spec_or_record_write(self):
        pending = self.root / 'admission' / 'pending.json'
        pending.parent.mkdir(exist_ok=True)
        pending.write_text(json.dumps({'schema': FRAME_PROFILE['journal_schema'], 'status': 'pending', 'pages': [{'page': 1}]}))
        self.write_input(pending, [pending])
        self.refuses('not in final status')

    def test_a_valid_journal_appends_evidence_only_and_keeps_every_other_field(self):
        self.finalize()
        before_bytes = self.spec.read_bytes()
        before_inv = read_json(self.inv_path())
        before_node = investigation.node_of(before_inv, QUESTION)
        before_evidence = {row['id']: row for row in before_inv['evidence']}
        result = self.adopt()
        after = read_json(self.spec)
        self.assertEqual({k: v for k, v in after.items() if k != 'piece'}, {k: v for k, v in self.spec_data.items() if k != 'piece'})
        key = PROFILE['evidence_key']
        self.assertEqual({k: v for k, v in after['piece'].items() if k != key}, {k: v for k, v in self.spec_data['piece'].items() if k != key})
        motion = after['piece'][key]
        self.assertEqual(motion['path'], 'old/PHASES.json')
        self.assertIn(str(self.output.resolve()), motion['journal_paths'])
        self.assertIn('Bounded page evidence', motion['scope'])
        self.assertEqual((self.leaf / PROFILE['source_evidence_only']['before_spec']).read_bytes(), before_bytes)
        after_inv = read_json(self.inv_path())
        after_node = investigation.node_of(after_inv, QUESTION)
        for identity, row in before_evidence.items():
            self.assertEqual({e['id']: e for e in after_inv['evidence']}[identity], row)
        for member in ('status', 'label', 'defect', 'caught_by'):
            self.assertEqual(after_node[member], before_node[member])
        self.assertTrue(set(before_node['evidence']).issubset(after_node['evidence']))
        self.assertGreater(len(after_node['evidence']), len(before_node['evidence']))
        self.assertIsNone(result['shots_tsv_before'])
        self.assertEqual(result['source_review_kind'], PROFILE['review_kinds']['finalized'])
        self.assertTrue(result['exact_byte_inverse_verified'])
        self.assertTrue(Path(result['receipt_path']).is_file())

    def test_the_cli_adopts_without_deadlocking_on_the_library_lock(self):
        self.finalize()
        status, out, err = run_cli(self.library, 'adopt-window', str(self.input_path))
        self.assertEqual(status, 0, err)
        self.assertEqual(json.loads(out)['source_review_kind'], PROFILE['review_kinds']['finalized'])

    def test_the_preimage_holds_the_exact_raw_bytes_and_a_second_adoption_refuses_without_changing_anything(self):
        self.finalize()
        initial = read_json(self.inv_path())
        initial['fixture_note'] = 'café — exact pre-invocation bytes'
        exact = (json.dumps(initial, ensure_ascii=False, indent=1).replace('\n', '\r\n') + '\r\n').encode('utf-8')
        self.inv_path().write_bytes(exact)
        before_identity = content_identity(self.inv_path())
        result = self.adopt()
        preimage = self.leaf / PROFILE['source_evidence_only']['before_investigation']
        self.assertEqual(preimage.read_bytes(), exact)
        receipt_path = Path(result['receipt_path'])
        receipt = read_json(receipt_path)
        self.assertEqual(receipt['before_investigation']['identity'], before_identity)
        self.assertEqual(receipt['before_investigation']['preimage_identity'], before_identity)
        self.assertEqual(receipt['after_investigation']['identity'], content_identity(self.inv_path()))
        self.assertEqual(read_json(self.inv_path())['fixture_note'], 'café — exact pre-invocation bytes')
        saved = [p.read_bytes() for p in (preimage, receipt_path, self.spec, self.inv_path())]
        with self.assertRaisesRegex(ValueError, 'Current template spec does not match the declared before-spec identity'):
            self.adopt()
        self.assertEqual([p.read_bytes() for p in (preimage, receipt_path, self.spec, self.inv_path())], saved)

    def test_an_earlier_receipt_or_preimage_is_never_overwritten(self):
        self.finalize()
        for name in ('before_investigation', 'receipt'):
            occupied = self.leaf / PROFILE['source_evidence_only'][name]
            occupied.write_bytes(b'sentinel\r\n')
            with self.subTest(name=name):
                self.refuses('output already exists; refusing overwrite', occupied=(name,))
                self.assertEqual(occupied.read_bytes(), b'sentinel\r\n')
            occupied.unlink()

    def test_the_answer_timestamp_is_kept_and_reported(self):
        self.finalize()
        inv = read_json(self.inv_path())
        stamp = '2021-04-05T06:07:08.123456-07:00'
        investigation.node_of(inv, QUESTION)['answered_at'] = stamp
        write_json(self.inv_path(), inv)
        result = self.adopt()
        self.assertEqual(investigation.node_of(read_json(self.inv_path()), QUESTION)['answered_at'], stamp)
        lifecycle = read_json(Path(result['receipt_path']))['question_lifecycle']
        self.assertEqual((lifecycle['before']['answered_at'], lifecycle['after']['answered_at']), ({'present': True, 'value': stamp},) * 2)
        self.assertTrue(lifecycle['preserved'])

    def test_an_absent_answer_timestamp_stays_absent_while_evidence_is_recorded(self):
        self.finalize()
        inv = read_json(self.inv_path())
        investigation.node_of(inv, QUESTION).pop('answered_at', None)
        write_json(self.inv_path(), inv)
        count = len(inv['evidence'])
        result = self.adopt()
        after = read_json(self.inv_path())
        self.assertNotIn('answered_at', investigation.node_of(after, QUESTION))
        self.assertGreater(len(after['evidence']), count)
        lifecycle = read_json(Path(result['receipt_path']))['question_lifecycle']
        self.assertEqual((lifecycle['before']['answered_at'], lifecycle['after']['answered_at']), ({'present': False},) * 2)

    def test_an_ordinary_answer_still_advances_the_timestamp(self):
        self.finalize()
        inv = read_json(self.inv_path())
        investigation.node_of(inv, QUESTION)['answered_at'] = '2021-04-05T06:07:08-07:00'
        write_json(self.inv_path(), inv)
        fixed = '2026-10-29T16:00:00+00:00'
        with unittest.mock.patch.object(investigation, 'now', return_value=fixed):
            investigation.record_evidence(self.store, self.piece, QUESTION, 'asked', [str(self.evidence_files[0])], 'Ordinary caller.', label='Seen', append=True)
        after = read_json(self.inv_path())
        self.assertEqual(investigation.node_of(after, QUESTION)['answered_at'], fixed)
        self.assertEqual(after['updated_at'], fixed)

    def test_a_profile_missing_a_name_is_refused_before_anything_is_read(self):
        thin = copy.deepcopy(PROFILE)
        del thin['question']['id'], thin['files']['readback']
        with self.assertRaisesRegex(ValueError, 'files.readback, question.id'):
            adoption.check_profile(thin)

    # ---------------------------------------------------------------- retained reviews

    def test_a_retained_review_accepts_bounded_notes_and_unknown_extraction(self):
        for structured in (True, False):
            with self.subTest(structured=structured):
                self.make_retained_review(structured=structured)
                result = self.adopt()
                motion = read_json(self.spec)['piece'][PROFILE['evidence_key']]
                self.assertIn(str(self.journal.resolve()), motion['retained_paths'])
                self.assertNotIn('journal_paths', motion)
                self.assertEqual(motion['retained_reviews'][-1]['review']['extraction_provenance']['status'], 'unknown')
                self.assertEqual(result['source_review_kind'], PROFILE['review_kinds']['retained'])
                self.spec.write_text(json.dumps(self.spec_data, ensure_ascii=False, indent=2) + '\n')
                for name in ('before_spec', 'before_investigation', 'receipt'):
                    (self.leaf / PROFILE['source_evidence_only'][name]).unlink()

    def test_a_retained_review_with_unpaired_pins_is_refused_and_leaves_the_spec_and_record_alone(self):
        mutations = [
            lambda r: r['reviewed_frames'][0].update(index=13),
            lambda r: r['reviewed_frames'][0].update(pts=12013),
            lambda r: r['reviewed_frames'][0].update(pts=12012.0),
            lambda r: r['reviewed_frames'][0].update(seconds=float('nan')),
            lambda r: r['journal'].update(identity={**r['journal']['identity'], 'value': '0' * 64}),
            lambda r: r['reviewed_frames'][0].update(journal_quote='- 12 a fabricated saved line'),
            lambda r: r['reviewed_frames'].append(dict(r['reviewed_frames'][0])),
            lambda r: r['extraction_provenance'].update(status='guessed'),
            lambda r: r['extraction_provenance'].update(record={'path': 'x'}),
        ]
        for number, mutate in enumerate(mutations):
            self.make_retained_review()
            review = copy.deepcopy(self.review)
            mutate(review)
            self.set_retained(review)
            with self.subTest(mutation=number):
                spec_before, inv_before = self.spec.read_bytes(), self.inv_path().read_bytes()
                with self.assertRaises(ValueError):
                    self.adopt()
                self.assert_nothing_written(spec_before, inv_before)

    def test_a_retained_review_with_a_wrong_manifest_clock_or_missing_references_is_refused(self):
        for case in ('manifest_seconds', 'wrong_identity', 'missing_refs'):
            self.make_retained_review()
            data = json.loads(self.input_path.read_text())
            if case == 'manifest_seconds':
                manifest = Path(self.review['manifest']['path'])
                value = json.loads(manifest.read_text())
                value['frames'][0]['seconds'] = '287.996'
                manifest.write_text(json.dumps(value))
                data['retained_original_review']['manifest']['identity'] = content_identity(manifest)
            elif case == 'wrong_identity':
                data['retained_original_review']['reviewed_frames'][0]['identity']['value'] = '0' * 64
            else:
                data['evidence_paths'].remove(self.rel(self.evidence_files[-1]))
            self.input_path.write_text(json.dumps(data))
            with self.subTest(case=case):
                spec_before, inv_before = self.spec.read_bytes(), self.inv_path().read_bytes()
                with self.assertRaises(ValueError):
                    self.adopt()
                self.assert_nothing_written(spec_before, inv_before)

    def save_quote(self, quoted):
        self.make_retained_review(structured=False)
        frame = self.review['reviewed_frames'][0]
        quote = f'- Frame {quoted}: a retained picture shows a bounded visual state; BLAKE3 {frame["identity"]["value"]}.'
        self.journal.write_text('# Retained source review\n\n' + quote + '\n')
        review = copy.deepcopy(self.review)
        review['reviewed_frames'][0]['journal_quote'] = quote
        review['journal']['identity'] = content_identity(self.journal)
        self.set_retained(review)

    def test_a_lowercase_f_index_is_accepted(self):
        self.save_quote('f12')
        self.assertEqual(self.adopt()['source_review_kind'], PROFILE['review_kinds']['retained'])

    def test_an_uppercase_f_index_is_accepted(self):
        self.save_quote('F12')
        self.assertEqual(self.adopt()['source_review_kind'], PROFILE['review_kinds']['retained'])

    def test_a_wrong_or_embedded_index_is_refused(self):
        for wrong in ('f13', 'f121', 'xf12', 'f12x'):
            with self.subTest(quoted_index=wrong):
                self.save_quote(wrong)
                self.refuses('exact saved journal quote naming the index')

    # ---------------------------------------------------------------- the spec patch

    def test_the_object_patch_keeps_the_file_encoding_and_refuses_a_duplicate_key(self):
        updates = {'retained_paths': ['review.md']}
        for source in (
            b'{"piece":{"bed_evidence":{"path":"x"}}}',
            b'{"piece": {"bed_evidence": {"path": "x"}}}',
            '{\r\n  "piece": {\r\n    "bed_evidence": {\r\n      "label": "café — review",\r\n      "path": "x"\r\n    }\r\n  }\r\n}\r\n'.encode(),
        ):
            patched = json_patch.patch_object_members(source, ('piece', 'bed_evidence'), updates)
            self.assertEqual(json.loads(patched)['piece']['bed_evidence']['retained_paths'], ['review.md'])
            self.assertIn(source[-2:] if source.endswith(b'\r\n') else b'"x"', patched)
        with self.assertRaisesRegex(ValueError, 'unique string keys'):
            json_patch.patch_object_members(b'{"piece":{"bed_evidence":{"path":"x","path":"y"}}}', ('piece', 'bed_evidence'), updates)

    # ---------------------------------------------------------------- reviewed intervals

    def prepared(self, profile, data, prior_rows, fields, prior_spec, vocabulary, count_words, leaf, root):
        return prior_rows, list(fields), prior_spec, [[0, 1]], {'validated_record_count': 0}

    def interval_input(self):
        (self.piece / PROFILE['table']['file']).write_text('t0\tt1\n0\t1\n')
        self.leaf.joinpath(PROFILE['files']['journal']).write_text(json.dumps({'pages': ['p1']}))
        self.leaf.joinpath(PROFILE['files']['detail']).write_text('{}')
        self.spec.write_text(json.dumps({'piece': {'id': 'herb-bed'}}))
        write_json(self.input_path, {'piece': self.rel(self.piece), 'leaf': LEAF,
                                     'intervals': [{'first': 0, 'first_absent': 1, 'qualification': 'source-qualified'}],
                                     'open_endpoint': 'full-review-remains-open', 'scope': 'bounded reviewed interval'})

    def adopt_intervals(self):
        return adoption.adopt_intervals(self.store, PROFILE | {'frame_evidence': FRAME_PROFILE}, self.input_path, self.root)

    def test_a_missing_detail_note_refuses_before_any_source_or_recovery_write(self):
        self.interval_input()
        table_before, spec_before = (self.piece / PROFILE['table']['file']).read_bytes(), self.spec.read_bytes()
        with unittest.mock.patch.object(adoption, 'prepare', side_effect=self.prepared) as prepare:
            with self.assertRaisesRegex(ValueError, PROFILE['files']['detail_note']):
                self.adopt_intervals()
        prepare.assert_not_called()
        self.assertEqual((self.piece / PROFILE['table']['file']).read_bytes(), table_before)
        self.assertEqual(self.spec.read_bytes(), spec_before)
        self.assertFalse((self.leaf / PROFILE['files']['input_copy']).exists())
        self.assertFalse((self.leaf / PROFILE['files']['before_table']).exists())

    def test_an_invalid_journal_refuses_before_prepare_or_source_writes(self):
        self.interval_input()
        self.leaf.joinpath(PROFILE['files']['detail_note']).write_text('Structural review note.\n')
        self.leaf.joinpath(PROFILE['files']['journal']).write_text(json.dumps(
            {'schema': FRAME_PROFILE['journal_schema'], 'status': 'pending', 'pages': [{'page': 1}]}))
        self.spec.write_text(json.dumps({'piece': {'id': 'herb-bed', PROFILE['evidence_key']: {
            PROFILE['evidence_fields']['journal_paths']: [str(self.leaf / PROFILE['files']['journal'])]}}}))
        spec_before = self.spec.read_bytes()
        with unittest.mock.patch.object(adoption, 'prepare', side_effect=self.prepared) as prepare:
            with self.assertRaisesRegex(ValueError, 'not in final status'):
                self.adopt_intervals()
        prepare.assert_not_called()
        self.assertEqual(self.spec.read_bytes(), spec_before)
        self.assertFalse((self.leaf / PROFILE['files']['input_copy']).exists())
        self.assertFalse((self.leaf / PROFILE['files']['before_table']).exists())

    def test_a_valid_note_reaches_the_evidence_recorder_and_keeps_the_preimages(self):
        self.interval_input()
        self.leaf.joinpath(PROFILE['files']['detail_note']).write_text('Reviewed the pictures and their bounds.\n')
        with unittest.mock.patch.object(adoption, 'prepare', side_effect=self.prepared):
            result = self.adopt_intervals()
        self.assertEqual(result['intervals_added'], [[0, 1]])
        for name in ('membership_readback', 'readback', 'input_copy', 'before_table', 'before_spec'):
            self.assertTrue((self.leaf / PROFILE['files'][name]).is_file(), name)
        node = investigation.node_of(read_json(self.inv_path()), QUESTION)
        self.assertEqual(node['status'], PROFILE['question']['status'])
        paths = {row['path'] for row in read_json(self.inv_path())['evidence']}
        self.assertIn(f'{LEAF}/{PROFILE["files"]["detail_note"]}', paths)
        with self.assertRaisesRegex(ValueError, 'Refusing to replace an earlier adoption with different input'):
            write_json(self.input_path, {**read_json(self.input_path), 'scope': 'a different scope'})
            self.adopt_intervals()


if __name__ == '__main__':
    unittest.main()

// tools/judge-words: evidence rows (do-work/evidence-checks.mjs) over evidence a caller hands in as an item's value:
// exact UTF-8 source and destination spans, complete per-block review, and a captured answer set against its pinned
// identities and thresholds; and a required reference field as a plain path row. Carried from bitfield-packages
// packages/content-gate/__tests__/provenance-and-capture.test.ts, with the same made-up identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../do-work/judge-words.mjs';
import { EVIDENCE_CHECK_NAMES } from '../do-work/evidence-checks.mjs';

const check = (evidence, row, value) => judge({ rules: [{ id: 'evidence-check', says: 'The evidence does not hold.', evidence, ...row }], artifact: value });
const passes = (...args) => check(...args).passed;

const sourceText = 'A source line with café.';
const currentText = 'New prose: A faithful paraphrase about café.';
const sourceQuote = 'A source line with café.';
const sourceEnd = new TextEncoder().encode(sourceText).length;
const accentStart = new TextEncoder().encode(sourceText.slice(0, sourceText.indexOf('é'))).length;
const destinationStart = new TextEncoder().encode('New prose: ').length;
const destinationQuote = 'A faithful paraphrase about café.';
const destinationEnd = destinationStart + new TextEncoder().encode(destinationQuote).length;
const sourcePolicy = {
  expected_current_document_identity: 'identity:document-current',
  expected_source_identities: { 'source:synthetic': 'identity:source-current' },
};
const spans = () => ({
  source_spans: {
    sources: [{ ref: 'source:synthetic', content_identity: 'identity:source-current', source_text: sourceText }],
    current_document: { content_identity: 'identity:document-current', destination_text: currentText },
    quotes: [{
      ref: 'quote:synthetic', source_ref: 'source:synthetic', source_content_identity: 'identity:source-current',
      source_start_byte: 0, source_end_byte: sourceEnd, source_literal: sourceQuote,
      destination_literal: destinationQuote, destination_start_byte: destinationStart, destination_end_byte: destinationEnd,
    }],
  },
});

test('the evidence checks are named', () => {
  assert.deepEqual(EVIDENCE_CHECK_NAMES, ['source-span-coverage', 'review-coverage', 'inference-capture-qualification']);
});

test('source-span-coverage checks exact source and destination UTF-8 byte slices', () => {
  assert.equal(passes('source-span-coverage', sourcePolicy, spans()), true);
  assert.deepEqual(check('source-span-coverage', {}, spans()).findings.map(item => item.found), ['missing_source_identity_policy']);
  const stale = spans();
  stale.source_spans.quotes[0].destination_end_byte = destinationEnd - 1;
  const answer = check('source-span-coverage', sourcePolicy, stale);
  assert.deepEqual([answer.passed, answer.findings[0].found, answer.findings[0].index], [false, 'destination_literal_mismatch', 0]);
  assert.match(answer.lines[0], /"destination_literal_mismatch" at 0\. The evidence does not hold\./);
});

test('source-span-coverage pins the exact current and source identity set and lets the destination paraphrase', () => {
  assert.notEqual(sourceQuote, destinationQuote);
  const staleDestination = spans();
  staleDestination.source_spans.current_document.content_identity = 'identity:old-document';
  assert.equal(passes('source-span-coverage', sourcePolicy, staleDestination), false);
  const staleSource = spans();
  staleSource.source_spans.sources[0].content_identity = 'identity:other-source';
  assert.equal(passes('source-span-coverage', sourcePolicy, staleSource), false);
  const omittedSource = spans();
  omittedSource.source_spans.sources = [];
  assert.equal(passes('source-span-coverage', sourcePolicy, omittedSource), false);
  const extraSource = spans();
  extraSource.source_spans.sources.push({ ref: 'source:unapproved', content_identity: 'identity:other', text: 'other' });
  assert.equal(passes('source-span-coverage', sourcePolicy, extraSource), false);
});

test('source-span-coverage fails closed on literal mismatches and byte ranges that split UTF-8', () => {
  const noIdentity = spans();
  noIdentity.source_spans.sources[0].content_identity = '';
  assert.equal(passes('source-span-coverage', sourcePolicy, noIdentity), false);
  const splitUtf8 = spans();
  splitUtf8.source_spans.quotes[0].source_start_byte = accentStart + 1;
  assert.equal(passes('source-span-coverage', sourcePolicy, splitUtf8), false);
  const alteredQuote = spans();
  alteredQuote.source_spans.quotes[0].destination_literal = 'A different destination literal.';
  assert.equal(passes('source-span-coverage', sourcePolicy, alteredQuote), false);
});

const current = { content_identity: 'identity:document-current', blocks: [{ content_identity: 'identity:block-0' }, { content_identity: 'identity:block-1' }] };
const review = {
  document_identity: 'identity:document-current',
  blocks: [
    { block_index: 0, block_identity: 'identity:block-0', reviewer_role: 'author', reviewer_ref: 'reviewer:author', reason: 'Reviewed current block', decision: 'retain' },
    { block_index: 1, block_identity: 'identity:block-1', reviewer_role: 'reviewer', reviewer_ref: 'reviewer:peer', reason: 'Reviewed revised block', decision: 'revised_and_reviewed' },
  ],
  components: [{ component_ref: 'component:source-idea', source_identity: 'identity:source', destination_identity: 'identity:document-current', review_decision: 'paraphrased', relationship_review: 'Reviewed against the source span' }],
};
const reviewPolicy = {
  expected_current_document_identity: 'identity:document-current',
  required_component_refs: ['component:source-idea'],
  expected_component_source_identities: { 'component:source-idea': 'identity:source' },
  allowed_component_review_decisions: ['represented', 'paraphrased'],
  allowed_reviewer_roles: ['author', 'reviewer'],
  allowed_decisions: ['retain', 'revised_and_reviewed'],
};
const reviewed = (writingReview, document = current) => ({ current_document: document, review: writingReview });

test('review-coverage needs the current document identity, each current block and every required source component', () => {
  assert.equal(passes('review-coverage', reviewPolicy, reviewed(review)), true);
  assert.equal(passes('review-coverage', {}, reviewed(review)), false);
  const { allowed_reviewer_roles: _roles, ...noRoles } = reviewPolicy;
  assert.deepEqual(check('review-coverage', noRoles, reviewed(review)).findings.map(item => item.found), ['missing_review_policy']);
  assert.equal(passes('review-coverage', reviewPolicy, reviewed({ ...review, blocks: review.blocks.slice(0, 1) })), false);
});

test('review-coverage binds an asserted or required source group to the same reviewed block', () => {
  const grouped = { ...current, source_blocks: [
    { content_identity: 'identity:group-0', token_index: 0, visible_block_indexes: [0] },
    { content_identity: 'identity:group-1', token_index: 2, visible_block_indexes: [1] },
  ] };
  const bound = { ...review, blocks: review.blocks.map((row, index) => ({ ...row, current_source_group_identity: `identity:group-${index}` })) };
  const policy = { ...reviewPolicy, require_source_group_identity: true };
  assert.equal(passes('review-coverage', policy, reviewed(bound, grouped)), true);
  const wrong = structuredClone(bound);
  wrong.blocks[1].current_source_group_identity = 'identity:group-0';
  assert.equal(passes('review-coverage', policy, reviewed(wrong, grouped)), false);
  assert.equal(passes('review-coverage', reviewPolicy, reviewed(wrong, grouped)), false);
  assert.equal(passes('review-coverage', policy, reviewed(review, grouped)), false);
  assert.equal(passes('review-coverage', policy, reviewed(bound, current)), false);
  const duplicate = structuredClone(grouped);
  duplicate.source_blocks[1].visible_block_indexes = [0, 1];
  assert.equal(passes('review-coverage', policy, reviewed(bound, duplicate)), false);

  const lineagePolicy = { ...policy, require_inherited_review_identity: true };
  const inherited = { ...bound, blocks: bound.blocks.map(row => ({ ...row,
    inherited_review: { source_group_identity: row.current_source_group_identity, reason: 'Historical scoped review.' } })) };
  assert.equal(passes('review-coverage', lineagePolicy, reviewed(inherited, grouped)), true);
  const wrongAncestor = structuredClone(inherited);
  wrongAncestor.blocks[1].inherited_review.source_group_identity = 'identity:group-0';
  const badAncestor = check('review-coverage', lineagePolicy, reviewed(wrongAncestor, grouped));
  assert.equal(badAncestor.passed, false);
  assert.equal(badAncestor.findings[0].found, 'inherited_review_source_group_mismatch');
  const opaqueAncestor = { ...bound, blocks: bound.blocks.map(row => ({ ...row, inherited_review: { reason: 'An ordinal alone does not establish ancestry.' } })) };
  assert.equal(passes('review-coverage', lineagePolicy, reviewed(opaqueAncestor, grouped)), false);
  assert.equal(passes('review-coverage', lineagePolicy, reviewed(bound, grouped)), true);
});

test('review-coverage rejects stale block identities and unreviewed source components', () => {
  const stale = { ...review, blocks: review.blocks.map((row, index) => (index ? row : { ...row, block_identity: 'identity:old-block' })) };
  assert.equal(passes('review-coverage', reviewPolicy, reviewed(stale)), false);
  assert.equal(passes('review-coverage', reviewPolicy, reviewed({ ...review, components: [] })), false);
  for (const review_decision of ['partial', 'not_represented']) {
    assert.equal(passes('review-coverage', reviewPolicy, reviewed({ ...review, components: [{ ...review.components[0], review_decision }] })), false);
  }
  assert.equal(passes('review-coverage', reviewPolicy, reviewed({ ...review, components: [{ ...review.components[0], source_identity: 'identity:other-source' }] })), false);
  assert.equal(passes('review-coverage', reviewPolicy, reviewed(review, { ...current, content_identity: 'identity:old-document' })), false);
});

const capture = {
  capture_identity: 'capture:synthetic',
  request_set_identity: 'request-set:synthetic',
  model: { identity: 'model:family@revision', revision: 'revision:abc', adapter_identity: 'adapter:abc' },
  examples: [
    { identity: 'example:positive', kind: 'positive', request_identity: 'request:1', input_identity: 'input:1', selected_option: 'accept', option_probabilities: { accept: 0.94, reject: 0.06 } },
    { identity: 'example:negative', kind: 'negative', request_identity: 'request:2', input_identity: 'input:2', selected_option: 'reject', option_probabilities: { accept: 0.04, reject: 0.96 } },
    { identity: 'example:uncertain', kind: 'uncertain', request_identity: 'request:3', input_identity: 'input:3', selected_option: 'uncertain', option_probabilities: { accept: 0.1, reject: 0.1, uncertain: 0.8 } },
  ],
};
const capturePolicy = {
  expected_model: { identity: 'model:family@revision', revision: 'revision:abc', adapter_identity: 'adapter:abc' },
  expected_capture_identity: 'capture:synthetic',
  expected_request_set_identity: 'request-set:synthetic',
  decision_policy: 'argmax',
  expected_examples: {
    'example:positive': { kind: 'positive', request_identity: 'request:1', input_identity: 'input:1', selected_option: 'accept' },
    'example:negative': { kind: 'negative', request_identity: 'request:2', input_identity: 'input:2', selected_option: 'reject' },
    'example:uncertain': { kind: 'uncertain', request_identity: 'request:3', input_identity: 'input:3', selected_option: 'uncertain' },
  },
  minimum_probability_by_option: { accept: 0.9, reject: 0.9, uncertain: 0.15 },
};
const captured = value => ({ inference_capture: value });
const withExample = (identity, change) => ({ ...capture, examples: capture.examples.map(row => (row.identity === identity ? { ...row, ...change } : row)) });

test('inference-capture-qualification needs the captured model, every example and each selected option over its threshold', () => {
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured(capture)), true);
  const low = { ...capture, examples: capture.examples.map((row, index) => (index ? row : { ...row, option_probabilities: { accept: 0.89, reject: 0.11 } })) };
  assert.deepEqual(check('inference-capture-qualification', capturePolicy, captured(low)).findings.map(item => [item.found, item.index]),
    [['selected_option_below_threshold', 0]]);
});

test('inference-capture-qualification fails closed on another model, a missing example, other identities, weak or unnormalized answers', () => {
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured({ ...capture, model: { ...capture.model, revision: 'revision:other' } })), false);
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured({ ...capture, examples: capture.examples.filter(row => row.kind !== 'uncertain') })), false);
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured(withExample('example:positive', { identity: 'example:other' }))), false);
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured(withExample('example:positive', { request_identity: 'request:unapproved' }))), false);
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured(withExample('example:positive', { input_identity: 'input:unapproved' }))), false);
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured(withExample('example:positive', { selected_option: 'reject' }))), false);
  const weakPolicy = { ...capturePolicy, expected_examples: { ...capturePolicy.expected_examples,
    'example:positive': { ...capturePolicy.expected_examples['example:positive'], selected_option: 'reject' } } };
  assert.equal(passes('inference-capture-qualification', weakPolicy, captured(withExample('example:positive', { selected_option: 'reject' }))), false);
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured(withExample('example:positive', { option_probabilities: { accept: 0.94, reject: 0.2 } }))), false);
  assert.equal(passes('inference-capture-qualification', capturePolicy, captured({ ...capture, request_set_identity: 'request-set:other' })), false);
});

test('a required reference field is a path row: every block that should carry one is checked by a nonempty string at the path', () => {
  const refs = [
    { id: 'validation-ref', path: 'blocks.*.profile_ref', where_pattern: '\\S', required: true, says: 'Name the profile it is checked against.' },
    { id: 'conditioning-ref', path: 'blocks.*.conditioning_profile_ref', where_pattern: '\\S', required: true, says: 'Name the profile it is written from.' },
  ];
  assert.equal(judge({ rules: refs, artifact: { blocks: [{ kind: 'profile', profile_ref: 'profile:source', conditioning_profile_ref: 'profile:source' }] } }).passed, true);
  const none = judge({ rules: refs, artifact: { blocks: [{ kind: 'profile' }] } });
  assert.deepEqual([none.passed, none.findings.map(item => item.rule)], [false, ['validation-ref', 'conditioning-ref']]);
  assert.equal(judge({ rules: refs, artifact: { blocks: [{ profile_ref: ' ', conditioning_profile_ref: 'x' }] } }).passed, false);
});

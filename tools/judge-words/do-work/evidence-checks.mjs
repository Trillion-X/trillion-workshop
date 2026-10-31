// tools/judge-words/do-work/evidence-checks.mjs
//
// Purpose
//   The evidence checks a rule row may name with `evidence`: mechanical consistency checks over evidence a caller
//   supplies as an item's `value` (exact UTF-8 source and destination spans, complete per-block review of the current
//   document, a captured model answer set against its pinned identities and thresholds). judge-words.mjs runs them
//   like any other selector: each returns the reasons it found, as pieces { value: <reason code>, index? }.
//
// Non-negotiable invariants
//   1. These checks never mint or authenticate an identity, a source, a reviewer, a model or a meaning. They check that
//      the evidence a caller hands in agrees with itself and with the identities and thresholds the row pins. A passing
//      check is not a semantic verdict and not a voice verdict.
//   2. Every policy value is the row's: identities, the reviewer roles, the decisions, the component decisions, the
//      thresholds. A row missing one fails closed with a reason; nothing has a default.
//   3. A check stops at the first reason, as the evidence it checks is no longer trustworthy past it.
//
// Ported from bitfield-packages packages/content-gate/do-work/evaluators/provenance-and-capture.ts: the same checks in
// the same order with the same reason codes. Changed: the evidence object is the item's value (the old subject.evidence),
// the row is the policy (the old rule.config), the reviewer roles and decisions are required row fields (the old code
// defaulted them), and the check returns reasons instead of a score.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const nonemptyList = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
const failed = (code, index) => [{ value: code, ...(index === undefined ? {} : { index }) }];
const fieldOf = (rule, name, fallback) => (typeof rule[name] === 'string' ? rule[name] : fallback);

/**
 * Source quote byte ranges against caller-provided UTF-8 source snapshots. Snapshot content identities are opaque
 * values supplied by their own owner (tools/content-identity); this check does not mint or authenticate them.
 * Row: expected_current_document_identity, expected_source_identities { ref: identity }, evidence_field?.
 */
function sourceSpanCoverage(evidence, rule) {
  const proof = evidence?.[fieldOf(rule, 'evidence_field', 'source_spans')];
  if (!nonempty(rule.expected_current_document_identity) || !isRecord(rule.expected_source_identities)
    || !Object.keys(rule.expected_source_identities).length
    || Object.values(rule.expected_source_identities).some(identity => !nonempty(identity))) {
    return failed('missing_source_identity_policy');
  }
  if (!isRecord(proof) || !Array.isArray(proof.sources) || !Array.isArray(proof.quotes)
    || !isRecord(proof.current_document) || proof.sources.length === 0 || proof.quotes.length === 0) {
    return failed('missing_source_span_evidence');
  }
  if (proof.current_document.content_identity !== rule.expected_current_document_identity
    || typeof proof.current_document.destination_text !== 'string') return failed('current_document_identity_mismatch');

  const sources = new Map();
  for (const source of proof.sources) {
    if (!isRecord(source) || !nonempty(source.ref) || sources.has(source.ref)
      || !nonempty(source.content_identity) || typeof source.source_text !== 'string'
      || rule.expected_source_identities[source.ref] !== source.content_identity) return failed('invalid_or_unexpected_source_snapshot');
    sources.set(source.ref, source);
  }
  if (sources.size !== Object.keys(rule.expected_source_identities).length
    || Object.keys(rule.expected_source_identities).some(ref => !sources.has(ref))) return failed('source_identity_set_mismatch');
  const quoteIds = new Set();
  for (const [index, quote] of proof.quotes.entries()) {
    if (!isRecord(quote) || !nonempty(quote.ref) || quoteIds.has(quote.ref)
      || !nonempty(quote.source_ref) || !sources.has(quote.source_ref)
      || !Number.isSafeInteger(quote.source_start_byte) || !Number.isSafeInteger(quote.source_end_byte)
      || quote.source_start_byte < 0 || quote.source_end_byte <= quote.source_start_byte
      || !nonempty(quote.source_literal) || !nonempty(quote.destination_literal)
      || !Number.isSafeInteger(quote.destination_start_byte) || !Number.isSafeInteger(quote.destination_end_byte)
      || quote.destination_start_byte < 0
      || quote.destination_end_byte <= quote.destination_start_byte) return failed('invalid_quote_binding', index);
    quoteIds.add(quote.ref);
    const source = sources.get(quote.source_ref);
    if (quote.source_content_identity !== source.content_identity) return failed('source_identity_mismatch', index);
    const sourceBytes = new TextEncoder().encode(source.source_text);
    if (quote.source_end_byte > sourceBytes.byteLength) return failed('source_range_outside_snapshot', index);
    let sourceLiteral;
    try {
      sourceLiteral = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes.slice(quote.source_start_byte, quote.source_end_byte));
    } catch {
      return failed('source_span_splits_utf8', index);
    }
    if (sourceLiteral !== quote.source_literal) return failed('source_literal_mismatch', index);
    const destinationBytes = new TextEncoder().encode(proof.current_document.destination_text);
    if (quote.destination_end_byte > destinationBytes.byteLength) return failed('destination_range_outside_snapshot', index);
    let destinationLiteral;
    try {
      destinationLiteral = new TextDecoder('utf-8', { fatal: true }).decode(
        destinationBytes.slice(quote.destination_start_byte, quote.destination_end_byte),
      );
    } catch {
      return failed('destination_span_splits_utf8', index);
    }
    if (destinationLiteral !== quote.destination_literal) return failed('destination_literal_mismatch', index);
  }
  return [];
}

/**
 * Complete per-block review of the current document against the exact opaque current document and block identities
 * supplied by their own owner, and review of every required source component. A review row is an assertion by its
 * named reviewer; this check does not authenticate them. Row: expected_current_document_identity,
 * expected_component_source_identities { component: identity }, required_component_refs, allowed_reviewer_roles,
 * allowed_decisions, allowed_component_review_decisions, require_source_group_identity?,
 * require_inherited_review_identity?, current_document_field?, review_field?.
 */
function reviewCoverage(evidence, rule) {
  const expectedDocumentIdentity = rule.expected_current_document_identity;
  const current = evidence?.[fieldOf(rule, 'current_document_field', 'current_document')];
  const review = evidence?.[fieldOf(rule, 'review_field', 'review')];
  if (!nonempty(expectedDocumentIdentity) || !isRecord(rule.expected_component_source_identities)
    || !nonemptyList(rule.allowed_component_review_decisions) || !nonemptyList(rule.allowed_reviewer_roles)
    || !nonemptyList(rule.allowed_decisions)) return failed('missing_review_policy');
  if (!isRecord(current) || !nonempty(current.content_identity) || current.content_identity !== expectedDocumentIdentity || !Array.isArray(current.blocks)
    || !current.blocks.length || !isRecord(review) || !Array.isArray(review.blocks)) return failed('missing_current_document_or_review');
  if (review.document_identity !== current.content_identity) return failed('stale_review_document');

  if (rule.require_source_group_identity !== undefined && typeof rule.require_source_group_identity !== 'boolean') {
    return failed('invalid_source_group_policy');
  }
  if (rule.require_inherited_review_identity !== undefined && typeof rule.require_inherited_review_identity !== 'boolean') {
    return failed('invalid_inherited_review_policy');
  }
  const checksGroups = rule.require_source_group_identity === true || rule.require_inherited_review_identity === true
    || review.blocks.some(row => isRecord(row) && Object.hasOwn(row, 'current_source_group_identity'));
  const sourceGroupByBlock = new Map();
  if (checksGroups) {
    if (!Array.isArray(current.source_blocks)) return failed('missing_current_source_groups');
    for (const group of current.source_blocks) {
      if (!isRecord(group) || !nonempty(group.content_identity) || !Array.isArray(group.visible_block_indexes)) {
        return failed('invalid_current_source_group');
      }
      for (const index of group.visible_block_indexes) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= current.blocks.length || sourceGroupByBlock.has(index)) {
          return failed('invalid_current_source_group_membership');
        }
        sourceGroupByBlock.set(index, group.content_identity);
      }
    }
    if (sourceGroupByBlock.size !== current.blocks.length) return failed('incomplete_current_source_groups');
  }
  const reviewed = new Set();
  for (const row of review.blocks) {
    if (!isRecord(row) || !Number.isSafeInteger(row.block_index)
      || row.block_index < 0 || row.block_index >= current.blocks.length
      || reviewed.has(row.block_index) || !nonempty(row.reviewer_role)
      || !rule.allowed_reviewer_roles.includes(row.reviewer_role) || !nonempty(row.reviewer_ref)
      || !nonempty(row.reason) || !rule.allowed_decisions.includes(row.decision)) return failed('invalid_or_duplicate_block_review');
    const block = current.blocks[row.block_index];
    if (!isRecord(block) || !nonempty(block.content_identity) || row.block_identity !== block.content_identity) {
      return failed('stale_review_block', row.block_index);
    }
    if (checksGroups && (rule.require_source_group_identity === true || Object.hasOwn(row, 'current_source_group_identity'))
      && row.current_source_group_identity !== sourceGroupByBlock.get(row.block_index)) {
      return failed('review_source_group_mismatch', row.block_index);
    }
    if (rule.require_inherited_review_identity === true && row.inherited_review != null
      && (!isRecord(row.inherited_review)
        || row.inherited_review.source_group_identity !== sourceGroupByBlock.get(row.block_index))) {
      return failed('inherited_review_source_group_mismatch', row.block_index);
    }
    reviewed.add(row.block_index);
  }
  if (reviewed.size !== current.blocks.length) {
    const missing = current.blocks.findIndex((_, index) => !reviewed.has(index));
    return failed('unreviewed_current_block', missing < 0 ? undefined : missing);
  }

  const requiredComponents = Array.isArray(rule.required_component_refs) ? rule.required_component_refs : [];
  if (new Set(requiredComponents).size !== requiredComponents.length || requiredComponents.some(ref => !nonempty(ref))) {
    return failed('invalid_required_component_policy');
  }
  const expectedSourceRefs = Object.keys(rule.expected_component_source_identities);
  if (expectedSourceRefs.length !== requiredComponents.length
    || requiredComponents.some(component => !expectedSourceRefs.includes(component))) return failed('component_source_policy_set_mismatch');
  if (requiredComponents.some(component => !nonempty(rule.expected_component_source_identities[component]))) {
    return failed('missing_required_component_source_identity');
  }
  const components = Array.isArray(review.components) ? review.components : [];
  const seenComponents = new Set();
  for (const [index, row] of components.entries()) {
    if (!isRecord(row) || !nonempty(row.component_ref) || seenComponents.has(row.component_ref)
      || !requiredComponents.includes(row.component_ref) || !nonempty(row.source_identity)
      || !nonempty(row.destination_identity) || !nonempty(row.review_decision)
      || !rule.allowed_component_review_decisions.includes(row.review_decision)
      || !nonempty(row.relationship_review)) return failed('invalid_component_review', index);
    if (row.source_identity !== rule.expected_component_source_identities[row.component_ref]) return failed('stale_component_source', index);
    if (row.destination_identity !== current.content_identity) return failed('stale_component_destination', index);
    seenComponents.add(row.component_ref);
  }
  for (const component of requiredComponents) {
    if (!seenComponents.has(component)) return failed('unreviewed_required_component');
  }
  return [];
}

/**
 * A captured set of model answers against its pinned model, adapter, capture and request-set identities, the exact
 * example set, and each selected option's threshold: probabilities normalized, the selected option the unique argmax.
 * This checks the captured record's consistency; it cannot authenticate a provider or model, or decide whether the
 * question itself is right. Row: expected_model { identity, revision, adapter_identity }, expected_capture_identity,
 * expected_request_set_identity, expected_examples { identity: { kind, request_identity, input_identity,
 * selected_option } }, minimum_probability_by_option { option: p }, decision_policy: "argmax", capture_field?.
 */
function inferenceCaptureQualification(evidence, rule) {
  const capture = evidence?.[fieldOf(rule, 'capture_field', 'inference_capture')];
  if (!isRecord(capture) || !isRecord(capture.model) || !Array.isArray(capture.examples)
    || !nonempty(capture.capture_identity) || !nonempty(capture.request_set_identity)) return failed('missing_capture');
  const expectedModel = isRecord(rule.expected_model) ? rule.expected_model : null;
  if (!expectedModel || !nonempty(expectedModel.identity) || !nonempty(expectedModel.revision)
    || !nonempty(expectedModel.adapter_identity)
    || capture.model.identity !== expectedModel.identity || capture.model.revision !== expectedModel.revision) {
    return failed('model_identity_mismatch');
  }
  if (capture.model.adapter_identity !== expectedModel.adapter_identity) return failed('adapter_identity_mismatch');
  if (!nonempty(rule.expected_capture_identity) || capture.capture_identity !== rule.expected_capture_identity
    || !nonempty(rule.expected_request_set_identity) || capture.request_set_identity !== rule.expected_request_set_identity) {
    return failed('capture_or_request_set_identity_mismatch');
  }
  if (!isRecord(rule.expected_examples) || !Object.keys(rule.expected_examples).length
    || !isRecord(rule.minimum_probability_by_option) || rule.decision_policy !== 'argmax') {
    return failed('missing_capture_qualification_policy');
  }
  const expectedExamples = rule.expected_examples;
  if (capture.examples.length !== Object.keys(expectedExamples).length) return failed('capture_example_set_mismatch');
  const seen = new Set();
  for (const [index, example] of capture.examples.entries()) {
    if (!isRecord(example) || !nonempty(example.identity) || seen.has(example.identity)
      || !nonempty(example.kind) || !nonempty(example.request_identity)
      || !nonempty(example.input_identity) || !nonempty(example.selected_option)
      || !isRecord(example.option_probabilities)) return failed('invalid_captured_example', index);
    seen.add(example.identity);
    const expected = expectedExamples[example.identity];
    if (!isRecord(expected) || example.kind !== expected.kind
      || example.request_identity !== expected.request_identity || example.input_identity !== expected.input_identity
      || example.selected_option !== expected.selected_option) return failed('unexpected_example_or_input_identity', index);
    const selectedProbability = example.option_probabilities[example.selected_option];
    const minimumProbability = rule.minimum_probability_by_option[example.selected_option];
    if (typeof selectedProbability !== 'number' || !Number.isFinite(selectedProbability)
      || selectedProbability < 0 || selectedProbability > 1
      || typeof minimumProbability !== 'number' || !Number.isFinite(minimumProbability)
      || minimumProbability < 0 || minimumProbability > 1 || selectedProbability < minimumProbability) {
      return failed('selected_option_below_threshold', index);
    }
    for (const [option, probability] of Object.entries(example.option_probabilities)) {
      if (!nonempty(option) || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        return failed('invalid_option_probability', index);
      }
    }
    const probabilities = Object.values(example.option_probabilities);
    const probabilityTotal = probabilities.reduce((sum, probability) => sum + probability, 0);
    if (Math.abs(probabilityTotal - 1) > 0.001) return failed('option_probabilities_not_normalized', index);
    if (probabilities.some(probability => probability >= selectedProbability && probability !== selectedProbability)) {
      return failed('selected_option_is_not_argmax', index);
    }
    if (probabilities.filter(probability => probability === selectedProbability).length !== 1) {
      return failed('selected_option_is_tied', index);
    }
  }
  if (seen.size !== Object.keys(expectedExamples).length
    || Object.keys(expectedExamples).some(identity => !seen.has(identity))) return failed('capture_example_set_mismatch');
  return [];
}

/** The evidence checks a row may name: (evidence, row) -> [{ value: reason code, index? }]. */
export const EVIDENCE_CHECKS = Object.freeze({
  'source-span-coverage': sourceSpanCoverage,
  'review-coverage': reviewCoverage,
  'inference-capture-qualification': inferenceCaptureQualification,
});

export const EVIDENCE_CHECK_NAMES = Object.freeze(Object.keys(EVIDENCE_CHECKS));

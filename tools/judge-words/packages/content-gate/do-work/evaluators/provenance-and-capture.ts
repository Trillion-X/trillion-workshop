import type { Evaluator, EvaluatorOutput } from '@/packages/content-gate/do-work/evaluator';
import type { GateRule, GateSubject } from '@/packages/content-gate/read-data/gate-types';

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function failed(rule: GateRule, code: string, index?: number): EvaluatorOutput {
  return {
    score: 0,
    findings: [{
      rule_id: rule.id,
      evaluator: rule.evaluator,
      outcome: rule.outcome ?? 'block',
      message: rule.message ?? `Evidence did not satisfy ${rule.evaluator} (${code}).`,
      ...(index === undefined ? {} : { locator: { block_index: index } }),
    }],
  };
}

function evidence(subject: GateSubject, key: string): unknown {
  return subject.evidence?.[key];
}

/**
 * Check source quote byte ranges against caller-provided UTF-8 source snapshots.
 * Snapshot content identities are opaque values supplied by the existing
 * content identity owner; this evaluator does not mint or authenticate them.
 */
export const sourceSpanCoverageEvaluator: Evaluator = (subject, rule) => {
  const cfg = rule.config;
  const proof = evidence(subject, typeof cfg.evidence_field === 'string' ? cfg.evidence_field : 'source_spans');
  if (!nonempty(cfg.expected_current_document_identity) || !isRecord(cfg.expected_source_identities)
    || !Object.keys(cfg.expected_source_identities).length
    || Object.values(cfg.expected_source_identities).some((identity) => !nonempty(identity))) {
    return failed(rule, 'missing_source_identity_policy');
  }
  if (!isRecord(proof) || !Array.isArray(proof.sources) || !Array.isArray(proof.quotes)
    || !isRecord(proof.current_document) || proof.sources.length === 0 || proof.quotes.length === 0) {
    return failed(rule, 'missing_source_span_evidence');
  }
  if (proof.current_document.content_identity !== cfg.expected_current_document_identity
    || typeof proof.current_document.destination_text !== 'string') return failed(rule, 'current_document_identity_mismatch');

  const sources = new Map<string, RecordValue>();
  for (const source of proof.sources) {
    if (!isRecord(source) || !nonempty(source.ref) || sources.has(source.ref)
      || !nonempty(source.content_identity) || typeof source.source_text !== 'string'
      || cfg.expected_source_identities[source.ref] !== source.content_identity) return failed(rule, 'invalid_or_unexpected_source_snapshot');
    sources.set(source.ref, source);
  }
  if (sources.size !== Object.keys(cfg.expected_source_identities).length
    || Object.keys(cfg.expected_source_identities).some((ref) => !sources.has(ref))) return failed(rule, 'source_identity_set_mismatch');
  const quoteIds = new Set<string>();
  for (const [index, quote] of proof.quotes.entries()) {
    if (!isRecord(quote) || !nonempty(quote.ref) || quoteIds.has(quote.ref)
      || !nonempty(quote.source_ref) || !sources.has(quote.source_ref)
      || !Number.isSafeInteger(quote.source_start_byte) || !Number.isSafeInteger(quote.source_end_byte)
      || (quote.source_start_byte as number) < 0 || (quote.source_end_byte as number) <= (quote.source_start_byte as number)
      || !nonempty(quote.source_literal) || !nonempty(quote.destination_literal)
      || !Number.isSafeInteger(quote.destination_start_byte) || !Number.isSafeInteger(quote.destination_end_byte)
      || (quote.destination_start_byte as number) < 0
      || (quote.destination_end_byte as number) <= (quote.destination_start_byte as number)) return failed(rule, 'invalid_quote_binding', index);
    quoteIds.add(quote.ref);
    const source = sources.get(quote.source_ref)!;
    if (quote.source_content_identity !== source.content_identity) return failed(rule, 'source_identity_mismatch', index);
    const sourceBytes = new TextEncoder().encode(source.source_text as string);
    if ((quote.source_end_byte as number) > sourceBytes.byteLength) return failed(rule, 'source_range_outside_snapshot', index);
    const sourceSpanBytes = sourceBytes.slice(quote.source_start_byte as number, quote.source_end_byte as number);
    let sourceLiteral: string;
    try {
      sourceLiteral = new TextDecoder('utf-8', { fatal: true }).decode(sourceSpanBytes);
    } catch {
      return failed(rule, 'source_span_splits_utf8', index);
    }
    if (sourceLiteral !== quote.source_literal) return failed(rule, 'source_literal_mismatch', index);
    const destinationBytes = new TextEncoder().encode(proof.current_document.destination_text);
    if ((quote.destination_end_byte as number) > destinationBytes.byteLength) return failed(rule, 'destination_range_outside_snapshot', index);
    let destinationLiteral: string;
    try {
      destinationLiteral = new TextDecoder('utf-8', { fatal: true }).decode(
        destinationBytes.slice(quote.destination_start_byte as number, quote.destination_end_byte as number),
      );
    } catch {
      return failed(rule, 'destination_span_splits_utf8', index);
    }
    if (destinationLiteral !== quote.destination_literal) return failed(rule, 'destination_literal_mismatch', index);
  }
  return { score: 100, findings: [] };
};

/**
 * Require complete per-block review coverage against the exact opaque current
 * document/block identities supplied by their existing owner. A review row is
 * an assertion by its named reviewer; this check does not authenticate them.
 */
export const writingProfileCoverageEvaluator: Evaluator = (subject, rule) => {
  const cfg = rule.config;
  const expectedDocumentIdentity = cfg.expected_current_document_identity;
  const current = evidence(subject, typeof cfg.current_document_field === 'string' ? cfg.current_document_field : 'current_document');
  const review = evidence(subject, typeof cfg.review_field === 'string' ? cfg.review_field : 'writing_review');
  if (!nonempty(expectedDocumentIdentity) || !isRecord(cfg.expected_component_source_identities)
    || !Array.isArray(cfg.allowed_component_review_decisions)
    || cfg.allowed_component_review_decisions.length === 0
    || cfg.allowed_component_review_decisions.some((value) => !nonempty(value))) return failed(rule, 'missing_review_policy');
  if (!isRecord(current) || !nonempty(current.content_identity) || current.content_identity !== expectedDocumentIdentity || !Array.isArray(current.blocks)
    || !current.blocks.length || !isRecord(review) || !Array.isArray(review.blocks)) return failed(rule, 'missing_current_document_or_review');
  if (review.document_identity !== current.content_identity) return failed(rule, 'stale_review_document');

  const allowedRoles = Array.isArray(cfg.allowed_reviewer_roles) ? cfg.allowed_reviewer_roles : ['author', 'reviewer'];
  const allowedDecisions = Array.isArray(cfg.allowed_decisions) ? cfg.allowed_decisions : ['retain', 'revised_and_reviewed'];
  if (cfg.require_source_group_identity !== undefined && typeof cfg.require_source_group_identity !== 'boolean') {
    return failed(rule, 'invalid_source_group_policy');
  }
  if (cfg.require_inherited_review_identity !== undefined && typeof cfg.require_inherited_review_identity !== 'boolean') {
    return failed(rule, 'invalid_inherited_review_policy');
  }
  const checksGroups = cfg.require_source_group_identity === true || cfg.require_inherited_review_identity === true
    || review.blocks.some((row) => isRecord(row) && Object.hasOwn(row, 'current_source_group_identity'));
  const sourceGroupByBlock = new Map<number, string>();
  if (checksGroups) {
    if (!Array.isArray(current.source_blocks)) return failed(rule, 'missing_current_source_groups');
    for (const group of current.source_blocks) {
      if (!isRecord(group) || !nonempty(group.content_identity) || !Array.isArray(group.visible_block_indexes)) {
        return failed(rule, 'invalid_current_source_group');
      }
      for (const index of group.visible_block_indexes) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= current.blocks.length || sourceGroupByBlock.has(index)) {
          return failed(rule, 'invalid_current_source_group_membership');
        }
        sourceGroupByBlock.set(index, group.content_identity);
      }
    }
    if (sourceGroupByBlock.size !== current.blocks.length) return failed(rule, 'incomplete_current_source_groups');
  }
  const reviewed = new Set<number>();
  for (const row of review.blocks) {
    if (!isRecord(row) || !Number.isSafeInteger(row.block_index)
      || (row.block_index as number) < 0 || (row.block_index as number) >= current.blocks.length
      || reviewed.has(row.block_index as number) || !nonempty(row.reviewer_role)
      || !allowedRoles.includes(row.reviewer_role) || !nonempty(row.reviewer_ref)
      || !nonempty(row.reason) || !allowedDecisions.includes(row.decision)) return failed(rule, 'invalid_or_duplicate_block_review');
    const block = current.blocks[row.block_index as number];
    if (!isRecord(block) || !nonempty(block.content_identity) || row.block_identity !== block.content_identity) {
      return failed(rule, 'stale_review_block', row.block_index as number);
    }
    if (checksGroups && (cfg.require_source_group_identity === true || Object.hasOwn(row, 'current_source_group_identity'))
      && row.current_source_group_identity !== sourceGroupByBlock.get(row.block_index as number)) {
      return failed(rule, 'review_source_group_mismatch', row.block_index as number);
    }
    if (cfg.require_inherited_review_identity === true && row.inherited_review != null
      && (!isRecord(row.inherited_review)
        || row.inherited_review.source_group_identity !== sourceGroupByBlock.get(row.block_index as number))) {
      return failed(rule, 'inherited_review_source_group_mismatch', row.block_index as number);
    }
    reviewed.add(row.block_index as number);
  }
  if (reviewed.size !== current.blocks.length) {
    const missing = current.blocks.findIndex((_, index) => !reviewed.has(index));
    return failed(rule, 'unreviewed_current_block', missing < 0 ? undefined : missing);
  }

  const requiredComponents = Array.isArray(cfg.required_component_refs) ? cfg.required_component_refs : [];
  if (new Set(requiredComponents).size !== requiredComponents.length || requiredComponents.some((ref) => !nonempty(ref))) {
    return failed(rule, 'invalid_required_component_policy');
  }
  const expectedSourceRefs = Object.keys(cfg.expected_component_source_identities);
  if (expectedSourceRefs.length !== requiredComponents.length
    || requiredComponents.some((component) => !expectedSourceRefs.includes(component))) return failed(rule, 'component_source_policy_set_mismatch');
  if (requiredComponents.some((component) => !nonempty(cfg.expected_component_source_identities[component]))) {
    return failed(rule, 'missing_required_component_source_identity');
  }
  const components = Array.isArray(review.components) ? review.components : [];
  const seenComponents = new Set<string>();
  for (const [index, row] of components.entries()) {
    if (!isRecord(row) || !nonempty(row.component_ref) || seenComponents.has(row.component_ref)
      || !requiredComponents.includes(row.component_ref) || !nonempty(row.source_identity)
      || !nonempty(row.destination_identity) || !nonempty(row.review_decision)
      || !cfg.allowed_component_review_decisions.includes(row.review_decision)
      || !nonempty(row.relationship_review)) return failed(rule, 'invalid_component_review', index);
    if (row.source_identity !== cfg.expected_component_source_identities[row.component_ref]) return failed(rule, 'stale_component_source', index);
    if (row.destination_identity !== current.content_identity) return failed(rule, 'stale_component_destination', index);
    seenComponents.add(row.component_ref);
  }
  for (const component of requiredComponents) {
    if (!seenComponents.has(component)) return failed(rule, 'unreviewed_required_component');
  }
  return { score: 100, findings: [] };
};

/**
 * Validate captured inference identity, example coverage and selected-option
 * thresholds from caller DATA. This checks the captured record's consistency;
 * it cannot authenticate a provider/model or decide whether the rubric itself
 * is semantically correct.
 */
export const inferenceCaptureQualificationEvaluator: Evaluator = (subject, rule) => {
  const cfg = rule.config;
  const capture = evidence(subject, typeof cfg.capture_field === 'string' ? cfg.capture_field : 'inference_capture');
  if (!isRecord(capture) || !isRecord(capture.model) || !Array.isArray(capture.examples)
    || !nonempty(capture.capture_identity) || !nonempty(capture.request_set_identity)) return failed(rule, 'missing_capture');
  const expectedModel = isRecord(cfg.expected_model) ? cfg.expected_model : null;
  if (!expectedModel || !nonempty(expectedModel.identity) || !nonempty(expectedModel.revision)
    || !nonempty(expectedModel.adapter_identity)
    || capture.model.identity !== expectedModel.identity || capture.model.revision !== expectedModel.revision) {
    return failed(rule, 'model_identity_mismatch');
  }
  if (capture.model.adapter_identity !== expectedModel.adapter_identity) return failed(rule, 'adapter_identity_mismatch');
  if (!nonempty(cfg.expected_capture_identity) || capture.capture_identity !== cfg.expected_capture_identity
    || !nonempty(cfg.expected_request_set_identity) || capture.request_set_identity !== cfg.expected_request_set_identity) {
    return failed(rule, 'capture_or_request_set_identity_mismatch');
  }
  if (!isRecord(cfg.expected_examples) || !Object.keys(cfg.expected_examples).length
    || !isRecord(cfg.minimum_probability_by_option) || cfg.decision_policy !== 'argmax') {
    return failed(rule, 'missing_capture_qualification_policy');
  }
  const expectedExamples = cfg.expected_examples;
  if (capture.examples.length !== Object.keys(expectedExamples).length) return failed(rule, 'capture_example_set_mismatch');
  const seen = new Set<string>();
  for (const [index, example] of capture.examples.entries()) {
    if (!isRecord(example) || !nonempty(example.identity) || seen.has(example.identity)
      || !nonempty(example.kind) || !nonempty(example.request_identity)
      || !nonempty(example.input_identity) || !nonempty(example.selected_option)
      || !isRecord(example.option_probabilities)) return failed(rule, 'invalid_captured_example', index);
    seen.add(example.identity);
    const expected = expectedExamples[example.identity];
    if (!isRecord(expected) || example.kind !== expected.kind
      || example.request_identity !== expected.request_identity || example.input_identity !== expected.input_identity
      || example.selected_option !== expected.selected_option) return failed(rule, 'unexpected_example_or_input_identity', index);
    const selectedProbability = example.option_probabilities[example.selected_option];
    const minimumProbability = cfg.minimum_probability_by_option[example.selected_option];
    if (typeof selectedProbability !== 'number' || !Number.isFinite(selectedProbability)
      || selectedProbability < 0 || selectedProbability > 1
      || typeof minimumProbability !== 'number' || !Number.isFinite(minimumProbability)
      || minimumProbability < 0 || minimumProbability > 1 || selectedProbability < minimumProbability) {
      return failed(rule, 'selected_option_below_threshold', index);
    }
    for (const [option, probability] of Object.entries(example.option_probabilities)) {
      if (!nonempty(option) || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        return failed(rule, 'invalid_option_probability', index);
      }
    }
    const probabilities = Object.values(example.option_probabilities) as number[];
    const probabilityTotal = probabilities.reduce((sum, probability) => sum + probability, 0);
    if (Math.abs(probabilityTotal - 1) > 0.001) return failed(rule, 'option_probabilities_not_normalized', index);
    if (probabilities.some((probability) => probability >= (selectedProbability as number)
      && probability !== selectedProbability)) return failed(rule, 'selected_option_is_not_argmax', index);
    if (probabilities.filter((probability) => probability === selectedProbability).length !== 1) {
      return failed(rule, 'selected_option_is_tied', index);
    }
  }
  if (seen.size !== Object.keys(expectedExamples).length
    || Object.keys(expectedExamples).some((identity) => !seen.has(identity))) return failed(rule, 'capture_example_set_mismatch');
  return { score: 100, findings: [] };
};

/** Validate a DATA-selected field in any subject block as an opaque address. */
export const addressedReferenceEvaluator: Evaluator = (subject, rule) => {
  const field = rule.config.required_ref_field;
  if (!nonempty(field)) return failed(rule, 'missing_reference_field_policy');
  const found = subject.blocks.some((block) => nonempty(block[field]));
  return found ? { score: 100, findings: [] } : failed(rule, 'required_addressed_reference_missing');
};

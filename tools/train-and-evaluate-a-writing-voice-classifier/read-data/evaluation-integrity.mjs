// tools/train-and-evaluate-a-writing-voice-classifier/read-data/evaluation-integrity.mjs
// The maintained checks of a writing-voice challenge, its request plans and a stored evaluation report. Pure: nothing
// is read or sent here. Pure checks only; this module performs no external I/O.
import { isDeepStrictEqual } from 'node:util';
// The hosted classifier's wire shape has one home: tools/ask-a-small-model-for-a-verdict.
import { intoBatchRequest, outOfBatchReply } from '../../ask-a-small-model-for-a-verdict/do-work/ask-a-hosted-classifier.mjs';

export const LABELS = ['pass', 'fail', 'uncertain'];
export const REQUEST_POLICY = 'neutral-passage-and-criterion-context-v1';
export const TYPED_REQUEST_POLICY = 'typed-target-and-pinned-reference-v1';
export const CHUNKED_TYPED_REQUEST_POLICY = 'typed-source-bound-section-chunks-v1';
export const SERVING_IDENTITY_POLICY = 'observed-health-and-response-v1';
const SCHEMAS = new Set(['book-voice-decider-challenge-v1', 'book-voice-decider-challenge-v2', 'book-voice-decider-challenge-v3']);
const BLOCK_KINDS = ['paragraph', 'heading', 'table', 'list', 'quote', 'mixed'];
const SECTION_FIT_ID = 'section-heading-fit';
const fail = message => { throw new Error(message); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => isDeepStrictEqual(a, b);
const close = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-10;
export function validServingIdentity(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

export function requestPolicyFor(input) {
  if (input?.schema === 'book-voice-decider-challenge-v3'
      && input.criteria?.some(criterion => criterion.id === SECTION_FIT_ID && criterion.section_chunk_request)) return CHUNKED_TYPED_REQUEST_POLICY;
  return input?.schema === 'book-voice-decider-challenge-v3' ? TYPED_REQUEST_POLICY : REQUEST_POLICY;
}

export function classifyWritingBlock(text) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('writing block must be nonempty text');
  const lines = text.trim().split(/\r?\n/u).map(line => line.trim());
  if (lines.length === 1 && /^#{1,6}\s+\S.*$/u.test(lines[0])) return 'heading';
  const tableRow = /^\|.*\|$/u;
  const separator = /^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u;
  if (lines.length >= 2 && lines.every(line => tableRow.test(line)) && lines.some(line => separator.test(line))) return 'table';
  if (lines.every(line => /^>\s?/u.test(line))) return 'quote';
  if (lines.every(line => /^(?:[-+*]|\d+[.)])\s+\S/u.test(line))) return 'list';
  if (lines.some(line => /^#{1,6}\s+\S/u.test(line)) || lines.some(line => /^>\s?/u.test(line))
      || lines.some(line => /^(?:[-+*]|\d+[.)])\s+\S/u.test(line)) || lines.some(line => tableRow.test(line))) return 'mixed';
  return 'paragraph';
}

export function criterionAppliesTo(criterion, item, input) {
  if (input?.schema !== 'book-voice-decider-challenge-v3') return true;
  return criterion.applies_to.includes(item.block_kind);
}

// Categorical rubrics own their labels; pass/fail are only the baseline.
export function criterionDecisionLabels(criterion) {
  const names = criterion?.deterministic || criterion?.primitive === 'true-or-false'
    ? LABELS
    : (criterion?.options ?? LABELS).map(option => typeof option === 'string' ? option : option.name);
  return [...new Set([...names, 'uncertain'])];
}

export function validateInput(input, {mode = 'evaluation'} = {}) {
  if (!['evaluation', 'scoring-evaluation', 'unlabeled', 'training'].includes(mode)) fail('unsupported input validation mode');
  if (mode === 'training' && (input?.schema !== 'book-voice-decider-challenge-v3'
      || !Array.isArray(input.items) || input.items.some(item => !isRecord(item)
        || !['train', 'eval', 'unlabeled'].includes(item.split)))) {
    fail('training validation requires v3 items with explicit source splits');
  }
  if (mode === 'training' && (typeof input.dataset_role !== 'string' || !input.dataset_role.trim())) {
    fail('training source DATA must declare nonempty dataset_role metadata');
  }
  if (!SCHEMAS.has(input?.schema) || !Array.isArray(input.items)) fail('unsupported challenge schema or items');
  if (mode === 'scoring-evaluation' && (input.schema !== 'book-voice-decider-challenge-v3'
      || input.items.some(item => !isRecord(item) || item.split !== 'eval'))) {
    fail('isolated scoring evaluation requires only v3 eval items');
  }
  if (mode === 'unlabeled' && (input.schema !== 'book-voice-decider-challenge-v3'
      || input.items.some(item => !isRecord(item) || item.split !== 'unlabeled'
        || item.gold != null || (item.checks != null && (!isRecord(item.checks) || Object.keys(item.checks).length))))) {
    fail('unlabeled validation requires only v3 unlabeled items without labels');
  }
  const ids = new Set();
  const splitsByFamily = new Map();
  for (const item of input.items) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) fail(`missing or duplicate challenge item id: ${item?.id ?? '(none)'}`);
    ids.add(item.id);
    const prior = splitsByFamily.get(item.family);
    if (typeof item.family !== 'string' || !item.family || typeof item.split !== 'string' || !item.split || (prior && prior !== item.split)) {
      fail(`missing family or split leakage: ${item.family ?? item.id}`);
    }
    splitsByFamily.set(item.family, item.split);
    if (typeof item.text !== 'string' || !item.text || !(item.origin?.kind || item.source_kind)) fail(`incomplete item: ${item.id}`);
    if (item.split === 'eval' && item.gold != null && !LABELS.includes(item.gold)) fail(`invalid overall gold label: ${item.id}`);
    if (item.context != null && typeof item.context !== 'string') fail(`invalid context: ${item.id}`);
    if (item.check_context != null && (!isRecord(item.check_context) || Object.values(item.check_context).some(value => typeof value !== 'string' || !value))) fail(`invalid criterion context: ${item.id}`);
    if (input.schema === 'book-voice-decider-challenge-v3') {
      if (!BLOCK_KINDS.includes(item.block_kind)) fail(`invalid block kind for ${item.id}`);
      if (classifyWritingBlock(item.text) !== item.block_kind) fail(`block kind does not match target structure for ${item.id}`);
      if (item.reader_context != null && typeof item.reader_context !== 'string') fail(`invalid reader context for ${item.id}`);
      if (Object.hasOwn(item, 'check_context')) fail(`v3 does not allow per-item criterion context for ${item.id}`);
    }
    if (item.role != null && !['authored', 'quote', 'reference'].includes(item.role)) fail(`invalid authored role: ${item.id}`);
  }
  const evalItems = input.items.filter(item => item.split === 'eval');
  const trainItems = input.items.filter(item => item.split === 'train');
  const assessedItems = ['unlabeled', 'training'].includes(mode) ? input.items : evalItems;
  if (mode === 'training' && !trainItems.length) fail('challenge set has no explicitly designated train items');
  if (!assessedItems.length) fail(mode === 'unlabeled' ? 'challenge set has no unlabeled items' : 'challenge set has no eval items');

  const criteria = input.criteria ?? null;
  if (input.schema === 'book-voice-decider-challenge-v3' && !criteria) fail('v3 challenge requires typed criteria');
  if (!criteria) {
    if (typeof input.question !== 'string' || !input.question.trim() || !Array.isArray(input.options) || !input.options.length) fail('baseline DATA must declare its question and options');
    if (input.options.some(option => typeof option !== 'string' || !option) || new Set(input.options).size !== input.options.length) fail('baseline options must be unique nonempty strings');
    if (input.options.join('|') !== LABELS.join('|')) fail('baseline DATA must use pass/fail/uncertain options in the supported order');
  } else {
    if (!Array.isArray(criteria) || !criteria.length) fail('criteria must be a nonempty array');
    const ids = new Set();
    for (const criterion of criteria) {
      if (typeof criterion?.id === 'string' && Object.hasOwn(Object.prototype, criterion.id)) fail(`prototype-sensitive criterion id is not supported by the shared classifier transport: ${criterion.id}`);
      if (!isRecord(criterion) || typeof criterion.id !== 'string' || !criterion.id || ids.has(criterion.id) || typeof criterion.question !== 'string' || !criterion.question.trim()) fail(`invalid or duplicate criterion: ${criterion?.id ?? '(none)'}`);
      ids.add(criterion.id);
      const kind = criterion.primitive ?? 'one-of';
      if (!['one-of', 'true-or-false'].includes(kind)) fail(`unsupported primitive ${kind} for ${criterion.id}`);
      if (kind === 'one-of') {
        if (!Array.isArray(criterion.options) || !criterion.options.length) fail(`missing options for ${criterion.id}`);
        for (const option of criterion.options) {
          if (typeof option === 'string') {
            if (!option) fail(`empty option for ${criterion.id}`);
          } else if (!isRecord(option) || typeof option.name !== 'string' || !option.name || !(option.description == null || typeof option.description === 'string')) {
            fail(`malformed option for ${criterion.id}`);
          }
        }
        const names = criterion.options.map(option => typeof option === 'string' ? option : option.name);
        if (new Set(names).size !== names.length) fail(`duplicate options for ${criterion.id}`);
      }
      if (kind === 'true-or-false' && criterion.means != null && (!isRecord(criterion.means) || typeof criterion.means.yes !== 'string' || typeof criterion.means.no !== 'string')) fail(`malformed true/false meanings for ${criterion.id}`);
      if (criterion.deterministic && kind !== 'one-of') fail(`unsupported deterministic primitive for ${criterion.id}`);
      if (criterion.diagnostic_min_probability != null && (!Number.isFinite(criterion.diagnostic_min_probability) || criterion.diagnostic_min_probability < 0 || criterion.diagnostic_min_probability > 1)) fail(`invalid diagnostic minimum for ${criterion.id}`);
      if (input.schema === 'book-voice-decider-challenge-v3') {
        if (typeof criterion.reference_context !== 'string' || !criterion.reference_context.trim()) fail(`invalid or missing pinned reference context for ${criterion.id}`);
        if (!Array.isArray(criterion.applies_to) || !criterion.applies_to.length
            || criterion.applies_to.some(blockKind => !BLOCK_KINDS.includes(blockKind))
            || new Set(criterion.applies_to).size !== criterion.applies_to.length) fail(`invalid or missing criterion applicability for ${criterion.id}`);
      }
      if (criterion.section_chunk_request != null) {
        const descriptor = criterion.section_chunk_request;
        if (criterion.id !== SECTION_FIT_ID || criterion.deterministic || (criterion.primitive ?? 'one-of') !== 'one-of'
            || input.schema !== 'book-voice-decider-challenge-v3'
            || !Array.isArray(criterion.applies_to) || !same(criterion.applies_to, ['heading'])
            || !isRecord(descriptor)
            || typeof descriptor.question !== 'string' || !descriptor.question.trim()
            || !Array.isArray(descriptor.options) || descriptor.options.length < 2
            || descriptor.options.some(value => typeof value !== 'string' || !value)
            || new Set(descriptor.options).size !== descriptor.options.length
            || !descriptor.options.includes('pass') || !descriptor.options.includes('fail')
            || !descriptor.options.includes('uncertain')) {
          fail(`invalid section chunk request descriptor for ${criterion.id}`);
        }
        const criterionOptions = (criterion.options ?? []).map(option => typeof option === 'string' ? option : option.name);
        if (!same(descriptor.options, criterionOptions)) fail(`section chunk options must match policy criterion options for ${criterion.id}`);
      }
    }
    for (const item of assessedItems) {
      if (item.gold != null && !LABELS.includes(item.gold)) fail(`invalid overall gold label: ${item.id}`);
      const checks = item.checks ?? {};
      if (!isRecord(checks) || Object.entries(checks).some(([id, label]) => {
        const criterion = criteria.find(one => one.id === id);
        return !ids.has(id) || !criterionDecisionLabels(criterion).includes(label) || !criterionAppliesTo(criterion, item, input);
      })) fail(`invalid gold checks: ${item.id}`);
      for (const criterionId of Object.keys(item.check_context ?? {})) if (!ids.has(criterionId)) fail(`unknown criterion context ${criterionId} on ${item.id}`);
    }
    if (input.schema === 'book-voice-decider-challenge-v3' && input.items.some(item =>
      !criteria.some(criterion => criterionAppliesTo(criterion, item, input)))) {
      fail('no criterion applies to one or more typed blocks');
    }
    const chunkCriterion = criteria.find(criterion => criterion.id === SECTION_FIT_ID && criterion.section_chunk_request);
    const manifests = input.items.filter(item => item.section_chunk_manifest != null);
    if (chunkCriterion || manifests.length) {
      if (typeof input.document_blake3 !== 'string' || !/^[0-9a-f]{64}$/.test(input.document_blake3)
          || input.items.some(item => !Number.isSafeInteger(item.source_block_index) || item.source_block_index < 0)
          || manifests.length !== input.items.filter(item => item.block_kind === 'heading').length) {
        fail('source-bound section chunk manifests require the current document hash and indexed complete source blocks');
      }
      const ordered = [...input.items].sort((a, b) => a.source_block_index - b.source_block_index);
      if (ordered.some((item, index) => item.source_block_index !== index)) fail('source block indices must cover the current document in order');
      const byIndex = new Map(ordered.map(item => [item.source_block_index, item]));
      for (const heading of ordered.filter(item => item.block_kind === 'heading')) {
        const manifest = heading.section_chunk_manifest;
        const headingMatch = /^(#{1,6})\s+\S.*$/u.exec(heading.text.trim());
        if (!chunkCriterion || !isRecord(manifest) || manifest.source_blake3 !== input.document_blake3
            || manifest.heading_block_index !== heading.source_block_index
            || !Number.isSafeInteger(manifest.section_end_block_index)
            || manifest.section_end_block_index <= heading.source_block_index + 1
            || manifest.section_end_block_index > ordered.length || !Array.isArray(manifest.chunks)
            || !manifest.chunks.length || !headingMatch) fail(`invalid or stale complete section manifest for ${heading.id}`);
        let expectedEnd = ordered.length;
        for (let index = heading.source_block_index + 1; index < ordered.length; index++) {
          const match = /^(#{1,6})\s+\S.*$/u.exec(ordered[index].text.trim());
          if (match && match[1].length <= headingMatch[1].length) { expectedEnd = index; break; }
        }
        if (manifest.section_end_block_index !== expectedEnd) fail(`section chunk manifest has stale or incorrect heading bounds for ${heading.id}`);
        const complete = Array.from({length: expectedEnd - heading.source_block_index - 1}, (_, i) => heading.source_block_index + i + 1);
        let covered = [];
        for (const [position, chunk] of manifest.chunks.entries()) {
          if (!isRecord(chunk) || chunk.chunk_index !== position || !Array.isArray(chunk.block_indices)
              || !chunk.block_indices.length || chunk.block_indices.some((index, offset) =>
                !Number.isSafeInteger(index) || index !== chunk.block_indices[0] + offset)) fail(`malformed or reordered section chunk for ${heading.id}`);
          const text = chunk.block_indices.map(index => byIndex.get(index)?.text);
          if (text.some(value => typeof value !== 'string')) fail(`section chunk references an unknown source block for ${heading.id}`);
          if (chunk.text !== text.join('\n\n')) fail(`section chunk text differs from source blocks for ${heading.id}`);
          if (Object.hasOwn(chunk, 'gold') && (!['pass', 'fail', 'uncertain'].includes(chunk.gold)
              || heading.split !== 'eval' || !heading.checks?.[SECTION_FIT_ID])) fail(`invalid offwire chunk qualification label for ${heading.id}`);
          if (heading.split === 'eval' && heading.checks?.[SECTION_FIT_ID] != null && !Object.hasOwn(chunk, 'gold')) fail(`missing per-chunk gold label for qualification heading ${heading.id}`);
          covered.push(...chunk.block_indices);
        }
        if (!same(covered, complete)) fail(`section chunks omit, duplicate, or reorder source blocks for ${heading.id}`);
      }
    }
  }
  return mode === 'training' ? { evalItems, trainItems, criteria } : { evalItems, criteria };
}

export function requestPlan(input, item, criteria = input.criteria ?? null) {
  // General context can contain the author's feedback or labels. Use only the
  // passage plus criterion-scoped evidence explicitly provided for that check.
  const isV3 = input?.schema === 'book-voice-decider-challenge-v3';
  let content;
  let referenceText;
  if (isV3) {
    const applicableCriteria = criteria.filter(criterion => criterionAppliesTo(criterion, item, input));
    const references = Object.fromEntries(applicableCriteria
      .filter(criterion => typeof criterion.reference_context === 'string' && criterion.reference_context.trim())
      .map(criterion => [criterion.id, criterion.reference_context]));
    const uniqueReferences = [...new Set(Object.values(references))];
    referenceText = uniqueReferences.length <= 1 ? (uniqueReferences[0] ?? '') : references;
    content = JSON.stringify({
      reference_text: referenceText,
      reader_context: item.reader_context ?? '',
      target_kind: item.block_kind,
      target_text: item.text,
    });
  } else {
    content = `Passage: ${item.text}`;
  }
  if (!criteria) return { content, asking: { verdict: { question: input.question, shape: { kind: 'one-of', options: input.options } } } };
  const asking = {};
  const goldChecks = item.checks ?? {};
  for (const criterion of criteria) {
    if (!isV3 && Object.keys(goldChecks).length && !(criterion.id in goldChecks)) continue;
    if (!criterionAppliesTo(criterion, item, input)) continue;
    if (criterion.deterministic) continue;
    const criterionContext = isV3 ? criterion.reference_context : item.check_context?.[criterion.id];
    const question = isV3 && criterionContext
      ? `${criterion.question} Use reference_text${typeof referenceText === 'string' ? '' : `.${criterion.id}`}.`
      : !isV3 && criterionContext
        ? `${criterion.question}\n\nCriterion-specific source context (use only for this criterion): ${criterionContext}`
        : criterion.question;
    asking[criterion.id] = { question, shape: criterion.primitive === 'true-or-false'
      ? { kind: 'true-or-false', ...(criterion.means === undefined ? {} : { means: criterion.means }) }
      : { kind: 'one-of', options: criterion.options ?? LABELS } };
  }
  const chunkCriterion = criteria?.find(criterion => criterion.id === SECTION_FIT_ID && criterion.section_chunk_request);
  const manifest = item.section_chunk_manifest;
  if (manifest != null && (!chunkCriterion || !Array.isArray(manifest.chunks))) fail(`invalid section chunk manifest for ${item.id}`);
  if (chunkCriterion && item.block_kind === 'heading' && !manifest) fail(`missing complete section chunk manifest for ${item.id}`);
  const chunkRequests = manifest ? manifest.chunks.map((chunk, position) => {
    const descriptor = chunkCriterion.section_chunk_request;
    const chunkContent = JSON.stringify({
      reference_text: referenceText,
      target_kind: item.block_kind,
      target_text: item.text,
      section_chunk: {source_blake3:manifest.source_blake3,
        heading_block_index:manifest.heading_block_index,section_end_block_index:manifest.section_end_block_index,
        chunk_index: chunk.chunk_index, chunk_count: manifest.chunks.length,
        block_indices: chunk.block_indices, text: chunk.text},
    });
    return {chunk_index: position, content: chunkContent,
      asking: {[SECTION_FIT_ID]: {question: descriptor.question,
        shape: {kind: 'one-of', options: descriptor.options}}}};
  }) : [];
  if (manifest) delete asking[SECTION_FIT_ID];
  return { content, asking, ...(manifest ? {section_chunk_manifest: manifest, chunk_requests: chunkRequests} : {}) };
}

export function reportCriteria(criteria) {
  return criteria?.map(criterion => ({id: criterion.id, question: criterion.question ?? null,
    deterministic: Boolean(criterion.deterministic),
    ...(criterion.reference_context === undefined ? {} : {reference_context: criterion.reference_context}),
    ...(criterion.applies_to === undefined ? {} : {applies_to: criterion.applies_to}),
    ...(criterion.section_chunk_request === undefined ? {} : {section_chunk_request: criterion.section_chunk_request}),
    ...(criterion.section_chunk_request === undefined || criterion.diagnostic_min_probability === undefined
      ? {} : {diagnostic_min_probability: criterion.diagnostic_min_probability}),
  })) ?? null;
}

export function validateReport(report, expected, options = {}) {
  const { evalItems, criteria } = validateInput(expected.input);
  const byId = new Map(evalItems.map(item => [item.id, item]));
  if (!isRecord(report) || report.schema !== 'book-voice-decider-evaluation-v2') fail('unsupported prior result schema');
  const identity = {
    model: expected.model,
    endpoint: expected.endpoint,
    route: 'shared local classifier adapter -> /v1/systemone',
    data: expected.dataPath,
    data_blake3: expected.dataBlake3,
    rubric_blake3: expected.rubricBlake3 ?? null,
    dataset_role: expected.input.dataset_role ?? null,
    source_derivative: expected.input.source_derivative ?? null,
    assembled_docx: expected.input.assembled_docx ?? null,
    split: 'eval',
    expected_items: evalItems.length,
    question: criteria ? null : expected.input.question,
    criteria: reportCriteria(criteria),
  };
  for (const [key, value] of Object.entries(identity)) if (!same(report[key] ?? null, value)) fail(`Cannot resume: ${key} changed or is malformed`);
  const requestPolicy = report.request_policy ?? null;
  const identityPolicy = report.serving_identity_policy ?? null;
  if (Object.hasOwn(expected, 'servingIdentityPolicy') && identityPolicy !== expected.servingIdentityPolicy) fail('Cannot resume: serving identity policy changed');
  const evidenceVersion = report.request_evidence_version ?? 0;
  if (![0, 1, 'mixed-legacy-v0+v1'].includes(evidenceVersion)) fail('Cannot resume: unsupported request evidence version');
  const requiredRequestPolicy = requestPolicyFor(expected.input);
  if (requestPolicy === requiredRequestPolicy && evidenceVersion !== 1) fail('Cannot resume: current request policy requires captured evidence on every row');
  if (requestPolicy === 'legacy-unknown' && evidenceVersion !== 'mixed-legacy-v0+v1') fail('Cannot resume: legacy request evidence marker is inconsistent');
  if (requestPolicy == null && evidenceVersion !== 0) fail('Cannot resume: request evidence exists without a request policy');
  if (requestPolicy !== expected.requestPolicy || (requiredRequestPolicy === TYPED_REQUEST_POLICY && expected.requestPolicy !== requiredRequestPolicy)) {
    if (requiredRequestPolicy === TYPED_REQUEST_POLICY || requiredRequestPolicy === CHUNKED_TYPED_REQUEST_POLICY)
      fail('Cannot resume: v3 requires current typed-target and section-chunk request evidence');
    const safeCompleteLegacy = requestPolicy === null && !report.request_evidence_version && report.complete === true && report.errors?.length === 0 && report.items?.length === evalItems.length;
    const safeLegacyReadback = requestPolicy === 'legacy-unknown' && report.complete === true && report.errors?.length === 0 && report.items?.length === evalItems.length;
    if (!safeCompleteLegacy && !safeLegacyReadback) fail('Cannot resume: request policy changed or legacy requests are unproved for pending rows');
  }
  if (options.requireServing && !same(report.serving ?? null, expected.serving ?? null)) fail('Cannot resume: serving identity changed or is unavailable');
  if (report.complete !== Boolean(report.complete) || !Array.isArray(report.items) || !Array.isArray(report.errors)) fail('Cannot resume: malformed completion, items, or errors');
  if (report.evaluated_items !== report.items.length) fail('Cannot resume: evaluated_items does not match result rows');

  const seen = new Set();
  const addId = (id, kind) => {
    if (typeof id !== 'string' || !byId.has(id)) fail(`Cannot resume: unknown ${kind} row ${id ?? '(missing id)'}`);
    if (seen.has(id)) fail(`Cannot resume: duplicate or overlapping row ${id}`);
    seen.add(id);
  };
  for (const row of report.items) {
    if (!isRecord(row)) fail('Cannot resume: malformed result row');
    addId(row.id, 'result');
    if (row.serving_identity_policy != null && row.serving_identity_policy !== SERVING_IDENTITY_POLICY) fail(`Cannot resume: unsupported row serving identity policy for ${row.id}`);
    if (identityPolicy === SERVING_IDENTITY_POLICY && Object.keys(requestPlan(expected.input, byId.get(row.id), criteria).asking).length && row.serving_identity_policy !== SERVING_IDENTITY_POLICY) fail(`Cannot resume: enforced report contains unverified model row ${row.id}`);
    const source = byId.get(row.id);
    if (expected.input.schema === 'book-voice-decider-challenge-v3' && row.block_kind !== source.block_kind) fail(`Cannot resume: block kind changed for ${row.id}`);
    if (row.family !== source.family || !same(row.origin ?? null, source.origin ?? null)) fail(`Cannot resume: source metadata changed for ${row.id}`);
    if (criteria) {
      if (!same(row.axes ?? null, source.axis ?? null) || !same(row.gold_checks ?? {}, source.checks ?? {})) fail(`Cannot resume: axes or label scope changed for ${row.id}`);
      validateCriterionResults(row, source, criteria, expected.input);
    } else {
      if (!same(row.axis ?? null, source.axis ?? null) || !same(row.gold ?? null, source.gold ?? null)) fail(`Cannot resume: axis or label scope changed for ${row.id}`);
      validateOverallResult(row, source, expected.input.options);
    }
    validateEvidenceIfPresent(row, source, expected.input, criteria, expected, row);
  }
  for (const row of report.errors) {
    if (!isRecord(row) || typeof row.error !== 'string' || !row.error) fail('Cannot resume: malformed error row');
    addId(row.id, 'error');
    validateErrorEvidenceIfPresent(row, byId.get(row.id), expected.input, criteria, expected);
  }
  if (report.prior_errors != null) {
    if (!Array.isArray(report.prior_errors)) fail('Cannot resume: malformed prior_errors');
    const priorErrorIds = new Set();
    for (const row of report.prior_errors) {
      if (!isRecord(row) || typeof row.error !== 'string' || !row.error || typeof row.id !== 'string' || !byId.has(row.id) || priorErrorIds.has(row.id)) fail('Cannot resume: malformed or duplicate prior error row');
      priorErrorIds.add(row.id);
      validateErrorEvidenceIfPresent(row, byId.get(row.id), expected.input, criteria, expected);
    }
  }
  const full = seen.size === evalItems.length;
  const modelRows = report.items.filter(row => Object.keys(requestPlan(expected.input, byId.get(row.id), criteria).asking).length > 0);
  if (identityPolicy != null && identityPolicy !== SERVING_IDENTITY_POLICY && identityPolicy !== 'historical-unverified') fail('Cannot resume: unsupported serving identity policy');
  if (identityPolicy === SERVING_IDENTITY_POLICY && report.items.some(row => Object.keys(requestPlan(expected.input, byId.get(row.id), criteria).asking).length) && !validServingIdentity(report.serving)) fail('Cannot resume: enforced serving identity is missing or malformed');
  for (const row of report.items) {
    if (row.serving_identity_policy === SERVING_IDENTITY_POLICY) {
      if (identityPolicy == null) fail(`Cannot resume: row serving identity assurance has no report marker for ${row.id}`);
      if (modelRows.includes(row)) {
        if (!validServingIdentity(report.serving)) fail(`Cannot resume: row serving identity is missing for ${row.id}`);
        if (!isRecord(row.request_evidence) || !Array.isArray(row.request_evidence.exchanges) || !row.request_evidence.exchanges.some(exchange => Number.isInteger(exchange.status) && exchange.status >= 200 && exchange.status < 300)) fail(`Cannot resume: enforced model row has no successful captured response for ${row.id}`);
        // An identity marker cannot upgrade v0 evidence through the legacy shortcut.
        if (evidenceVersion !== 1 && evidenceVersion !== 'mixed-legacy-v0+v1') fail(`Cannot resume: enforced model row requires captured request evidence for ${row.id}`);
        validateObservedServingEvidence(row, {...expected, serving: report.serving});
      }
    }
  }
  const identityAssurance = !modelRows.length ? 'no-accepted-model-results'
    : modelRows.every(row => row.serving_identity_policy === SERVING_IDENTITY_POLICY) ? 'observed-health-and-response' : 'historical-unverified';
  if (report.serving_identity_assurance != null && report.serving_identity_assurance !== identityAssurance) fail('Cannot resume: serving identity assurance disagrees with accepted model evidence');
  if (report.complete !== full) fail(`Cannot resume: completion flag disagrees with expected-row coverage (${seen.size}/${evalItems.length})`);
  if (report.complete && evalItems.some(item => !seen.has(item.id))) fail('Cannot resume: completed report omitted expected rows');
  return { items: report.items, errors: report.errors, complete: report.complete, coveredIds: seen,
    identity_assurance: identityAssurance };
}

function validateObservedServingEvidence(row, expected) {
  for (const exchange of row.request_evidence?.exchanges ?? []) {
    if (exchange.status < 200 || exchange.status >= 300) continue;
    let body;
    try { body = JSON.parse(exchange.response); } catch { fail(`Cannot resume: invalid raw response JSON for ${row.id}`); }
    if (body?.model !== expected.model) fail(`Cannot resume: response model identity changed for ${row.id}`);
    if (!validServingIdentity(body?.served_identity) || body.served_identity !== expected.serving) fail(`Cannot resume: response serving identity changed or is missing for ${row.id}`);
  }
}

function expectedCheckIds(item, criteria, input = null) {
  const checks = item.checks ?? {};
  return criteria.filter(criterion => {
    if (input?.schema === 'book-voice-decider-challenge-v3') return criterionAppliesTo(criterion, item, input);
    return !Object.keys(checks).length || criterion.id in checks;
  }).map(criterion => criterion.id);
}

function validDistribution(probabilities, allowed, rowId) {
  if (!isRecord(probabilities) || !same(Object.keys(probabilities).sort(), [...allowed].sort())) fail(`Cannot resume: malformed probability keys for ${rowId}`);
  const values = Object.values(probabilities);
  // The classifier serializes probabilities rounded to four decimal places.
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.0011) fail(`Cannot resume: malformed probabilities for ${rowId}`);
}

export function expectedDecision(predicted, probabilities, threshold = 0.5) {
  const selectedProbability = probabilities?.[predicted] ?? 0;
  return selectedProbability > threshold ? predicted : 'uncertain';
}

export function aggregateSectionChunkResults(results, expectedCount = results.length) {
  if (!Array.isArray(results) || results.length !== expectedCount || expectedCount <= 0) return 'uncertain';
  if (results.some(result => result?.predicted === 'fail' && result?.decision === 'fail')) return 'fail';
  if (results.every(result => result?.predicted === 'pass' && result?.decision === 'pass')) return 'pass';
  return 'uncertain';
}

function validateOverallResult(row, source, options) {
  if (!options.includes(row.predicted) || !LABELS.includes(row.decision)) fail(`Cannot resume: invalid overall prediction for ${row.id}`);
  validDistribution(row.probabilities, options, row.id);
  if (row.decision !== expectedDecision(row.predicted, row.probabilities)) fail(`Cannot resume: decision does not follow stored probabilities for ${row.id}`);
  if (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1 || !Number.isFinite(row.elapsed_ms) || row.elapsed_ms < 0) fail(`Cannot resume: malformed overall result values for ${row.id}`);
}

function validateCriterionResults(row, source, criteria, input = null) {
  if (!isRecord(row.checks)) fail(`Cannot resume: missing criterion results for ${row.id}`);
  const expectedIds = expectedCheckIds(source, criteria, input);
  if (!same(Object.keys(row.checks).sort(), expectedIds.sort())) fail(`Cannot resume: missing or extra criterion results for ${row.id}`);
  for (const id of expectedIds) {
    const result = row.checks[id];
    const criterion = criteria.find(value => value.id === id);
    const gold = source.checks?.[id];
    const decisionLabels = criterionDecisionLabels(criterion);
    const allowed = criterion.deterministic ? LABELS : criterion.primitive === 'true-or-false'
      ? ['pass', 'fail'] : (criterion.options ?? LABELS).map(option => typeof option === 'string' ? option : option.name);
    if (!isRecord(result) || !same(result.gold ?? null, gold ?? null) || !allowed.includes(result.predicted) || !decisionLabels.includes(result.decision)) fail(`Cannot resume: malformed criterion result ${id} on ${row.id}`);
    const expectedContextUsed = input?.schema === 'book-voice-decider-challenge-v3'
      ? !criterion.deterministic && Boolean(criterion.reference_context) : Boolean(source.check_context?.[id]);
    if (result.criterion_context_used !== expectedContextUsed) fail(`Cannot resume: criterion context binding changed for ${id} on ${row.id}`);
    if (result.method === 'derived section chunk aggregation') {
      const manifest = source.section_chunk_manifest;
      const aggregate = result.section_chunk_aggregate;
      if (id !== SECTION_FIT_ID || !manifest || !isRecord(aggregate) || !Array.isArray(aggregate.chunk_results)
          || aggregate.chunk_results.length !== manifest.chunks.length || result.primitive !== 'derived'
          || result.confidence !== null || result.probabilities !== null || result.raw_answer !== null) {
        fail(`Cannot resume: malformed derived section chunk result ${id} on ${row.id}`);
      }
      const labels = [];
      for (const [index, chunk] of manifest.chunks.entries()) {
        const savedChunk = aggregate.chunk_results[index];
        const names = chunkCriterionChunkOptions(criterion);
        if (!isRecord(savedChunk) || savedChunk.chunk_index !== index
            || !same(savedChunk.gold ?? null, chunk.gold ?? null)
            || !names.includes(savedChunk.predicted) || !names.includes(savedChunk.raw_answer)
            || !LABELS.includes(savedChunk.decision)) fail(`Cannot resume: malformed per-chunk result ${id}/${index} on ${row.id}`);
        validDistribution(savedChunk.probabilities, names, `${row.id}/${id}/${index}`);
        if (!(savedChunk.confidence === null || Number.isFinite(savedChunk.confidence)
            && savedChunk.confidence >= 0 && savedChunk.confidence <= 1)) fail(`Cannot resume: malformed per-chunk confidence ${id}/${index} on ${row.id}`);
        const expectedChunkDecision = expectedDecision(savedChunk.predicted, savedChunk.probabilities, criterion.diagnostic_min_probability ?? 0.5);
        if (savedChunk.raw_answer !== savedChunk.predicted || savedChunk.decision !== expectedChunkDecision) fail(`Cannot resume: per-chunk decision mismatch ${id}/${index} on ${row.id}`);
        labels.push({predicted:savedChunk.predicted, decision:savedChunk.decision});
      }
      const aggregateLabel = aggregateSectionChunkResults(labels, manifest.chunks.length);
      if (aggregate.label !== aggregateLabel || result.predicted !== aggregateLabel || result.decision !== aggregateLabel) fail(`Cannot resume: section chunk aggregation mismatch ${id} on ${row.id}`);
      if (!Number.isFinite(result.elapsed_ms) || result.elapsed_ms < 0) fail(`Cannot resume: malformed section chunk timing ${id} on ${row.id}`);
      continue;
    }
    if (criterion.deterministic) {
      const expected = source.role !== 'authored' ? 'uncertain' : source.text.includes('—') ? 'fail' : 'pass';
      if (result.method !== 'deterministic local scan' || result.predicted !== expected || result.decision !== expected || result.probabilities !== null || result.confidence !== null) fail(`Cannot resume: deterministic result mismatch ${id} on ${row.id}`);
    } else {
      validDistribution(result.probabilities, allowed, `${row.id}/${id}`);
      const predicted = criterion.primitive === 'true-or-false'
        ? result.raw_answer === true ? 'pass' : result.raw_answer === false ? 'fail' : null
        : result.raw_answer;
      if (predicted !== result.predicted || result.decision !== expectedDecision(result.predicted, result.probabilities, criterion.diagnostic_min_probability ?? 0.5)) fail(`Cannot resume: decision does not follow answer/probabilities for ${id} on ${row.id}`);
      if (result.primitive !== (criterion.primitive === 'true-or-false' ? 'noul' : 'choice') || result.method !== 'Decider2B shared endpoint' || !(result.confidence === null || Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1)) fail(`Cannot resume: malformed model result ${id} on ${row.id}`);
      if (!same(result.diagnostic_min_probability ?? 0.5, criterion.diagnostic_min_probability ?? 0.5)) fail(`Cannot resume: diagnostic rule changed for ${id} on ${row.id}`);
    }
    if (!Number.isFinite(result.elapsed_ms) || result.elapsed_ms < 0) fail(`Cannot resume: malformed criterion timing ${id} on ${row.id}`);
  }
}

function chunkCriterionChunkOptions(criterion) {
  return criterion.section_chunk_request.options.map(option => typeof option === 'string' ? option : option.name);
}

function validateEvidenceIfPresent(row, source, input, criteria, expected, resultRow = null) {
  const version = expected.requestEvidenceVersion ?? 0;
  if (version === 0) {
    if (row.request_evidence !== undefined) fail(`Cannot resume: request evidence marker missing for ${row.id}`);
    return;
  }
  if (version === 'mixed-legacy-v0+v1' && row.request_evidence === undefined) return;
  validateEvidence(row.request_evidence, source, input, criteria, expected, resultRow);
}

function validateErrorEvidenceIfPresent(row, source, input, criteria, expected) {
  const version = expected.requestEvidenceVersion ?? 0;
  if (version === 0) {
    if (row.request_evidence !== undefined) fail(`Cannot resume: request evidence marker missing for error ${row.id}`);
    return;
  }
  if (version === 'mixed-legacy-v0+v1' && row.request_evidence === undefined) return;
  validateEvidence(row.request_evidence, source, input, criteria, expected, null);
}

function validateEvidence(evidence, item, input, criteria, expected, resultRow) {
  if (!isRecord(evidence) || !isRecord(evidence.adapter_input) || !Array.isArray(evidence.exchanges)) fail(`Cannot resume: missing request evidence for ${item.id}`);
  const plan = requestPlan(input, item, criteria);
  if (!same(evidence.adapter_input, plan)) fail(`Cannot resume: changed request state/question/context for ${item.id}`);
  const wireSpecs = [
    ...(Object.keys(plan.asking).length ? [{chunk_index:null,content:plan.content,asking:plan.asking}] : []),
    ...(plan.chunk_requests ?? []).map(chunk => ({chunk_index:chunk.chunk_index,content:chunk.content,asking:chunk.asking})),
  ];
  const expectedWires = wireSpecs.map(request => {
    const wire = intoBatchRequest({content:request.content,asking:request.asking}); wire.model = expected.model; return wire;
  });
  if (expectedWires.length && !evidence.exchanges.length && resultRow) fail(`Cannot resume: no model exchange for completed request ${item.id}`);
  if (!expectedWires.length && evidence.exchanges.length) fail(`Cannot resume: unexpected model exchange for deterministic-only item ${item.id}`);
  let successfulBodies = [];
  const chunkBodies = new Map();
  for (const exchange of evidence.exchanges) {
    if (!isRecord(exchange) || exchange.url !== expected.endpoint || typeof exchange.request !== 'string' || !(Number.isInteger(exchange.status) || exchange.status === null)) fail(`Cannot resume: malformed exchange evidence for ${item.id}`);
    if (exchange.status === null ? typeof exchange.transport_error !== 'string' || exchange.response !== null : typeof exchange.response !== 'string') fail(`Cannot resume: incomplete raw exchange for ${item.id}`);
    let wire;
    try { wire = JSON.parse(exchange.request); } catch { fail(`Cannot resume: invalid captured request JSON for ${item.id}`); }
    const wireIndex = expectedWires.findIndex(candidate => same(wire, candidate));
    if (wireIndex < 0) fail(`Cannot resume: request payload changed for ${item.id}`);
    if (exchange.status != null && exchange.status >= 200 && exchange.status < 300) {
      let body;
      try { body = JSON.parse(exchange.response); }
      catch {
        if (resultRow) fail(`Cannot resume: invalid raw response JSON for ${item.id}`);
        continue;
      }
      if (!isRecord(body) || !isRecord(body.answers)) {
        if (resultRow) fail(`Cannot resume: missing raw answers for ${item.id}`);
        continue;
      }
      if (body.usage != null && (!isRecord(body.usage) || Object.entries(body.usage).some(([key, value]) => key.endsWith('_tokens') && (!Number.isInteger(value) || value < 0)))) {
        if (resultRow) fail(`Cannot resume: malformed raw usage for ${item.id}`);
        continue;
      }
      successfulBodies.push(body);
      if (wireIndex >= 0 && wireSpecs[wireIndex].chunk_index !== null) {
        const index = wireSpecs[wireIndex].chunk_index;
        if (!chunkBodies.has(index)) chunkBodies.set(index, []);
        chunkBodies.get(index).push(body);
      }
    }
  }
  if (resultRow && expectedWires.length) {
    if (!successfulBodies.length) fail(`Cannot resume: completed request has no successful raw response for ${item.id}`);
    for (const body of successfulBodies) if (body.model !== expected.model) fail(`Cannot resume: response model identity changed for ${item.id}`);
    if (expected.servingIdentityPolicy === SERVING_IDENTITY_POLICY) {
      for (const body of successfulBodies) if (!validServingIdentity(body.served_identity) || body.served_identity !== expected.serving) fail(`Cannot resume: response serving identity changed or is missing for ${item.id}`);
    }
    const ordinaryBodies = successfulBodies.filter(body => Object.keys(body.answers ?? {}).some(id => id !== SECTION_FIT_ID)
      || !plan.chunk_requests?.length);
    const decoded = plan.asking && Object.keys(plan.asking).length
      ? outOfBatchReply(ordinaryBodies.at(-1), plan.asking) : {};
    if (!criteria) {
      const answer = decoded.verdict;
      const probabilities = Object.fromEntries(answer?.distribution?.map(({option, probability}) => [String(option), probability]) ?? []);
      if (!answer || resultRow.predicted !== answer.answer || !same(resultRow.probabilities, probabilities) || !(resultRow.confidence === null && answer.confidence === null || close(resultRow.confidence, answer.confidence))) fail(`Cannot resume: saved overall decision differs from raw response for ${item.id}`);
    } else if (criteria) {
      const expectedIds = Object.keys(plan.asking);
      if (!same(Object.keys(decoded).sort(), [...expectedIds].sort())) fail(`Cannot resume: raw response omitted or added criteria for ${item.id}`);
      for (const [id, answer] of Object.entries(decoded)) {
        const saved = resultRow.checks?.[id];
        if (!answer || !saved) fail(`Cannot resume: raw response omitted ${id} on ${item.id}`);
        const binary = plan.asking[id].shape.kind === 'true-or-false';
        const predicted = binary ? (answer.answer ? 'pass' : 'fail') : answer.answer;
        const probabilities = Object.fromEntries(answer.distribution.map(({option, probability}) => [binary ? option === true ? 'pass' : 'fail' : String(option), probability]));
        const allowed = binary ? ['pass', 'fail'] : plan.asking[id].shape.options.map(option => typeof option === 'string' ? option : option.name);
        validDistribution(probabilities, allowed, `${item.id}/${id} raw response`);
        const confidenceMatches = saved.confidence === null && answer.confidence === null || close(saved.confidence, answer.confidence);
        if (saved.predicted !== predicted || !same(saved.probabilities, probabilities) || !confidenceMatches) fail(`Cannot resume: saved decision differs from raw response for ${id} on ${item.id}`);
      }
    }
    if (plan.chunk_requests?.length) {
      const saved = resultRow.checks?.[SECTION_FIT_ID]?.section_chunk_aggregate;
      if (!isRecord(saved) || !Array.isArray(saved.chunk_results)
          || saved.chunk_results.length !== plan.chunk_requests.length
          || chunkBodies.size !== plan.chunk_requests.length) fail(`Cannot resume: section chunk response coverage is incomplete for ${item.id}`);
      const labels = [];
      for (const chunk of plan.chunk_requests) {
        const bodies = chunkBodies.get(chunk.chunk_index);
        if (!bodies?.length) fail(`Cannot resume: missing section chunk response ${chunk.chunk_index} for ${item.id}`);
        const answers = outOfBatchReply(bodies.at(-1), chunk.asking);
        const answer = answers[SECTION_FIT_ID];
        const result = saved.chunk_results[chunk.chunk_index];
        const probabilities = Object.fromEntries(answer?.distribution?.map(({option, probability}) => [String(option), probability]) ?? []);
        validDistribution(probabilities, chunk.asking[SECTION_FIT_ID].shape.options, `${item.id}/${chunk.chunk_index}`);
        const decision = expectedDecision(answer.answer, probabilities, resultRow.checks[SECTION_FIT_ID].diagnostic_min_probability ?? 0.5);
        if (!answer || result?.chunk_index !== chunk.chunk_index || result.predicted !== answer.answer
            || result.decision !== decision || !same(result.probabilities, probabilities)
            || !(result.confidence === null && answer.confidence === null || close(result.confidence, answer.confidence))) {
          fail(`Cannot resume: section chunk result differs from raw response ${chunk.chunk_index} for ${item.id}`);
        }
        labels.push({predicted:answer.answer, decision});
      }
      const aggregate = labels.some(value => value.predicted === 'fail' && value.decision === 'fail') ? 'fail'
        : labels.every(value => value.predicted === 'pass' && value.decision === 'pass') ? 'pass' : 'uncertain';
      if (saved.label !== aggregate || resultRow.checks[SECTION_FIT_ID].predicted !== aggregate
          || resultRow.checks[SECTION_FIT_ID].decision !== aggregate) fail(`Cannot resume: section chunk aggregate is invalid for ${item.id}`);
    }
  }
}

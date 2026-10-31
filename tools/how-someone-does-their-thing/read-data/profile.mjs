// tools/how-someone-does-their-thing/read-data/profile.mjs
//
// A profile is one addressed record of how a subject does their thing (a creator's style, a person's voice, any
// reference pattern). The same record serves two jobs: it conditions the drafts made for the subject, and it is what
// a draft is checked against. This file holds the rules for both and for building the record. Invariants:
//   - It asks no model. The caller's AI derives the profile items; this file briefs it and then judges its answer.
//   - A profile keeps references (features, evaluators, generators, validation policy) as refs, never as prose.
//   - It names no subject, field or trait. Every ref and item is the caller's.
//   - It refuses what it cannot judge and says what to fix.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

export const REF_LISTS = ['feature_schema_refs', 'evaluator_refs', 'generator_refs'];

function need(condition, message) {
  if (!condition) throw new Error(message);
}

function refList(request, field) {
  const list = request[field];
  if (list === undefined) return [];
  need(Array.isArray(list) && list.every((ref) => text(ref)), `${field} must be a list of refs, each a non-empty string`);
  return list.map(text);
}

function subjectOf(request) {
  need(isObject(request), 'give a request object');
  need(text(request.profile_ref), 'profile_ref is required: the name of the profile record');
  need(text(request.subject_ref), 'subject_ref is required: whose way of doing the thing this profile holds');
  return { profile_ref: text(request.profile_ref), subject_ref: text(request.subject_ref) };
}

/** What the caller's AI needs to derive profile items from the subject's own records. */
export function briefProfile(request) {
  const { profile_ref, subject_ref } = subjectOf(request);
  const records = request.subject_records;
  need(Array.isArray(records) && records.length > 0, 'subject_records must hold at least one record of the subject: a profile is derived only from what the subject made or said');
  need(records.every(isObject), 'each subject record must be an object');
  const rules = [
    'Use only the supplied subject records.',
    'Derive self-describing items about how the subject does their thing that can condition future drafts and check their fit.',
    'Keep feature, evaluator, generator and validation references as refs, not prose.',
    'Answer with items, a list of objects; an empty list is refused.',
  ];
  if (text(request.instruction)) rules.push(text(request.instruction));
  return {
    profile_ref,
    subject_ref,
    subject_records: records,
    rules,
    answer_shape: { items: [{ kind: 'string: what kind of fact this is', value: 'the fact itself', evidence: 'which subject record shows it' }] },
  };
}

export const POLICY_FIELDS = ['gate_target_ref', 'gate_spec_ref'];

// The validation policy is one ref, or the pair of refs that names the gate and the spec the gate judges by.
function policyRef(value) {
  if (typeof value === 'string') {
    need(text(value), 'validation_policy_ref must be a non-empty string or an object with gate_target_ref and gate_spec_ref');
    return text(value);
  }
  need(isObject(value) && POLICY_FIELDS.every((field) => text(value[field])) && Object.keys(value).length === POLICY_FIELDS.length,
    'validation_policy_ref must be a non-empty string or an object with gate_target_ref and gate_spec_ref, each a non-empty string');
  return Object.fromEntries(POLICY_FIELDS.map((field) => [field, text(value[field])]));
}

// The brief asks for items shaped like its answer_shape, so a kept item must show what it is, say it and name its evidence.
function checkItem(item, index) {
  need(text(item.kind), `derived_items[${index}].kind must be a non-empty string: what kind of fact this is`);
  const hasValue = typeof item.value === 'string' ? text(item.value) : item.value !== undefined && item.value !== null;
  need(hasValue, `derived_items[${index}].value is required: the fact itself`);
  need(text(item.evidence), `derived_items[${index}].evidence must be a non-empty string: which subject record shows it`);
}

/** The profile record, kept only if the AI's items and the refs hold up. */
export function keepProfile(request) {
  const { profile_ref, subject_ref } = subjectOf(request);
  const items = request.derived_items;
  need(Array.isArray(items) && items.length > 0 && items.every(isObject), 'derived_items must be a non-empty list of objects: a profile with nothing derived conditions nothing');
  items.forEach(checkItem);
  const profile = { type: 'profile', id: profile_ref, subject_ref };
  for (const field of REF_LISTS) profile[field] = refList(request, field);
  if (request.validation_policy_ref !== undefined) profile.validation_policy_ref = policyRef(request.validation_policy_ref);
  profile.derived_items = items;
  return profile;
}

/** Does a draft carry the references that show it was made from, and is checked against, the profile? */
export function checkDraft(request) {
  need(isObject(request), 'give a request object');
  const fields = request.required_ref_fields;
  need(Array.isArray(fields) && fields.length > 0 && fields.every((field) => text(field)), 'required_ref_fields must name the draft fields that must carry a profile reference, such as the one that conditioned it and the one it is validated by');
  const blocks = request.draft?.blocks;
  need(Array.isArray(blocks) && blocks.every(isObject), 'draft.blocks must be a list of objects');
  const expected = text(request.profile_ref);
  const rules = fields.map((field) => {
    const found = blocks.map((block) => block[field]).filter((value) => text(value));
    if (found.length === 0) return { field, passed: false, reason: `no block of the draft carries ${field}` };
    if (expected && !found.some((value) => text(value) === expected)) return { field, passed: false, reason: `${field} names another profile than ${expected}` };
    return { field, passed: true, reason: '' };
  });
  return { fits: rules.every((rule) => rule.passed), rules };
}

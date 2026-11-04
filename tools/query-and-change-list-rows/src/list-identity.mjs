// src/list-identity.mjs
//
// Purpose: the form two spellings of the same thing share. "Ana@Example.com " and "ana@example.com" are one email;
// "+1 (415) 555-0100" and "+14155550100" are one phone; "https://www.acme.com/about" and "acme.com" are one company
// domain. A field's kind row (src/lists.json field_kinds `normalize`) names the normalizer, or the field names its own,
// and the list keeps the raw spelling the person typed; this file only works out the shared form for matching.
//
// Non-Negotiable Invariants:
//   1. Normalizers are DATA (src/lists.json `normalizers`: ordered steps trim, lowercase, replace, registrable_root); a new one is a row.
//   2. The raw value is never rewritten here; a normalized form is for comparison only.
//   3. A value with no normalizer is compared by its text trimmed and case-folded ("words"), so matching on a name works.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const TWO_LABEL = new Set(data.domain_suffixes.two_label);
const NUMBERS = /^[0-9.]+$/u;
// The registrable part of a host: its last two labels, or three under a two-label suffix; an address of numbers stays whole.
const registrableRoot = host => {
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2 || NUMBERS.test(host)) return labels.join('.');
  return labels.slice(TWO_LABEL.has(labels.slice(-2).join('.')) ? -3 : -2).join('.');
};
const steps = new Map(Object.entries(data.normalizers).filter(([name]) => !name.startsWith('_')).map(([name, list]) => [name, list.map(step => step.op === 'replace'
  ? { op: 'replace', pattern: new RegExp(step.pattern, 'gu'), with: step.with }
  : { op: step.op })]));
const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));

export const normalizerNames = [...steps.keys()];
const fallback = 'words';

/** The normalizer a field uses: its own `normalize`, else its kind row's, else plain words. */
export const normalizerOf = field => {
  const named = typeof field?.normalize === 'string' ? field.normalize : KINDS.get(field?.kind)?.normalize;
  return steps.has(named) ? named : fallback;
};

/** The shared form of one text under a normalizer. */
export function normalizedForm(value, normalizer) {
  const list = steps.get(normalizer) ?? steps.get(fallback);
  let text = String(value ?? '');
  for (const step of list) {
    if (step.op === 'trim') text = text.trim();
    else if (step.op === 'lowercase') text = text.toLocaleLowerCase();
    else if (step.op === 'registrable_root') text = registrableRoot(text);
    else if (step.op === 'replace') text = text.replace(step.pattern, step.with);
  }
  return text;
}

/** The shared forms a field value holds: one for a text, one per item for a list of texts; empty ones are left out. */
export const normalizedKeys = (value, normalizer) => (Array.isArray(value) ? value : [value])
  .filter(item => typeof item === 'string').map(item => normalizedForm(item, normalizer)).filter(Boolean);

/** Whether a field's values can be matched by their shared form (text-like values, not a link, formula or rule). */
export const matchable = field => {
  const kind = KINDS.get(field?.kind);
  return Boolean(kind) && (kind.value === 'text' || kind.value === 'texts') && !kind.carries;
};

// ---- the shared form as a field of a saved view ---------------------------------------------------------------------
// A view may name `<field><keys.key_suffix>` (`website~key`) wherever it names a field: the field's values in their shared
// form, worked out when the view is read and never kept, so "the same company by its domain" is one rule.
const suffix = data.keys.key_suffix;

/** The shared-form fields a list's views may name: { id, label, kind, of } for each field whose values can be matched. */
export const keyFieldsOf = fields => fields.filter(matchable).map(field => ({ id: `${field.id}${suffix}`, label: `${field.label} (shared form)`, kind: KINDS.get(field.kind)?.value === 'texts' ? 'tags' : 'text', of: field }));

/** Rows with the shared form of each named key field put in their values (copies; the rows given are not changed). */
export const withKeyValues = (rows, keyFields) => (keyFields.length ? rows.map(row => {
  const values = { ...row.values };
  for (const key of keyFields) {
    const forms = normalizedKeys(row.values?.[key.of.id], normalizerOf(key.of));
    if (forms.length) values[key.id] = key.kind === 'tags' ? forms : forms[0];
  }
  return { ...row, values };
}) : rows);

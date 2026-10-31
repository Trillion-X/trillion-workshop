// tools/paid-access/read-data/addressed-scope.mjs
//
// The scope a gated value is opened under: `{ schema, value_ref, instance_ref, required_access_refs }`. Ported from
// bitfield-packages packages/product-access (do-work/authorize-addressed-expiring-value-scope.ts: the schema, the
// bounds and the strict decode). `value_ref` is opaque, so the same check serves a page, a file, a selected
// publication or anything else with a name. The package also decoded byte arrays and base64 for its hosted carrier
// and took a session and an operation from the carrier; this folder takes the scope as the object (or its JSON text)
// and the buyer as `subject`.
export const ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA = 'addressed-expiring-value-scope/v1';

const MAX_SCOPE_BYTES = 4 * 1_024;
const MAX_VALUE_REF_BYTES = 4 * 1_024;
const MAX_ACCESS_REF_BYTES = 1 * 1_024;
const MAX_REQUIRED_ACCESS_REFS = 128;
const SCOPE_FIELDS = new Set(['schema', 'value_ref', 'instance_ref', 'required_access_refs']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => new TextEncoder().encode(value).byteLength;

function boundedText(value, maximumBytes) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && bytes(normalized) <= maximumBytes ? normalized : '';
}

function requiredRefs(value) {
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_ACCESS_REFS) return null;
  const refs = new Set();
  for (const raw of value) {
    const ref = boundedText(raw, MAX_ACCESS_REF_BYTES);
    if (!ref) return null;
    refs.add(ref);
  }
  return [...refs];
}

/** The scope, or null for anything that is not exactly the schema (an unknown field, a bad bound, a wrong type). */
export function decodeAddressedExpiringValueScope(value) {
  let source = value;
  if (typeof value === 'string') {
    if (bytes(value) > MAX_SCOPE_BYTES) return null;
    try { source = JSON.parse(value); } catch { return null; }
  } else if (object(value) && bytes(JSON.stringify(value)) > MAX_SCOPE_BYTES) return null;
  if (!object(source) || !Object.keys(source).every(key => SCOPE_FIELDS.has(key))) return null;
  if (source.schema !== ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA) return null;
  const valueRef = boundedText(source.value_ref, MAX_VALUE_REF_BYTES);
  const instanceRef = boundedText(source.instance_ref, MAX_VALUE_REF_BYTES);
  const refs = requiredRefs(source.required_access_refs);
  if (!valueRef || !instanceRef || refs === null) return null;
  return { schema: ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA, value_ref: valueRef, instance_ref: instanceRef, required_access_refs: refs };
}

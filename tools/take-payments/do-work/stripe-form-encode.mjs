// tools/take-payments/do-work/stripe-form-encode.mjs
//
// Stripe wire-format encoder. The Stripe REST API consumes
// `application/x-www-form-urlencoded` bodies with BRACKET NOTATION for nested
// objects and arrays — NOT JSON. A request body of
//   { line_items: [ { price: "price_x", quantity: 1 } ], metadata: { plan: "founding" } }
// must go on the wire as
//   line_items[0][price]=price_x&line_items[0][quantity]=1&metadata[plan]=founding
//
// This is pure Stripe domain knowledge (L098: this package translates to Stripe's
// wire format; the transport stays blind to it). Pure function, zero
// I/O, zero secrets — fully provable with no key.
//
// Encoding rules (match Stripe's documented form semantics):
//   - scalar (string/number/boolean) -> key=value (boolean -> "true"/"false")
//   - nested object                  -> parent[child]=value (recursive)
//   - array                          -> key[0]=...&key[1]=... (indexed; arrays of
//                                       objects nest: key[0][field]=...)
//   - null / undefined               -> omitted entirely (Stripe treats absent as unset)
//   - empty string                   -> key= (kept; meaningful "clear this field")
// Keys/values are percent-encoded via encodeURIComponent, with spaces as %20
// (application/x-www-form-urlencoded form bytes; Stripe accepts %20).

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function* pairs(prefix, value) {
  if (value === null || value === undefined) return; // omit unset
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      yield* pairs(`${prefix}[${i}]`, value[i]);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      yield* pairs(prefix ? `${prefix}[${key}]` : key, entry);
    }
    return;
  }
  const scalar = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  yield [prefix, scalar];
}

function encodeComponent(component) {
  return encodeURIComponent(component);
}

/**
 * Encode a JS value as a Stripe-compatible x-www-form-urlencoded string.
 * @param {Record<string, unknown>} body
 * @returns {string}
 */
export function encodeStripeForm(body) {
  if (body === null || body === undefined) return '';
  if (!isPlainObject(body)) {
    throw new Error('encodeStripeForm expects a plain object body');
  }
  const parts = [];
  for (const [key, value] of pairs('', body)) {
    parts.push(`${encodeComponent(key)}=${encodeComponent(value)}`);
  }
  return parts.join('&');
}

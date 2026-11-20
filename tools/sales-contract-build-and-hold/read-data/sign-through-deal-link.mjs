// Signing a shared deal from its link: whether the page shows the signatures already made, the signing form, or nothing
// (the buyer must first prove their address), and the typed name's rule. Port of ABILITY_SECTIONS.sign and the sign
// route in the old share page owner (tools/write-public-share-files/from-an-older-version/src/record-share-pages.mjs).
// Storage-free: the caller passes the link's access facts and the buyer it signs for.
import data from './sign-through-deal-link.json' with { type: 'json' };

/**
 * signedByYou: this buyer has signed; signatures: the signatures on the link; proven: the buyer proved their address.
 * → { kind: 'signed', signatures } | { kind: 'form', field } | { kind: 'none' }.
 */
export function signSection({ signedByYou, signatures, proven }) {
  if (signedByYou || (signatures.length && !proven)) return { kind: 'signed', signatures };
  if (!proven) return { kind: 'none' };
  return { kind: 'form', field: data.name_field };
}

/** The buyer who signs: the buyer the link delivers on signing, else none (the seller's own record is not signed for). */
export function signerOf({ deliversOnSign, buyer }) {
  return deliversOnSign ? buyer : null;
}

/** → { ok: true } or { ok: false, problem, message } for a typed name, by the form field's rule. */
export function checkSignName(name) {
  const { min_length: min, max_length: max } = data.name_field;
  const value = typeof name === 'string' ? name : '';
  const problem = value.length === 0 ? 'required' : value.length < min ? 'too_short' : value.length > max ? 'too_long' : null;
  return problem ? { ok: false, problem, message: data.problems[problem] } : { ok: true };
}

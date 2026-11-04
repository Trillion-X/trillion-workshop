// Canonical display/wire identity helpers shared by addressed Visual Database
// readers and writers. Address labels are stored verbatim by the engine; this
// module intentionally has no runtime dependency on the workspace record owner.

/** Canonicalize both public spellings of a fact address. The display form and
 * the wire form name the same fact; both MUST reach the encoded writer path or
 * a field edit becomes a second fact. */
export function canonicalFactAddress(value: string): string | null {
  const trimmed = value.trim();
  const wire = /^1f20([0-9a-f]{64})$/i.exec(trimmed);
  if (wire) return `1f20${wire[1].toLowerCase()}`;
  const display = /^1f:([0-9a-f]{64})$/i.exec(trimmed);
  return display ? `1f20${display[1].toLowerCase()}` : null;
}

/** A label address is its original text. Keeping this tiny identity function
 * local avoids pulling the workspace record transport into shared readers. */
export function makeIdentityTextAddressFromLabel(label: string): string {
  if (typeof label !== 'string' || !label) throw new TypeError('An address needs a label.');
  return label;
}

/** One normalized identity for create/readback matching: projected facts use
 * their wire multihash spelling, while label addresses remain unchanged. */
export function canonicalRecordIdentity(value: string): string {
  return canonicalFactAddress(value) ?? makeIdentityTextAddressFromLabel(value.trim());
}

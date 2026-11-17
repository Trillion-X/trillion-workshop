// tools/better-auth-official/test-fixtures/root-signature-verify.mjs
//
// A reference check of the signature object /approve returns (the same checks the engine's verifier makes, which the engine's
// own code does): the document's fingerprint, the challenge that statement makes, then WebAuthn Level 3 section 7.2 over the
// assertion with the COSE key the signer names (ES256 or EdDSA).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonical, challengeOf, fingerprintOf, fromBase64url, base64url } from '../pages/approve-client.mjs';

// The one COSE key shape ES256 passkeys have: a CBOR map of small integers to integers and byte strings.
function coseKey(bytes) {
  let at = 0;
  const head = () => { const first = bytes[at++], major = first >> 5, low = first & 31; return { major, value: low < 24 ? low : bytes[at++] }; };
  const item = () => {
    const { major, value } = head();
    if (major === 0) return value;
    if (major === 1) return -1 - value;
    if (major === 2) { at += value; return bytes.slice(at - value, at); }
    if (major === 5) { const map = new Map(); for (let n = 0; n < value; n++) map.set(item(), item()); return map; }
    throw new Error('a COSE key holds only integers, byte strings and a map');
  };
  return item();
}

/** Throws when `signature` is not a valid passkey signature of `root` for this RP ID and origin; returns the signature otherwise. */
export function verifyRootSignature(signature, root, { rpId, origin }) {
  const { fingerprint, previous, signed_at, signer, assertion } = signature;
  if (fingerprintOf(root) !== fingerprint) throw new Error('the fingerprint is not the root\'s');
  if (signer.issuer !== origin) throw new Error('the signer\'s issuer is not the origin');
  const clientDataJSON = fromBase64url(assertion.clientDataJSON);
  const client = JSON.parse(new TextDecoder().decode(clientDataJSON));
  if (client.type !== 'webauthn.get') throw new Error('not an authentication assertion');
  if (client.origin !== origin) throw new Error('the assertion was made for another origin');
  if (client.challenge !== base64url(challengeOf({ fingerprint, previous, signed_at }))) throw new Error('the challenge is not this root\'s statement');
  const authenticatorData = fromBase64url(assertion.authenticatorData);
  if (!Buffer.from(authenticatorData.slice(0, 32)).equals(createHash('sha256').update(rpId).digest())) throw new Error('the RP ID hash is not the expected one');
  if (!(authenticatorData[32] & 0x01) || !(authenticatorData[32] & 0x04)) throw new Error('the person was not present and verified');
  const key = coseKey(fromBase64url(signer.public_key_cose));
  const signed = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]);
  const sig = fromBase64url(assertion.signature);
  // COSE algorithm -7 is ES256 (a P-256 key, a DER signature over SHA-256) and -8 is EdDSA (an Ed25519 key), the two the passkey plugin offers.
  const ok = key.get(3) === -7
    ? verify('sha256', signed, { key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: base64url(key.get(-2)), y: base64url(key.get(-3)) }, format: 'jwk' }), dsaEncoding: 'der' }, sig)
    : key.get(3) === -8 && verify(null, signed, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64url(key.get(-2)) }, format: 'jwk' }), sig);
  if (!ok) throw new Error('the signature does not verify');
  return signature;
}

export { canonical };

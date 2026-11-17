// tools/better-auth-official/pages/approve-client.mjs
//
// What /approve does with a root declaration (the one record that says which computers and AIs are a person's): its
// fingerprint, the plain words for what a change does, and the person's passkey signature over it. The signature is a WebAuthn
// assertion (https://www.w3.org/TR/webauthn-3/ sections 5.5 and 7.2) whose challenge is the BLAKE3 of the canonical statement
// {fingerprint, previous, signed_at}, never the bare fingerprint: section 13.4.3 asks for challenges that cannot be replayed, and
// a statement carrying `previous` and `signed_at` cannot be, because a signature for one chain position is not one for another.
// The browser's credentials container is passed in, so a test can hold the authenticator.
import { blake3 } from '@noble/hashes/blake3.js';

const text = new TextEncoder();

/** The canonical text of a JSON value: keys sorted at every depth, no whitespace, numbers as JSON.stringify prints them. */
export function canonical(value) {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('a root holds only JSON values');
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export const fromBase64url = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));

/** The fingerprint of a root: the lowercase hex of the BLAKE3 of its canonical bytes. */
export const fingerprintOf = root => hex(blake3(text.encode(canonical(root))));

/** The 32 bytes a passkey signs for one position in the chain of roots. */
export const challengeOf = ({ fingerprint, previous, signed_at }) => blake3(text.encode(canonical({ fingerprint, previous, signed_at })));

/** The first root: the place the person signed in, and the sign-in that vouches for them. */
export const firstRoot = ({ host, issuer }) => ({ kind: 'root', version: 1, doors: [{ kind: 'door', host }], issuers: [{ kind: 'issuer', issuer }] });

/**
 * The person's passkey signature over `root`, as the signature object roots are kept with. `passkeys` are the person's
 * passkey records as Better Auth lists them (credentialID base64url, publicKey base64 of the COSE key); `rpId` is the one the
 * passkeys were made for.
 */
export async function signRoot({ root, previous, issuer, sub, rpId, passkeys, credentials, now = Date.now() }) {
  const fingerprint = fingerprintOf(root);
  const signed_at = now;
  const assertion = await credentials.get({
    publicKey: {
      challenge: challengeOf({ fingerprint, previous, signed_at }),
      rpId,
      allowCredentials: passkeys.map(({ credentialID }) => ({ type: 'public-key', id: fromBase64url(credentialID) })),
      userVerification: 'required',
      timeout: 120000,
    },
  });
  const credentialId = base64url(assertion.rawId);
  const used = passkeys.find(({ credentialID }) => credentialID === credentialId);
  if (!used) throw new Error('the passkey that signed is not one of the person\'s');
  const { authenticatorData, clientDataJSON, signature } = assertion.response;
  return {
    fingerprint,
    previous,
    signed_at,
    signer: { issuer, sub, credential_id: credentialId, public_key_cose: base64url(Uint8Array.from(atob(used.publicKey), char => char.charCodeAt(0))) },
    assertion: { authenticatorData: base64url(authenticatorData), clientDataJSON: base64url(clientDataJSON), signature: base64url(signature) },
  };
}

// The plain words for a change. Every top-level array of a root holds rows; a row is named by the first of `summaryFields`
// it has and its kind by the words DATA gives (the kind itself when it gives none), so no kind of row is named here.
const summary = (row, summaryFields) => String(row[summaryFields.find(field => row[field] !== undefined)] ?? canonical(row));
const rowsOf = root => Object.values(root ?? {}).filter(Array.isArray).flat().filter(row => row && typeof row === 'object');

/** The rows a change adds and removes, as { verb, kind, name } with the words DATA gives for each kind. */
export function changeOf(previousRoot, nextRoot, { kinds, summaryFields }) {
  const key = row => canonical(row);
  const before = new Map(rowsOf(previousRoot).map(row => [key(row), row]));
  const after = new Map(rowsOf(nextRoot).map(row => [key(row), row]));
  const line = (verb, row) => ({ verb, kind: kinds[row.kind] ?? row.kind ?? 'something', name: summary(row, summaryFields) });
  return [
    ...[...after].filter(([id]) => !before.has(id)).map(([, row]) => line('adds', row)),
    ...[...before].filter(([id]) => !after.has(id)).map(([, row]) => line('removes', row)),
  ];
}

// tools/service-actor-origins/do-work/service-actor-checks.mjs
//
// Purpose
//   The pure checks of a service actor: whether a sign-in is a service principal (its reserved prefix), which origin and
//   scope it names, which gates its scope kind opens, whether a mint's origin and scope are allowed, and whether a claims
//   object is one the account's policy owner minted (its keyed proof checks). Ported from src/service-actor.mjs at
//   4ffa1dc4a2^ (the old repository, retired by 4ffa1dc4a2 on Nov 3 2026), layer one. Nothing here makes a key or mints an actor:
//   the caller passes the rows (src/service-actor-origins.json) and, for the proof check, the key the policy owner holds.
//
// Non-negotiable invariants
//   1. A sign-in is a service principal only by its reserved prefix (rows.reserved_prefixes); no other kind of sign-in is
//      read as one, and a forged prefix is not minted here.
//   2. A gate opens for a service principal only what its scope kind's row names, for its own scope id where the row binds one.
//   3. The proof is checked in constant time over exactly the fields the policy owner signed; a request header, a claims
//      object with no proof, or a changed field never stands.

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const MINTED = 'service:';
const encoder = new TextEncoder();

/** The rows indexed the way the checks read them. */
export function indexRows(rows) {
  const origins = new Map(rows.origins.map(row => [row.id, row]));
  const kinds = new Map(rows.scope_kinds.map(row => [row.id, {
    ...row,
    gates: new Map(row.gates.filter(gate => gate.resource).map(gate => [gate.resource, gate])),
    prefixed: row.gates.filter(gate => gate.resource_prefix),
    scoped: row.gates.find(gate => gate.resource_is_scope) ?? null,
  }]));
  return { reserved: rows.reserved_prefixes, origins, kinds };
}

/** Whether a sign-in is a service principal: one whose reserved prefix the rows name. */
export const isServiceSignIn = (index, signIn) => typeof signIn === 'string' && index.reserved.some(prefix => signIn.startsWith(prefix));

/** The origin a service principal's claims name, or null. */
export const serviceOriginOfClaims = claims => (typeof claims?.sign_in === 'string' && claims.sign_in.startsWith(MINTED) ? claims.sign_in.slice(MINTED.length) : null);

/** Whether a scope kind's actor is kept by its policy owner (the same claims until minted again). */
export const serviceScopeKept = (index, kind) => index.kinds.get(kind)?.kept === true;

/** Whether some scope kind names this gate: the only gates a service principal is ever initialized at. */
export const serviceGateKnown = (index, resource) => [...index.kinds.values()].some(kind => [...kind.gates.values()].some(gate =>
  gate.resource === resource || (gate.resource_prefix && typeof resource === 'string' && resource.startsWith(gate.resource_prefix))
  || (gate.resource_is_scope && typeof resource === 'string' && new RegExp(kind.id_pattern).test(resource))));

/** The gate row a service principal's scope kind names for a resource, or null when its kind opens no such gate. */
export const serviceGateOf = (index, claims, resource) => {
  const kind = index.kinds.get(claims?.service_scope?.kind);
  if (!kind) return null;
  return kind.gates.get(resource)
    ?? (typeof resource === 'string' ? kind.prefixed.find(gate => resource.startsWith(gate.resource_prefix)) : null)
    ?? (kind.scoped && claims.service_scope.id === resource && new RegExp(kind.id_pattern).test(resource) ? kind.scoped : null);
};

/** Who pays for the work a service actor does at a gate: the gate row's paid_by, or null for the account's own plan. */
export const serviceWorkPayer = (index, claims, resource) =>
  (isServiceSignIn(index, claims?.sign_in) ? serviceGateOf(index, claims, resource)?.paid_by ?? null : null);

/**
 * The scope a mint may name, checked: the origin must exist, the scope kind must be one its origin row names, and the scope
 * id must be the account (for an account-bound kind) or match the kind's id pattern. Throws with the status the old module used.
 */
export function checkedScope(index, origin, account, scope) {
  const refuse = (message, status) => Object.assign(new Error(message), { status });
  const row = index.origins.get(origin);
  if (!row) throw refuse(`No internal caller ${origin} may act for an account; add it to src/service-actor-origins.json.`, 403);
  const kind = index.kinds.get(scope?.kind);
  if (!kind || !row.scopes.includes(kind.id)) throw refuse(`The internal caller ${origin} may not act on a ${scope?.kind} scope.`, 403);
  if (typeof scope.id !== 'string' || (kind.id_is_account ? scope.id !== account : !new RegExp(kind.id_pattern).test(scope.id)))
    throw refuse(`A ${kind.id} scope names its one ${kind.id_is_account ? 'account' : kind.id}.`, 400);
  return { kind: kind.id, id: scope.id };
}

/** What the policy owner's proof is made over: the origin, the issued time, the scope and the reach, so no field can be widened. */
export const signedFields = (account, claims) => encoder.encode(JSON.stringify(['service-actor', account, serviceOriginOfClaims(claims),
  claims.issued_at, [claims.service_scope?.kind, claims.service_scope?.id], claims.made ?? null, claims.ceiling ?? null]));

/** The unkeyed digest of exactly what a proof was made over, so a later check stands only for the same signed fields. */
export const serviceSignedDigest = (account, claims) => bytesToHex(blake3(signedFields(account, claims)));

/**
 * Whether these claims are exactly ones this account's policy owner minted: the origin and scope check, and the keyed proof
 * over the signed fields, compared in constant time. `key` is the policy owner's key (hex), passed in by the caller.
 */
export function serviceClaimsMinted(index, key, account, claims) {
  const origin = serviceOriginOfClaims(claims);
  if (!key || !origin || claims.approved_by !== 'service' || typeof claims.issued_at !== 'string'
    || !/^[0-9a-f]{64}$/.test(String(claims.service_proof))) return false;
  try { checkedScope(index, origin, account, claims.service_scope); } catch { return false; }
  const expected = bytesToHex(blake3(signedFields(account, claims), { key: hexToBytes(key) }));
  let same = 0;
  for (let at = 0; at < expected.length; at++) same |= expected.charCodeAt(at) ^ claims.service_proof.charCodeAt(at);
  return same === 0;
}

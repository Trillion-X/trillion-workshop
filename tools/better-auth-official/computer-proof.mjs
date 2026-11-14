// A Trillion computer's proof, checked here byte for byte as trillion-rust src/account/computers.rs checks it (read_proof,
// verify_use, proof_bytes, ComputersRow::verify and signed_bytes, KeptAccount::believed, address_of): a proof is
// `trp_<computer id>_<part>_<at ms>_<signature>`, the computer's Ed25519 signature (its id is its public key, 64 hex) over
// the use's domain, the part and the time; each text with a 4-byte big-endian length in front, the time as 8 big-endian
// bytes. A computer is enrolled when the account's own computers row, signed by the account key the address names, lists
// it among the computers that keep a copy. The domains, contexts and window are settings.computer_proof (DATA, the same
// values as computers/settings.json).
import { createPublicKey, verify } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';

const HEX64 = /^[0-9a-f]{64}$/;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;
const encoder = new TextEncoder();

const text = value => { const bytes = encoder.encode(value); const out = Buffer.alloc(4 + bytes.length); out.writeUInt32BE(bytes.length); out.set(bytes, 4); return out; };
const list = values => Buffer.concat([(() => { const n = Buffer.alloc(4); n.writeUInt32BE(values.length); return n; })(), ...values.map(text)]);
const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };
const i64 = value => { const out = Buffer.alloc(8); out.writeBigInt64BE(BigInt(value)); return out; };
const sortedUnique = values => values.every((value, i) => i === 0 || values[i - 1] < value);
const ed25519 = (publicHex, bytes, signatureHex) => {
  if (!HEX64.test(publicHex) || !SIGNATURE_HEX.test(signatureHex)) return false;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicHex, 'hex').toString('base64url') }, format: 'jwk' });
  return verify(null, bytes, key, Buffer.from(signatureHex, 'hex'));
};

/** blake3 of a text, 64 hex: what a key-check proof binds. */
export const keyDigest = key => Buffer.from(blake3(encoder.encode(key))).toString('hex');

/** The account address an account public key names (blake3 derive_key under account_id_context). */
export const addressOf = (settings, publicHex) => HEX64.test(publicHex)
  ? Buffer.from(blake3(Buffer.from(publicHex, 'hex'), { context: encoder.encode(settings.account_id_context) })).toString('hex') : null;

/** The computer, part and time of a proof for `use` that checks at `now`; null for anything else. */
export function readProof(settings, use, proof, now) {
  const domain = settings.proof_uses?.[use];
  if (!domain || typeof proof !== 'string' || !proof.startsWith('trp_')) return null;
  const parts = proof.slice(4).split('_');
  if (parts.length !== 4) return null;
  const [computer, part, at, signature] = parts;
  if (!HEX64.test(computer) || !HEX64.test(part) || !/^\d{1,16}$/.test(at)) return null;
  const time = Number(at);
  if (now <= 0 || time <= 0 || Math.abs(now - time) > settings.window_ms) return null;
  return ed25519(computer, Buffer.concat([text(domain), text(part), i64(time)]), signature) ? { computer, part, at: time } : null;
}

/** Whether `kept` ({row, account_key}) is the account's own computers row, signed by the key its address names, and lists
 * `computer` among the computers that keep a copy. Returns the account address, or null. */
export function enrolledAccount(settings, kept, computer) {
  const row = kept?.row, key = kept?.account_key;
  if (!row || typeof key !== 'string' || row.pursuit != null) return null;
  const { account, revision, holders, answering, voters, signature } = row;
  const most = settings.most_admitted_computers;
  const ids = value => Array.isArray(value) && value.every(item => typeof item === 'string' && HEX64.test(item)) && sortedUnique(value);
  const shaped = typeof account === 'string' && HEX64.test(account) && Number.isSafeInteger(revision) && revision >= 1
    && ids(holders) && holders.length >= 1 && holders.length <= most && ids(answering) && answering.length <= holders.length
    && answering.every(id => holders.includes(id)) && ids(voters) && voters.length <= most;
  if (!shaped || addressOf(settings, key) !== account || !holders.includes(computer)) return null;
  const bytes = Buffer.concat([text(settings.signed_domain), text(account), text(''), u64(revision), list(holders), list(answering), list(voters)]);
  return ed25519(key, bytes, signature) ? account : null;
}

// parts/sealed-records/do-work/sealed-records.mjs
//
// PURPOSE
//   A record only the person's own devices can read. A device seals it with a key only its devices hold, and the copy
//   it settles with (the person's store, parts/record-log record-sync.mjs) keeps and passes on
//   { sealed: { v, key_id, nonce, ciphertext } } without ever being able to open it: zero-knowledge sync. The store
//   checks only the shape (isSealedValue), orders versions and keeps both sides of a conflict like any record; the
//   device opens it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The key never leaves a device: it is derived on the device from a passphrase the person keeps (argon2id, memory
//      hard, so a guessed passphrase costs real memory per guess), or made at random and moved between devices by the
//      person. Nothing here sends it anywhere.
//   2. AES-256-GCM through the platform's own WebCrypto (browser, Worker and node alike), a fresh 12-byte nonce per
//      seal, and the record's id as additional data, so a sealed value moved onto another record id fails to open.
//   3. key_id is the first 16 hex of the key's BLAKE3 identity: it says which key opens a value and reveals nothing of it.
//   4. A sealed value is exactly { sealed: { v: 1, key_id, nonce, ciphertext } } with base64 strings; anything more
//      (a plain field beside it) is not a sealed value, so plain text can never travel under the sealed kind.
//   5. Nothing here names a host, a device kind, a record kind other than its own, or a person.
//   6. A sealed NAME (sealName) is deterministic on purpose: AES-SIV under a key derived from the sealing key with its
//      own BLAKE3 derive-key context (sealed-records.json contexts.names), so the same name under the same key and scope
//      seals to the same text and a store can match, dedupe and compare-and-set it without reading it. It reveals only
//      equality, so it seals names and identities, never record bodies (those keep a fresh nonce, invariant 2).
//   7. A sealed link carries its own fresh key only in the link's fragment (#k=...), which no browser sends to a
//      server; the server keeps only the sealed copy and its content_id (1f: + BLAKE3 of the sealed value), so it can
//      compare-and-set a newer copy without being able to open any.
//   8. A sealed file is sealed with a fresh key of its own; the key travels only inside the record that names the file
//      (a file reference, itself sealed), so whoever can open that record can read the bytes, and nobody else.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { argon2id } from '@noble/hashes/argon2.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { aessiv } from '@noble/ciphers/aes.js';
import rules from './sealed-records.json' with { type: 'json' };

export const SEALED_TYPE = 'sealed';
/** The record id prefix of a sealed file reference; its sealed name follows (sealed-records.json). */
export const SEALED_FILE_PREFIX = rules.sealed_file_prefix;
const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
// OWASP's argon2id floor: 19 MiB, two passes, one lane.
const ARGON = { t: 2, m: 19456, p: 1, dkLen: 32 };
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const toBase64 = bytes => {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
};
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
const toBase64Url = bytes => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = text => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const keyIdOf = key => bytesToHex(blake3(key)).slice(0, 16);
const aesKey = (key, use) => crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [use]);

/** A 32-byte key from a passphrase and a salt the device keeps beside it: { key, key_id }. */
export function keyFromPassphrase(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('A passphrase of at least 8 characters seals your records.');
  const key = argon2id(encoder.encode(passphrase), typeof salt === 'string' ? encoder.encode(salt) : salt, ARGON);
  return { key, key_id: keyIdOf(key) };
}

/** A new random key: { key, key_id }. */
export function newSealingKey() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return { key, key_id: keyIdOf(key) };
}

/** Whether `value` is a sealed value and nothing more (invariant 4). */
export function isSealedValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  const sealed = value.sealed;
  if (!sealed || typeof sealed !== 'object' || Array.isArray(sealed)) return false;
  const keys = Object.keys(sealed).sort().join(',');
  return keys === 'ciphertext,key_id,nonce,v' && sealed.v === VERSION && /^[0-9a-f]{16}$/.test(sealed.key_id)
    && typeof sealed.nonce === 'string' && BASE64.test(sealed.nonce) && typeof sealed.ciphertext === 'string' && BASE64.test(sealed.ciphertext);
}

/** Seals one record ({ type, value }) kept under `id`: the value to keep as a record of SEALED_TYPE. */
export async function sealRecord({ key, key_id: keyId }, id, record) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify({ type: record.type, value: record.value }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(id) }, await aesKey(key, 'encrypt'), plain));
  return { sealed: { v: VERSION, key_id: keyId, nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) } };
}

/** Opens a sealed value kept under `id`: { type, value }. Throws, in plain words, for another key or a changed value. */
export async function openRecord({ key, key_id: keyId }, id, value) {
  if (!isSealedValue(value)) throw new Error('This is not a sealed record.');
  if (value.sealed.key_id !== keyId) throw new Error('This record was sealed with another key.');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(value.sealed.nonce), additionalData: encoder.encode(id) }, await aesKey(key, 'decrypt'), fromBase64(value.sealed.ciphertext));
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new Error('This sealed record was changed or moved, so it does not open.');
  }
}

// A key a sealing key yields for one use (sealed-records.json contexts), never the sealing key itself (invariant 6).
const derivedKey = (key, use) => {
  const row = rules.contexts[use];
  return blake3(key, { context: encoder.encode(row.context), dkLen: row.bytes });
};
const nameText = text => {
  if (typeof text !== 'string' || !text || text.length > rules.name_longest) throw new Error(`A sealed name is 1 to ${rules.name_longest} characters.`);
  return text;
};

/** Seals a name or identity the same way every time under one key and `scope` (invariant 6): base64url text a store can
 *  match and compare without reading it. `scope` (bound as associated data) keeps equal names in two places apart. */
export function sealName({ key }, text, scope = '') {
  return toBase64Url(aessiv(derivedKey(key, 'names'), encoder.encode(scope)).encrypt(encoder.encode(nameText(text))));
}

/** Opens a sealed name made by sealName under the same key and scope. Throws, in plain words, otherwise. */
export function openName({ key }, sealed, scope = '') {
  if (typeof sealed !== 'string' || !BASE64URL.test(sealed)) throw new Error('This is not a sealed name.');
  try { return decoder.decode(aessiv(derivedKey(key, 'names'), encoder.encode(scope)).decrypt(fromBase64Url(sealed))); }
  catch { throw new Error('This sealed name was sealed with another key or in another place.'); }
}

/** The content identity of a sealed value: 1f: + BLAKE3 of its canonical JSON (invariant 7). */
export function sealedIdentity(value) {
  if (!isSealedValue(value)) throw new Error('This is not a sealed record.');
  const { v, key_id: keyId, nonce, ciphertext } = value.sealed;
  return `1f:${bytesToHex(blake3(encoder.encode(JSON.stringify({ ciphertext, key_id: keyId, nonce, v }))))}`;
}

/** A sealed link copy checked whole: { content_id, value } whose value is exactly a sealed value of bounded size and
 *  whose content_id is that value's identity. Answers the copy, or throws in plain words. A server runs this. */
export function checkedLinkCopy(copy) {
  if (!copy || typeof copy !== 'object' || Array.isArray(copy) || Object.keys(copy).sort().join(',') !== 'content_id,value') throw new Error('A sealed link copy is { content_id, value }.');
  if (!isSealedValue(copy.value)) throw new Error('A sealed link copy holds exactly one sealed value.');
  if (copy.value.sealed.ciphertext.length > rules.link_copy_longest) throw new Error(`A sealed link copy holds at most ${rules.link_copy_longest} characters of ciphertext.`);
  if (sealedIdentity(copy.value) !== copy.content_id) throw new Error('This sealed link copy does not match its content_id.');
  return { content_id: copy.content_id, value: copy.value };
}

/** Seals one opened record ({ type, value }) kept under `id` for a link, with a fresh key of the link's own:
 *  { link_key, sealed_copy: { content_id, value } }. Only sealed_copy goes to the server; link_key goes in the link. */
export async function sealForLink(id, record) {
  const key = newSealingKey();
  const value = await sealRecord(key, id, record);
  return { link_key: toBase64Url(key.key), sealed_copy: { content_id: sealedIdentity(value), value } };
}

/** The link that opens a sealed copy: the share address with the link key in its fragment (invariant 7). `recordId` is
 *  the id the copy was sealed under (it is part of what the key opens, so a page opening the link needs it); it rides in
 *  the fragment beside the key and goes to no server either. */
export function linkWithKey(address, linkKey, recordId = null) {
  const url = new URL(address);
  url.hash = new URLSearchParams({ [rules.fragment_key]: linkKey, ...(recordId ? { [rules.fragment_record]: recordId } : {}) }).toString();
  return url.toString();
}

/** The record id a sealed link carries in its fragment beside its key, or null when it carries none. */
export function linkRecordOf(link) {
  try { return new URLSearchParams(new URL(link).hash.slice(1)).get(rules.fragment_record) || null; } catch { return null; }
}

/** The key a sealed link carries in its fragment: { key, key_id }. Throws when the link carries none. */
export function linkKeyOf(link) {
  let fragment = '';
  try { fragment = new URL(link).hash.slice(1); } catch { throw new Error('This is not a link.'); }
  const text = new URLSearchParams(fragment).get(rules.fragment_key);
  if (!text || !BASE64URL.test(text)) throw new Error('This link does not carry the key that opens it.');
  const key = fromBase64Url(text);
  if (key.length !== 32) throw new Error('This link does not carry the key that opens it.');
  return { key, key_id: keyIdOf(key) };
}

/** Opens a sealed link copy of the record `id` with the key the link carries: { type, value }. */
export function openFromLink(link, id, copy) {
  const checked = checkedLinkCopy(copy);
  return openRecord(linkKeyOf(link), id, checked.value);
}

/** Seals one file's bytes with a fresh key of its own (invariant 8): { identity, ciphertext, file_key }. identity is
 *  1f: + BLAKE3 of the ciphertext (nonce then sealed bytes), the address the file is kept and fetched by. */
export async function sealFileBytes(bytes) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await aesKey(key, 'encrypt'), bytes));
  const ciphertext = new Uint8Array(nonce.length + sealed.length);
  ciphertext.set(nonce);
  ciphertext.set(sealed, nonce.length);
  return { identity: `1f:${bytesToHex(blake3(ciphertext))}`, ciphertext, file_key: toBase64Url(key) };
}

/** The record that names a sealed file and carries its key: { type, value: { file, file_key, name, byte_length,
 *  media_type } }. It is sealed like any record (sealRecord), so the key is readable exactly where the record is. */
export function fileReference({ identity, file_key: fileKey, name, byte_length: byteLength, media_type: mediaType = null }) {
  if (!/^1f:[0-9a-f]{64}$/.test(identity ?? '')) throw new Error('A sealed file is named by its BLAKE3 identity.');
  if (typeof fileKey !== 'string' || !BASE64URL.test(fileKey)) throw new Error('A sealed file reference carries its file key.');
  return { type: rules.file_reference_type, value: { file: identity, file_key: fileKey, name: nameText(name), byte_length: byteLength, media_type: mediaType } };
}

/** Opens a sealed file's bytes with the key its reference carries, after checking they are the bytes it names. */
export async function openFileBytes(reference, ciphertext) {
  if (reference?.type !== rules.file_reference_type) throw new Error('This record does not name a sealed file.');
  const { file, file_key: fileKey } = reference.value;
  if (`1f:${bytesToHex(blake3(ciphertext))}` !== file) throw new Error('These are not the bytes this file reference names.');
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ciphertext.subarray(0, 12) }, await aesKey(fromBase64Url(fileKey), 'decrypt'), ciphertext.subarray(12))); }
  catch { throw new Error('This sealed file was changed, so it does not open.'); }
}

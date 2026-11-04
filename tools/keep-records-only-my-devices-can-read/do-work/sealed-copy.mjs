// parts/sealed-records/do-work/sealed-copy.mjs
//
// PURPOSE
//   Sealed records on one device's copy of the person's records (parts/device-copy): unlock the person's one sealing
//   key from their passphrase, seal a record, open it to read, open it back for good, and search inside sealed records
//   once they are open. The browser's worker and the Mac's copy both use this, so a record sealed on one device opens
//   on the other with the same passphrase.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One sealing record per person (`SEALING_ID`, kind `sealing`): { salt, key_id }, no secret. The first unlock makes
//      it; every later unlock on any device derives the key with that salt and refuses a passphrase whose key_id differs.
//   2. A device seals only a kind the caller names as sealable (record-copies.json sealable_types), and writes the
//      sealed record in one write, so the copy never holds both.
//   3. Searching sealed records happens here, after opening, on the device: the store cannot search inside them.
//   4. Nothing here names a host, a route, a device kind or a person; the key stays in the caller's memory.
//   5. A sealed link copy is made from the record opened here and sealed again with the link's own fresh key; the
//      person's sealing key never goes into a link. Only the sealed copy is for the server; the link key is for the link.
//   6. A sealed file is kept as two things: its sealed bytes under their BLAKE3 identity, and one sealed record naming
//      it and carrying its key, whose id is the file's sealed name (sealName), so sealing the same name again replaces
//      that one record and the store can match it without reading the name.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { fileReference, keyFromPassphrase, openFileBytes, openRecord, SEALED_FILE_PREFIX, SEALED_TYPE, sealFileBytes, sealForLink, sealName, sealRecord } from './sealed-records.mjs';

export const SEALING_TYPE = 'sealing';
export const SEALING_ID = 'sealing:key';
const toHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** The person's sealing key on this copy: made the first time, else checked against the kept key_id (invariant 1).
 *  `isNew` says a new passphrase was set, so the caller can ask for it twice first. */
export function unlockSealing(store, passphrase, { actor = { by: 'device' } } = {}) {
  const kept = store.typeOf(SEALING_ID) === SEALING_TYPE ? store.read(SEALING_ID) : null;
  if (kept?.salt) {
    const key = keyFromPassphrase(passphrase, kept.salt);
    if (key.key_id !== kept.key_id) throw new Error('That passphrase does not open your sealed records.');
    return { ...key, isNew: false };
  }
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const key = keyFromPassphrase(passphrase, salt);
  store.write([{ id: SEALING_ID, type: SEALING_TYPE, value: { salt, key_id: key.key_id } }], { actor });
  return { ...key, isNew: true };
}

/** Whether this copy holds a sealing record yet (so a device knows whether it is setting a passphrase or entering it). */
export const hasSealing = store => store.typeOf(SEALING_ID) === SEALING_TYPE;

/** Seals one record on this copy. */
export async function sealOnCopy(store, key, id, { sealable, actor = { by: 'device' } }) {
  const type = store.typeOf(id);
  if (type === SEALED_TYPE) return { id, sealed: true };
  if (!type) throw new Error('That record is not on this device yet. Try again in a moment.');
  if (!sealable.includes(type)) throw new Error('This kind of record cannot be sealed.');
  const value = await sealRecord(key, id, { type, value: store.read(id, { bounded: false }) });
  store.write([{ id, type: SEALED_TYPE, value }], { actor });
  return { id, sealed: true };
}

/** One sealed record opened on this device: { type, value }. */
export const openOnCopy = (store, key, id) => openRecord(key, id, store.read(id, { bounded: false }));

/** Opens one sealed record for good: it is kept as itself again, and the store can read it. */
export async function unsealOnCopy(store, key, id, { actor = { by: 'device' } } = {}) {
  if (store.typeOf(id) !== SEALED_TYPE) return { id, sealed: false };
  const { type, value } = await openOnCopy(store, key, id);
  store.write([{ id, type, value }], { actor });
  return { id, sealed: false };
}

const textAt = (value, path) => {
  let at = value;
  for (const name of path) at = at && typeof at === 'object' ? at[name] : undefined;
  return typeof at === 'string' ? at : null;
};

/** The sealed records this key opens whose words at `fields` hold every word, opened on this device:
 *  [{ id, type, title, sealed: true }] (the shape the copy's own find answers, plus `sealed`). */
export async function findSealed(store, key, { words = [], fields = [['title']], limit = 30 } = {}) {
  const terms = words.map(word => String(word).toLocaleLowerCase()).filter(Boolean);
  const found = [];
  for (const { id } of store.find({ words: [], fields: [[SEALED_TYPE, 'key_id']], types: [SEALED_TYPE], limit: 200 })) {
    if (found.length >= limit) break;
    let record;
    try { record = await openOnCopy(store, key, id); } catch { continue; }
    const texts = fields.map(path => textAt(record.value, path)).filter(Boolean);
    const all = texts.join(' ').toLocaleLowerCase();
    if (terms.every(term => all.includes(term))) found.push({ id, type: record.type, title: texts[0] ?? '', sealed: true });
  }
  return found;
}

/** One sealed record of this copy sealed again for a link (invariant 5): { link_key, sealed_copy }. */
export async function shareSealedOnCopy(store, key, id) {
  if (store.typeOf(id) !== SEALED_TYPE) throw new Error('Only a sealed record is shared with a sealed link.');
  return sealForLink(id, await openOnCopy(store, key, id));
}

/** The id of the sealed record naming the file called `name` (invariant 6). */
export const sealedFileId = (key, name) => `${SEALED_FILE_PREFIX}${sealName(key, name, SEALED_FILE_PREFIX)}`;

/** Seals one file on this copy (invariant 6): writes the sealed record that names it and carries its key, and answers
 *  { id, identity, ciphertext } so the caller keeps the sealed bytes under their identity. */
export async function sealFileOnCopy(store, key, { bytes, name, media_type: mediaType = null }, { actor = { by: 'device' } } = {}) {
  const id = sealedFileId(key, name);
  const { identity, ciphertext, file_key: fileKey } = await sealFileBytes(bytes);
  const value = await sealRecord(key, id, fileReference({ identity, file_key: fileKey, name, byte_length: bytes.length, media_type: mediaType }));
  store.write([{ id, type: SEALED_TYPE, value }], { actor });
  return { id, identity, ciphertext };
}

/** A sealed file's bytes opened on this device with the key its sealed record carries: { name, media_type, bytes }. */
export async function openFileOnCopy(store, key, id, ciphertext) {
  const reference = await openOnCopy(store, key, id);
  const bytes = await openFileBytes(reference, ciphertext);
  return { name: reference.value.name, media_type: reference.value.media_type, bytes };
}

// src/incoming-files.mjs
// Attachments named by an arrival or a recorded message must already belong to the account's Files.

import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { GENERIC_TYPE, fileType } from '../../organize-my-files/src/file-type.mjs';

const IDENTITY = /^(?:1f|12):[0-9a-f]{64}$/;
const refused = message => Object.assign(new Error(message), { status: 400 });
const itemsOf = items => Array.isArray(items) ? items.map((item, index) => [item, index]).filter(([item]) => item && typeof item === 'object') : [];
const identitiesOf = (item, index) => {
  const attachments = item.attachments ?? item.files?.map(file => file?.id ?? file?.identity) ?? [];
  if (!Array.isArray(attachments)) throw refused(`messages[${index}].attachments must name files already in your Files.`);
  return attachments.map(attachment => {
    const identity = typeof attachment === 'string' ? attachment : attachment?.identity ?? attachment?.id;
    if (typeof identity !== 'string' || !IDENTITY.test(identity)) throw refused(`messages[${index}].attachments must use a file identity from your Files.`);
    return identity;
  });
};

export const incomingFileIdentities = items => [...new Set(itemsOf(items).flatMap(([item,index])=>identitiesOf(item,index)))];

const bytesOfHeld = held => typeof held === 'string' ? Buffer.from(held, 'utf8')
  : held.text !== undefined ? Buffer.from(held.text, 'utf8') : Buffer.from(held.base64 ?? '', 'base64');

/** The person's Files this run was handed (input.stored.files: { name: text | { base64 } | null }; a name given null is not
 *  there), each named by its content identity. Two names holding the same bytes are one file, named by the first in order. */
export function storedFileLookup(files = {}) {
  const byIdentity = new Map();
  for (const name of Object.keys(files).sort()) {
    if (files[name] === null || files[name] === undefined) continue;
    const identity = makeHashCodeHexFromBytes(bytesOfHeld(files[name]));
    if (!byIdentity.has(identity)) byIdentity.set(identity, { name, media_type: fileType(null, name) ?? GENERIC_TYPE });
  }
  return identity => byIdentity.get(identity) ?? null;
}

/** Look up each distinct identity once. `locate(identity)` returns the file's name and media type or null. */
export function locateIncomingFiles(items, locate) {
  const located = new Map();
  for (const [item, index] of itemsOf(items)) for (const identity of identitiesOf(item, index)) {
    if (located.has(identity)) continue;
    const file = locate(identity);
    if (!file) throw refused(`The attached file ${identity} is not in your Files.`);
    located.set(identity, { identity, name: file.name, media_type: file.media_type });
  }
  return located;
}

/** Fill incoming attachment names from the owning Files. Existing attachment objects are treated as identities only. */
export function fillIncomingFiles(items, located) {
  for (const [item, index] of itemsOf(items)) {
    const details = [...new Set(identitiesOf(item, index))].map(identity => {
      const file = located.get(identity);
      if (!file) throw refused(`The attached file ${identity} is not in your Files.`);
      return file;
    });
    if (Array.isArray(item.attachments)) item.attachments = details;
    if (Array.isArray(item.files)) item.files = details.map(file => ({ id: file.identity, ...(file.name ? { name: file.name } : {}), ...(file.media_type ? { media_type: file.media_type } : {}) }));
  }
}

/** Check and canonicalize one batch in place, preserving its original item/operation result shape. The check only reads, so
 *  whatever fails it proves nothing was taken (`not_sent`, as the command journal reads it): the command ends aborted, never
 *  'unknown', and its retry is a new command instead of a key refused for a receipt nobody will write. */
export function verifyIncomingFiles(items, locate) {
  try { fillIncomingFiles(items, locateIncomingFiles(items, locate)); }
  catch (error) { if (error && typeof error === 'object') error.not_sent = true; throw error; }
}

/** Check a carrier batch against the Files handed in as input.stored.files. */
export function checkIncomingFiles(input) {
  if (!Array.isArray(input?.items)) throw Object.assign(new Error('Send items: a batch of arrival or message objects.'), { status: 400, not_sent: true });
  const items = structuredClone(input.items);
  verifyIncomingFiles(items, storedFileLookup(input.stored?.files));
  return { items };
}

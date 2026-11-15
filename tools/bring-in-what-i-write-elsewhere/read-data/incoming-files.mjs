// src/incoming-files.mjs
// Attachments named by an arrival or a recorded message must already belong to the account's Files.

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

/** Look up each distinct identity once. `locate(identity, context)` returns the file's names/media type or null. */
export async function locateIncomingFiles(items, locate, context) {
  const located = new Map();
  for (const [item, index] of itemsOf(items)) for (const identity of identitiesOf(item, index)) {
    if (located.has(identity)) continue;
    const file = await locate(identity, context);
    if (!file) throw refused(`The attached file ${identity} is not in your Files.`);
    located.set(identity, { identity, ...(file.names?.[0] ? { name: file.names[0] } : {}), ...(file.media_type ? { media_type: file.media_type } : {}) });
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
export async function verifyIncomingFiles(items, locate, context) {
  try { fillIncomingFiles(items, await locateIncomingFiles(items, locate, context)); }
  catch (error) { if (error && typeof error === 'object') error.not_sent = true; throw error; }
}

/** The current run's Files door: authority and account partition are held by the
 * native parent, never accepted from attachment objects or a caller-supplied owner. */
export const nativeFileLookup = door => async identity => {
  try { return await door.files('find_file', { name_or_identity: identity }); }
  catch (error) { if (error?.code === 'namespace_not_found') return null; throw error; }
};

/** Check a carrier batch through the current admitted Files door. */
export async function checkIncomingFiles(input, { door }) {
  if (!Array.isArray(input?.items)) throw Object.assign(new Error('Send items: a batch of arrival or message objects.'), { status: 400, not_sent: true });
  const items = structuredClone(input.items);
  await verifyIncomingFiles(items, nativeFileLookup(door));
  return { items };
}

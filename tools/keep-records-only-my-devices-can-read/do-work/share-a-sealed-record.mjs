// tools/keep-records-only-my-devices-can-read/do-work/share-a-sealed-record.mjs
//
// One record shared by a sealed link, or opened from one, by sealed-records.mjs:
//   seal  { id, record: { type, value }, address }  seals the record under a fresh key of the link's own and answers
//         { link, sealed_copy, content_id, opens }: link is address with the key (and the record id) in its fragment,
//         the part after # that a browser never sends to a server; sealed_copy ({ content_id, value }) is the only thing
//         a store is given, and it cannot read it; opens says the copy was opened again from the link in this run.
//   open  { id, link, copy }  checks the copy whole and opens it with the key the link carries: answers { record }.
// Refuses, in plain words: a record that is not { type, value }, an address that is not a web address, a link with no
// key, a copy that is not one bounded sealed value or does not match its content_id, another key, a changed copy.
// Nothing is kept or sent: the caller gives the link to the person and sealed_copy to the store.
import { checkedLinkCopy, linkWithKey, openFromLink, sealForLink } from './sealed-records.mjs';

export async function shareASealedRecord({ op = 'seal', id, record, address, link, copy } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('Give id: the record id the copy is sealed under (it is part of what the key opens).');
  if (op === 'open') {
    if (typeof link !== 'string') throw new Error('Give link: the sealed link, with its key after #.');
    return { record: await openFromLink(link, id, copy) };
  }
  if (op !== 'seal') throw new Error(`op is seal or open, not ${JSON.stringify(op)}.`);
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') throw new Error('Give record: { type, value }.');
  try { new URL(address); } catch { throw new Error('Give address: the web address the link opens, e.g. https://share.example/s/1.'); }
  const { link_key: linkKey, sealed_copy: sealedCopy } = await sealForLink(id, record);
  const made = linkWithKey(address, linkKey, id);
  const opened = await openFromLink(made, id, checkedLinkCopy(sealedCopy));
  const opens = JSON.stringify(opened) === JSON.stringify({ type: record.type, value: record.value });
  return { link: made, sealed_copy: sealedCopy, content_id: sealedCopy.content_id, opens };
}

// extension/src/share-record.mjs
//
// PURPOSE
//   What one send from the browser becomes: ONE record of the person's own, written through the one door (the
//   do_one_thing_in_my_account tool, method records:write at @own-records), the same record the iPhone Share sheet writes
//   (ios/Shared/ShareRecord.swift). With no list picked it is a `shared` record and Trillion files it
//   (the Workshop recipe turn-something-shared-into-what-you-can-use wakes on that kind); with a list picked it is a row
//   of that list (`record:<row_type>:<key>`), its title in the list's title field. The lists offered are the person's own
//   `list` records, read through the same door (records:list).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One record per send, its id ending in the send's request key, so a retry with the same key is the same write.
//   2. Nothing here names a list, a site or a kind of row; a list is offered when its record says its row type.
//   3. This file imports nothing, so the popup, the worker and the tests all load it.

const DOOR = { tool: 'do_one_thing_in_my_account', address: '@own-records', write: 'records:write', list: 'records:list' };
/** The most lists one read asks for: every list a person may keep (lists_per_person). */
const MOST_LISTS = 500;
const TITLE_CHARS = 120;

export const DOOR_TOOL = DOOR.tool;

/** The share's title: its first link, else the start of its first passage, else its first file's name. */
export function shareTitle(items) {
  // A selection and a kept file carry the page they came from; neither is a link of its own.
  const link = items.find(item => typeof item?.url === 'string' && item.url && item.kind !== 'selection' && !item.file);
  if (link) return link.url;
  const text = items.find(item => typeof item?.text === 'string' && item.text.trim());
  if (text) return text.text.trim().slice(0, TITLE_CHARS);
  return items.find(item => typeof item?.name === 'string' && item.name)?.name ?? '';
}

/**
 * The record one send writes. `list` is one entry of listsFrom (or null: Trillion files it); `at` is the ISO time.
 */
export function shareRecord({ requestKey, items, ownWords = '', from, at, list = null }) {
  const own = String(ownWords ?? '').trim();
  const value = { title: shareTitle(items), items, ...(own ? { own_words: own } : {}), from, at };
  if (!list) return { id: `shared:${requestKey}`, type: 'shared', value };
  const type = `record:${list.row_type}`;
  return { id: `${type}:${requestKey}`, type, value: list.title_field ? { ...value, [list.title_field]: value.title } : value };
}

/** The door's arguments for one send; the outbox sends these same arguments again until the account answers. */
export const writeArguments = share => ({
  address: DOOR.address, method: DOOR.write, request_key: share.requestKey, input: { records: [shareRecord(share)] },
});

/** The door's arguments for reading the person's lists. */
export const listArguments = () => ({
  address: DOOR.address, method: DOOR.list, request_key: crypto.randomUUID(), input: { type: 'list', limit: MOST_LISTS },
});

/** The lists a send can go to, from a records:list answer: { id, label, row_type, title_field }. */
export function listsFrom(answer) {
  if (!answer || !Array.isArray(answer.records)) {
    throw new TypeError('Trillion did not return the lists for this account.');
  }
  return answer.records
    .filter(record => typeof record?.id === 'string' && typeof record?.value?.row_type === 'string' && record.value.row_type)
    .map(record => {
      const slug = record.id.replace(/^list:/, '');
      return { id: record.id, label: String(record.value.label || slug), row_type: record.value.row_type,
        title_field: typeof record.value.title_field === 'string' && record.value.title_field ? record.value.title_field : null };
    });
}

/** Reads the person's lists with `tool` (the account's tool caller). */
export const readLists = async tool => listsFrom(await tool(DOOR.tool, listArguments()));

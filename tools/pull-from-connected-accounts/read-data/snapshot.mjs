// tools/pull-from-connected-accounts/read-data/snapshot.mjs
//
// Where a pulled account lives in the person's records, and how to read it back as one snapshot.
//
// Every record is of kind `account-snapshot-part`; its id says the source, the account and what the part is:
//
//   account-snapshot:<source>:<account>:state                    { kind: "state", self_id, cursor, pulled_at }
//   account-snapshot:<source>:<account>:thread:<thread id>       { kind: "thread", seq, thread: { id, title, messages, source? } }
//   account-snapshot:<source>:<account>:item:<collection>:<id>   { kind: "item", seq, collection, identity, item }
//
// Messages and items are kept exactly as the service sent them. `seq` is the order a part was first seen in.
// An id segment keeps letters, digits and . _ @ - and writes every other byte as ~ and two hex digits, so no segment
// holds a colon or a slash.

export const PART_KIND = 'account-snapshot-part';
const PREFIX = 'account-snapshot:';

const encoder = new TextEncoder();
export const segment = value => [...encoder.encode(String(value))]
  .map(byte => (/[A-Za-z0-9._@-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `~${byte.toString(16).padStart(2, '0')}`))
  .join('');

export const prefixOf = (source, account) => `${PREFIX}${segment(source)}:${segment(account)}:`;
export const stateId = (source, account) => `${prefixOf(source, account)}state`;
export const threadId = (source, account, thread) => `${prefixOf(source, account)}thread:${segment(thread)}`;
export const itemId = (source, account, collection, item) => `${prefixOf(source, account)}item:${segment(collection)}:${segment(item)}`;

/** Everything held for one account: { state, threads: Map(thread id -> value), items: Map(collection -> Map(item id -> value)) }. */
export async function readParts(door, source, account) {
  const held = { state: null, threads: new Map(), items: new Map(), ids: new Map() };
  for await (const record of door.list({ type: PART_KIND, prefix: prefixOf(source, account) })) {
    const value = record.value;
    held.ids.set(record.id, value);
    if (value?.kind === 'state') held.state = value;
    else if (value?.kind === 'thread') held.threads.set(String(value.thread.id), value);
    else if (value?.kind === 'item') {
      if (!held.items.has(value.collection)) held.items.set(value.collection, new Map());
      held.items.get(value.collection).set(String(value.identity), value);
    }
  }
  return held;
}

/** The held parts as one snapshot: { source, account, self_id, cursor, threads: [...], collections: { name: [...] } }, each list in first-seen order. */
export function assemble(source, account, held) {
  const bySeq = (a, b) => a.seq - b.seq;
  return {
    source,
    account,
    self_id: held.state?.self_id ?? null,
    cursor: held.state?.cursor ?? null,
    threads: [...held.threads.values()].sort(bySeq).map(value => value.thread),
    collections: Object.fromEntries([...held.items].map(([name, items]) => [name, [...items.values()].sort(bySeq).map(value => value.item)])),
  };
}

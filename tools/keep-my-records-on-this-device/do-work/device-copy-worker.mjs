// parts/device-copy/do-work/device-copy-worker.mjs
//
// PURPOSE
//   The dedicated worker a page starts to keep the person's records on this device: it opens the same record store the
//   hosted copy runs (parts/record-log) over SQLite compiled to WebAssembly in the browser's private file system, answers
//   the page's reads from it, and settles it with the copy it follows in bounded requests (record-sync.mjs settleWith).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The copy, its id and its positions are device-copy.mjs's: a reload never resends or retakes what it settled.
//   2. The worker only opens the database, sends over the page's sign-in, and answers messages.
//   3. The page names where to settle (`settle_url`) and which indexes to keep (DATA): nothing here names a route,
//      a record kind or a product.
//   4. A failure is answered to the page as words in `error`; the copy is never left half written (each write is one
//      transaction).
//
// KEY CONCEPTS
//   message  { id, call, args } -> { id, result } | { id, error }
//   calls    every call carries account; open { account, settle_url, indexes, erasable } | read { account, id } | ids { account, type, limit } | find { account, words, fields, leaveOut, limit } | settle | state
//            sealing -> { has_passphrase, unlocked } | unlock { passphrase } | lock | seal { id, sealable } | unseal { id }
//            open_sealed { id } -> { type, value } | find_sealed { words, fields, limit }
//            share_sealed { id } -> { link_key, sealed_copy } | open_link { link, id, sealed_copy } -> { type, value }
//            seal_file { bytes, name, media_type } -> { id, identity, ciphertext } | open_file { id, ciphertext } -> { name, media_type, bytes }
//   Sealed records (parts/sealed-records sealed-copy.mjs): the key unlocked from the person's passphrase stays in this
//   worker's memory only; sealing and unsealing settle first so the copy holds the newest record, then settle again so
//   the store keeps the sealed one.
//
// SECURITY
//   The settle request carries the page's own sign-in (same origin, its cookie); the worker holds no account key. The
//   sealing key lives only in this worker's memory, is never posted back to the page and is gone when the page closes.
//   share_sealed answers a link's own fresh key (never the sealing key) so the page can put it in the link's fragment.
//   The account also partitions disk records and positions; a server-side account mismatch closes access. The old
//   unbound directory is never opened or imported because its account cannot be established safely.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
// The compiled SQLite's bytes: the page's build serves them as their own content-named file and this is its address.
import sqliteBytesUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm';
import { openDeviceDatabase } from './wasm-sqlite-host.mjs';
import { deviceCopy } from './device-copy.mjs';
import { accountCopyLocation, accountCopySender } from './account-copy.mjs';
import { findSealed, hasSealing, openFileOnCopy, openOnCopy, sealFileOnCopy, sealOnCopy, shareSealedOnCopy, unlockSealing, unsealOnCopy } from '../../keep-records-only-my-devices-can-read/do-work/sealed-copy.mjs';
import { openFromLink } from '../../keep-records-only-my-devices-can-read/do-work/sealed-records.mjs';

let copy = null;
let sealingKey = null;
let account = null;
let transport = null;
let active = false;
const needKey = () => { if (!sealingKey) throw new Error('Enter your passphrase to open sealed records.'); return sealingKey; };
const settled = async change => { await copy.settle(); const done = await change(); await copy.settle(); return done; };

async function open({ account: owner, settle_url, indexes = [], erasable = {}, most_rows_sent = 200, most_chars_sent = 4_000_000 }) {
  const location = accountCopyLocation(owner);
  if (copy) {
    if (!active || account !== owner) throw new Error('This account’s copy is closed.');
    return copy.describe();
  }
  const sqlite3 = await sqlite3InitModule({ locateFile: () => sqliteBytesUrl });
  const host = await openDeviceDatabase(sqlite3, location);
  account = owner;
  active = true;
  transport = accountCopySender({ account, url: settle_url, stopped: () => {
    active = false; sealingKey = null;
    self.postMessage({ account_closed: true });
  } });
  copy = deviceCopy(host, { send: transport.send, indexes, erasable, prefix: 'browser', max_upload_rows: most_rows_sent, max_upload_chars: most_chars_sent });
  return copy.describe();
}

const calls = {
  open,
  read: ({ id }) => copy.store.read(id),
  ids: ({ type, limit }) => copy.store.ids(type, { limit }),
  find: args => copy.store.find(args),
  settle: () => copy.settle(),
  state: () => copy.describe(),
  sealing: () => ({ has_passphrase: hasSealing(copy.store), unlocked: Boolean(sealingKey) }),
  unlock: async ({ passphrase }) => {
    if (!hasSealing(copy.store)) await copy.settle();
    const { isNew, ...key } = unlockSealing(copy.store, passphrase);
    sealingKey = key;
    if (isNew) await copy.settle();
    return { unlocked: true, is_new: isNew };
  },
  lock: () => { sealingKey = null; return { unlocked: false }; },
  seal: ({ id, sealable }) => settled(() => sealOnCopy(copy.store, needKey(), id, { sealable })),
  unseal: ({ id }) => settled(() => unsealOnCopy(copy.store, needKey(), id)),
  open_sealed: ({ id }) => openOnCopy(copy.store, needKey(), id),
  find_sealed: args => (sealingKey ? findSealed(copy.store, sealingKey, args) : []),
  share_sealed: async ({ id }) => { await copy.settle(); return shareSealedOnCopy(copy.store, needKey(), id); },
  open_link: ({ link, id, sealed_copy: sealedCopy }) => openFromLink(link, id, sealedCopy),
  seal_file: ({ bytes, name, media_type: mediaType }) => settled(() => sealFileOnCopy(copy.store, needKey(), { bytes, name, media_type: mediaType })),
  open_file: ({ id, ciphertext }) => openFileOnCopy(copy.store, needKey(), id, ciphertext),
};

self.onmessage = async event => {
  const { id, call, args } = event.data ?? {};
  try {
    if (call !== 'open' && (!copy || !active || args?.account !== account)) throw new Error('This account’s copy is closed.');
    if (!calls[call]) throw new Error(`This copy does not answer ${call}.`);
    const result = await calls[call](args ?? {});
    if (!active) throw new Error('This account’s copy is closed.');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error) });
  }
};

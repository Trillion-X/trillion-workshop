// extension/src/outbox.mjs
//
// PURPOSE
//   A send is never lost when the person's account cannot be reached. When the record write fails because the network is
//   down or the account is busy (a network error, a 5xx, a 503), the whole send ({ request_key, args }) is kept in
//   chrome.storage.local `outbox` and the background worker (src/background.mjs) sends it again every minute and when
//   the browser starts, with the SAME request_key (the account answers a repeated key with the first send's answer, so
//   a retry never doubles a share). A send the account kept at its edge ({ queued: true }) is a success, not a failure.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One request_key per draft, made once; a retry always sends the key it was kept with.
//   2. Only a failure that a retry can fix is kept (`keepable`): a refusal in words (a plan, a bad request) is said to the
//      person, and a kept send that is later refused is marked `refused` and not tried again.
//   3. A send leaves the outbox only when the account answered it (sent or kept at its edge).
//   4. Nothing here knows a list, a site or a record; the arguments are the popup's own (src/share-record.mjs).
//   5. This file imports only src/share-record.mjs, which imports nothing, so the popup, the worker and the tests all load it.
//   6. Every kept send carries the account it was made for (`account`), and a send goes out only while that same account
//      is signed in, checked right before each send. Another account's sends, and older ones that name no account, wait
//      for their own account and are never sent as anyone else.

import { DOOR_TOOL } from './share-record.mjs';

// A previous extension kept destination-oriented `deliver_share` arguments in
// this same store. They cannot be replayed as a records:write call: doing so
// would either refuse the send or silently discard its chosen destination and
// action. Keep those rows intact until an explicit migration can preserve that
// intent.
const addressedShare = args => args?.address === '@own-records' && args?.method === 'records:write'
  && Array.isArray(args?.input?.records) && args.input.records.length === 1;

export const OUTBOX = 'outbox';
export const OUTBOX_ALARM = 'send-outbox';
export const OUTBOX_EVERY_MINUTES = 1;

/** The account could not be reached or was too busy to answer: the same send may be tried again. */
export class Unreachable extends Error {
  constructor(message = 'Trillion could not be reached.') { super(message); this.name = 'Unreachable'; }
}

/** Whether an HTTP status means "try again" (the account was busy or down) rather than "no". */
export const retryableStatus = status => status >= 500 || status === 408 || status === 429;

/** Whether a failure can be fixed by sending the same thing again. */
export const keepable = error => error?.name === 'Unreachable' || error?.name === 'TypeError';

/** The account kept the send at its edge and will deliver it when its store answers. */
export const keptAtEdge = answer => answer?.queued === true;
// Two views (the popup and the worker) may change the outbox at once; one at a time when the browser offers locks.
const alone = work => (globalThis.navigator?.locks ? navigator.locks.request(OUTBOX, work) : work());

function storageOf(area) {
  return {
    read: async () => { const rows = (await area.get(OUTBOX))[OUTBOX]; return Array.isArray(rows) ? rows : []; },
    write: rows => area.set({ [OUTBOX]: rows }),
  };
}
const defaultStorage = () => storageOf(globalThis.chrome.storage.local);

/** What is waiting to send. */
export const waiting = (area) => (area ? storageOf(area) : defaultStorage()).read();

/** Keeps a send in the outbox (the same request_key replaces its earlier row). */
export function keepSend({ args, account = null, now = Date.now(), area } = {}) {
  const store = area ? storageOf(area) : defaultStorage();
  return alone(async () => {
    const rows = (await store.read()).filter(row => row.request_key !== args.request_key);
    await store.write([...rows, { request_key: args.request_key, args, account, kept_at: now }]);
  });
}

const drop = (store, request_key) => alone(async () => store.write((await store.read()).filter(row => row.request_key !== request_key)));
const mark = (store, request_key, change) => alone(async () => store.write((await store.read()).map(row => (row.request_key === request_key ? { ...row, ...change } : row))));

/**
 * Sends `args` through the door (`tool` with DOOR_TOOL, src/share-record.mjs). Answers { state: 'sent' | 'kept', answer }: 'sent' when the account took it,
 * 'kept' when the account kept it at its edge (queued) or this device kept it to send again. Any other failure is thrown.
 */
export async function sendOrKeep({ tool, args, area, account = null }) {
  try {
    const answer = await tool(DOOR_TOOL, args);
    return keptAtEdge(answer) ? { state: 'kept', answer, where: 'account' } : { state: 'sent', answer };
  } catch (error) {
    if (!keepable(error)) throw error;
    await keepSend({ args, account, area });
    return { state: 'kept', answer: null, where: 'device' };
  }
}

let draining = null;
/**
 * Sends everything kept, oldest first, each with the key it was kept with. A send the account answered (sent or kept at its
 * edge) leaves the outbox; an unreachable account ends the round (the next alarm tries again); a refusal in words marks
 * that send `refused` and the rest go on. Only sends of the account signed in now go, asked of `account()` right before
 * each one (invariant 6). Answers how many left the outbox.
 */
export function drainOutbox({ tool, area, account = async () => null } = {}) {
  draining ??= (async () => {
    const store = area ? storageOf(area) : defaultStorage();
    let sent = 0;
    for (const row of await store.read()) {
      if (row.refused) continue;
      if (!addressedShare(row.args)) {
        if (!row.migration_required) await mark(store, row.request_key, { migration_required: true });
        continue;
      }
      const current = await account();
      if (!current || row.account !== current) continue;
      try {
        await tool(DOOR_TOOL, row.args);
        await drop(store, row.request_key);
        sent += 1;
      } catch (error) {
        if (error?.name === 'SignInNeeded' || keepable(error)) break;
        await mark(store, row.request_key, { refused: String(error?.message ?? error).slice(0, 300) });
      }
    }
    return sent;
  })().finally(() => { draining = null; });
  return draining;
}

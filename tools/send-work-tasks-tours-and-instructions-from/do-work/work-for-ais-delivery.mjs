// tools/send-work-tasks-tours-and-instructions-from/do-work/work-for-ais-delivery.mjs
//
// Delivery of the rows of work when an account's AI connects. Ported from the old owner's src/work-for-ais.mjs at commit
// b6ae0ebf81 (the tag named in moved-from.json): makeWorkDelivery (lines 149-198). Built and tested, not wired, waits for
// the owner's word.
//
// Every dependency is handed in: the rows in force, the account's facts, the audience matcher, the handoff writer and the
// clock. The settings (cache_seconds, rows_cache_seconds, the handoff names, the default trigger) come from the caller's
// rules object, which is read from its owner's DATA file (tools/decide-when-things-show/read-data/work-for-ais.json).
// Nothing here lists accounts or reads a store.
import { handoffFor, rowsFor } from './work-for-ais-rules.mjs';

// The most accounts whose delivery is remembered in memory; the oldest is let go first.
export const ACCOUNTS_KEPT = 5000;

/** Delivery for accounts as they connect. `rowsNow(context)` gives the rows in force, `factsOf(accountId, context)` that
 *  account's facts, `matches(tree, fields, facts, context)` the audience row filter, `handOff(accountId, handoff, context)`
 *  makes the handoff in that account's own store (answering { live: true } when it is held for an hour only). `context` is
 *  whatever the connecting call hands deliver. Returns { deliver(accountId, context) } → the row ids newly handed. */
export function makeWorkDelivery({ rowsNow, factsOf, matches, handOff, now = Date.now, rules }) {
  const accounts = new Map();
  const running = new Map();
  let kept = null;
  let readingRows = null;
  // The rows in force, read once for every account inside rows_cache_seconds; overlapping reads share one read.
  const rows = async context => {
    if (kept && now() - kept.at <= rules.rows_cache_seconds * 1000) return kept.rows;
    readingRows ??= Promise.resolve().then(async () => {
      const at = now();
      const rows = await rowsNow(context);
      kept = { at, rows };
      return rows;
    }).finally(() => { readingRows = null; });
    return readingRows;
  };
  const deliver = async (accountId, context) => {
    const entry = accounts.get(accountId);
    if (entry && now() - entry.at < rules.cache_seconds * 1000) return [];
    const handed = entry?.handed ?? new Set();
    const nowMs = now();
    const facts = await factsOf(accountId, context);
    const due = (await rowsFor({ rows: await rows(context), facts, nowMs, matches: (tree, fields, row) => matches(tree, fields, row, context), rules })).filter(row => !handed.has(row.id));
    const done = [];
    for (const row of due) {
      // A plan that keeps nothing holds the work an hour in memory ({ live: true }): it is not remembered as handed, so once that
      // has run out an unfinished account is handed it again.
      const made = await handOff(accountId, handoffFor(row, rules), context);
      if (!made?.live) handed.add(row.id);
      done.push(row.id);
    }
    // Remembered only once every handoff was made: a failure leaves the account to be tried again at its next call.
    accounts.set(accountId, { at: nowMs, handed });
    if (accounts.size > ACCOUNTS_KEPT) accounts.delete(accounts.keys().next().value);
    return done;
  };
  return {
    deliver(accountId, context = {}) {
      // A slow background delivery can overlap many tool replies. One run per account; the handoff's once_per still fences
      // retries and other instances.
      if (running.has(accountId)) return running.get(accountId);
      const work = Promise.resolve().then(() => deliver(accountId, context))
        .finally(() => { if (running.get(accountId) === work) running.delete(accountId); });
      running.set(accountId, work);
      return work;
    },
  };
}

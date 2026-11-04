// parts/record-log/do-work/record-time.mjs
//
// UNDO ANY CHANGE, AND READ ANY RECORD AS IT WAS, FROM THE LOG THE STORE ALREADY KEEPS.
//
// Purpose
//   Every envelope a record store writes carries what it replaced (record-log-store.mjs invariant 9). Turned around, an
//   envelope is its own undo: the inverse sets back what it replaced and expects to find what it wrote. Undo is that
//   inverse applied through the store's applyChanges, so a field changed again since is left alone and named as a
//   conflict instead of being overwritten. A record as it was at an earlier moment is its current value with the
//   inverses of every later change to it applied, newest first.
//
// Non-negotiable invariants
//   1. Undo is a new change (one log row), never an erasure: the history keeps both the change and its undoing, so an
//      undo can itself be undone.
//   2. A field changed since the change being undone is never overwritten by the undo; it is answered as a conflict.
//   3. A past value is answered only when every change after that moment is still in the database and carries what it
//      replaced; otherwise the answer says how far back it can go (`complete: false`, `kept_from`), never a guess.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { logPositionOf } from './log-position.mjs';

/** The envelope that takes back one envelope, or null when it changed nothing that can be taken back. */
export function inverseOf(envelope) {
  if (envelope.remove) return envelope.prior ? { id: envelope.id, type: envelope.prior.type, value: envelope.prior.value, prior: null } : null;
  if (envelope.value !== undefined) {
    if (!('prior' in envelope)) return null;
    const after = { type: envelope.type, value: envelope.value };
    return envelope.prior ? { id: envelope.id, type: envelope.prior.type, value: envelope.prior.value, prior: after } : { id: envelope.id, remove: true, prior: after };
  }
  if (!envelope.was) return null;
  const was = envelope.was;
  const set = { ...was };
  const unset = [...(envelope.added ?? [])];
  // What the undo expects to find: what the change wrote (a field it took away is expected absent).
  const expected = {};
  for (const [field, value] of Object.entries(envelope.set ?? {})) expected[field] = value;
  return { id: envelope.id, type: envelope.type, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}), was: expected };
}

/** The record types one envelope touches: what it writes and, for a whole value or a removal, what it replaces. */
export const typesOf = envelope => [...new Set([envelope.type, envelope.prior?.type].filter(Boolean))];

/**
 * Takes back one transaction: every envelope it wrote, newest first, each field only where it still holds what that
 * transaction wrote. One write. Answers { transaction_id, applied, conflicts, undone } (undone: the transaction taken
 * back; applied 0 and no conflicts when it was already taken back or changed nothing). `allows(envelope)` (optional)
 * names what the caller may take back; anything else is answered as a conflict (`not_changeable_here`), never applied.
 */
export function undoTransaction(store, transactionId, context = {}, { allows = () => true } = {}) {
  const rows = store.log({ transaction_id: transactionId });
  if (!rows.length) throw new Error(`No change ${transactionId} is kept in this store's log.`);
  const inverses = rows.flatMap(row => row.envelopes).reverse().map(inverseOf).filter(Boolean);
  const refused = inverses.filter(inverse => !allows(inverse)).map(inverse => ({ id: inverse.id, field: null, reason: 'not_changeable_here' }));
  const result = store.applyChanges([{ id: rows[0].id, envelopes: inverses.filter(allows) }], { ...context, actor: { ...(context.actor ?? {}), undoes: transactionId } });
  return { ...result, conflicts: [...refused, ...result.conflicts], undone: transactionId };
}

/**
 * One record as it was at `at` (an ISO time or a log row id): { value, type, complete, kept_from }. value is null when
 * the record did not exist then. complete is false when a change after `at` is no longer in the database or carries
 * nothing to take it back with; kept_from is then the oldest moment the answer is good for.
 */
export function readAt(store, id, at) {
  const position = logPositionOf(at);
  const now = store.storedRecord(id);
  let type = now?.type ?? null;
  let value = now ? structuredClone(now.value) : null;
  const rows = store.log({ record_id: id, since: position }).filter(row => row.id >= position).reverse();
  const oldestKept = store.logAfter(null, { limit: 0 }).oldest;
  let complete = oldestKept === null || oldestKept <= position;
  let keptFrom = null;
  for (const row of rows) {
    for (const envelope of [...row.envelopes].reverse()) {
      if (envelope.id !== id) continue;
      const inverse = inverseOf(envelope);
      if (!inverse) { complete = false; keptFrom = row.id; break; }
      if (inverse.remove) { value = null; type = null; continue; }
      if (inverse.value !== undefined) { value = structuredClone(inverse.value); type = inverse.type; continue; }
      value = { ...(value ?? {}) };
      for (const field of inverse.unset ?? []) delete value[field];
      Object.assign(value, structuredClone(inverse.set ?? {}));
      type = inverse.type;
    }
    if (keptFrom) break;
  }
  if (!complete && keptFrom === null) keptFrom = oldestKept;
  return { type, value: value === null ? null : store.resolved(value, id), complete, kept_from: complete ? null : keptFrom };
}

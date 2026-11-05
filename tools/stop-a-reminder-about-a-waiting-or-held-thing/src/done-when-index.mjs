// src/done-when-index.mjs
//
// Purpose: keeps each Waiting on you row's check from one settle to the next and says which checks must be asked again.
// A rule over a list is kept while that list's write count (src/lists.mjs revisionOf) is the count it was checked
// against, so a write to some other list asks nothing about it. A rule over a source outside the store (devices, files,
// sign-ins, work) has no count to watch, so it is kept only while the store's stamp stands, as it was before. A rule's
// text is compared with the text kept, so editing a rule always asks again. A failed check is never kept.
//
//   plan(rows, { revisionOf, stamp, everything, changed? }) → { held: Map(row id → check), asks: [{ row, text, revisions, stamp }] }
//   keep(plan, checks, openIds)                    remembers the checks that stand; forgets rows no longer open
//
// Used by checkWaiting (src/person-store.mjs). `everything` asks every row and is the baseline the kept answers must match.
import { dependsOn } from './done-when.mjs';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function makeDoneWhenIndex() {
  const remembered = new Map();
  return {
    plan(rows, { revisionOf, stamp = null, everything = false, changed = null }) {
      const held = new Map();
      const changedIds = changed === null ? null : new Set(changed);
      const asks = [];
      for (const row of rows) {
        const rule = row.values?.done_when_rule;
        const text = isObject(rule) ? JSON.stringify(rule) : null;
        const was = remembered.get(row.id);
        const dependencies = text === null ? null : dependsOn(rule);
        // A caller that knows which lists changed must not turn one list write into fresh reads of unrelated
        // logins, devices, files, work or other lists. Preserve a prior answer when there is one; an unseen
        // unaffected rule is simply left for the source that can actually change it.
        const affected = changedIds === null || dependencies?.some(id => changedIds.has(id));
        if (!everything && !affected) {
          if (was !== undefined && was.rule === text) held.set(row.id, was.check);
          continue;
        }
        const standing = was !== undefined && was.rule === text && (was.revisions
          ? was.revisions.every(([id, count]) => revisionOf(id) === count)
          : stamp !== null && was.stamp === stamp);
        if (!everything && standing) { held.set(row.id, was.check); continue; }
        const revisions = dependencies?.map(id => [id, revisionOf(id)]) ?? null;
        asks.push({ row, text, revisions, stamp: dependencies ? null : stamp });
      }
      return { held, asks };
    },
    keep(planned, checks, openIds) {
      for (const ask of planned.asks) {
        const check = checks.get(ask.row.id);
        if (ask.text === null || check?.state === 'failed') remembered.delete(ask.row.id);
        else remembered.set(ask.row.id, { rule: ask.text, check, revisions: ask.revisions, stamp: ask.stamp });
      }
      for (const id of remembered.keys()) if (!openIds.has(id)) remembered.delete(id);
    },
  };
}

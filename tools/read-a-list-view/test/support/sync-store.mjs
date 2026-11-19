// tools/read-a-list-view/test/support/sync-store.mjs
//
// A made-up store for the two-way sync tests: the records a caller holds, each record's version history (newest first),
// and the store's answer to each run's keep rows (storeAfter refuses a row whose expected record moved). A run's keep rows
// become new versions, stamped with the harness clock, so the sync can judge removals and edits by their times.
import { refreshRowSources } from '../../read-data/list-view.mjs';
import { NAMES, storeAfter } from './stored.mjs';

export function syncStore(records) {
  let held = records.map(([id, type, value]) => ({ id, type, value }));
  const history = {};
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const version = (id, value) => {
    history[id] = [{ value, deleted: value === null, at: new Date(clock).toISOString() }, ...(history[id] ?? [])];
  };
  return {
    records: () => held,
    tick() { clock += 60_000; },
    stored(restore = null) { return { records: held, history, restore }; },
    // A write made through the store (an AI writing a row): the same keep contract as a run's rows.
    write(id, type, value) {
      const keep = [{ id, type, value, expected: held.some(record => record.id === id) ? { type, value: held.find(record => record.id === id).value } : null }];
      held = storeAfter(held, keep);
      version(id, value);
    },
    async sync(input = {}) {
      const answer = await refreshRowSources({ names: NAMES, list: input.list ?? 'chores', stored: this.stored(input.restore ?? null), ...input }, {});
      held = storeAfter(held, answer.keep);
      for (const row of answer.keep) version(row.id, row.value);
      return answer;
    },
  };
}

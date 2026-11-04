// The choices kept for tool jobs, and how long. find_tool_for_job keeps the candidates it offered for a job
// (`choice:tool:<32 hex>`, with `<that>:pool` between the find and the run) and which one was run; a job is hardly ever
// asked for again once its work is over, so they only grew. A choice not offered or chosen from for `keep_days` is dropped,
// found by the `tool_choice_at` index of src/record-indexes.json (oldest first, so one seek whatever is kept), a page a
// wake in an alarm pass that already wakes for what is kept for a time (set-aside).
//   toolChoiceKeep({ eeaf, now, rules }) -> { nextAt(), sweep(), due(value), noted() }
//   nextAt()  when the oldest choice ends its time, epoch ms, or null with none; worked out once and kept until a sweep or
//             a choice written when there was none, so an arm that changes nothing reads nothing.
//   sweep()   drops one page of the records past their time (a choice and its pool each hold an entry); answers how many
//             entries it found.
//   due(v)    whether a choice's time should be written again now (offered or chosen from again, a day or more later).
//   noted()   a choice was written.
import settings from './tool-choice-keep.json' with { type: 'json' };

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const TYPE = 'setting';
const INDEX = 'tool_choice_at';
const ID_PREFIX = 'setting:choice:tool:';
const POOL = ':pool';

export function toolChoiceKeep({ eeaf, now = Date.now, rules = settings }) {
  let known;
  let restUntil = 0;
  let built = false;
  // The last entry a sweep passed: every entry before it was dropped or is not a choice of ours, so reads start after it
  // and never walk again the entries a sweep just dropped (on a log store each stays a probe until its pages merge: on
  // the operator's store on 2026-10-14 the seek for the oldest choice read 290,000 rows a wake behind them).
  let passed = null;
  const after = () => (passed ? { after: passed.value, after_id: passed.id } : {});
  // An index built stays built for as long as this store is open, so an arm asks the store once.
  const ready = () => built ||= eeaf.indexReady?.(TYPE, INDEX) === true;
  return {
    nextAt() {
      if (!ready()) return now() + rules.wait_for_index_seconds * 1000;
      if (known === undefined) {
        const oldest = eeaf.scan(TYPE, INDEX, { ...after(), limit: 1 })[0];
        const kept = oldest ? Date.parse(oldest.values?.[0]) : null;
        known = oldest ? (Number.isFinite(kept) ? kept + rules.keep_days * DAY_MS : 0) : null;
      }
      return known === null ? null : Math.max(known, restUntil);
    },
    sweep() {
      if (!ready()) return 0;
      const cutoff = new Date(now() - rules.keep_days * DAY_MS).toISOString();
      const entries = eeaf.scan(TYPE, INDEX, { ...after(), to: cutoff, limit: rules.page });
      const found = entries.map(entry => entry.id);
      const ids = found.filter(id => id.startsWith(ID_PREFIX));
      // A choice goes with its pool; a pool that outlived its choice goes by its own time.
      const dropped = [...new Set(ids.flatMap(id => (id.endsWith(POOL) ? [id] : [id, `${id}${POOL}`])))];
      if (dropped.length) eeaf.write(dropped.map(id => ({ id, type: TYPE, value: null })), { actor: { by: 'trillion' } });
      const last = entries.at(-1);
      if (last) passed = { value: last.values[0], id: last.id };
      known = undefined;
      restUntil = ids.length >= rules.page ? now() + rules.rest_seconds * 1000 : 0;
      return ids.length;
    },
    due: value => !(now() - Date.parse(value?.at) < rules.refresh_hours * HOUR_MS),
    noted() { if (known === null) known = undefined; },
  };
}

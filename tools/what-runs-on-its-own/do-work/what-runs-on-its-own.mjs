// tools/what-runs-on-its-own/do-work/what-runs-on-its-own.mjs
//
// Every cause the person's engine wakes on its own, one row each: what it waits for, its state, its last run and
// its next run, and the switch that turns it off or on. A cause that should have run and did not is red (it failed,
// its answer was lost, it is due with no budget, it is past due and nothing ran it, or the engine never picked it
// up), so a guard that quietly stops shows the moment it stops. Run by the Workshop tool `tool:see-what-runs-on-its-own`:
//
//   node do-work/what-runs-on-its-own.mjs < <the input as JSON>
//
// Input: `now_ms`; `wakes`, the causes the tool rows declare ([{ tool, id, on, budget }], `on` being
// { record: { resource, kind?, prefix? } } | { time: { at_ms } | { every_ms, from_ms? } } | { arrival: { source } });
// `book`, the engine's wake book record as the generic record read gives it (null before the engine first wrote it);
// `stamps`, optional, each watched resource's newest change stamp. The states and their words are DATA
// (read-data/states.json). Prints { result } on its last line. Reads nothing else and keeps nothing.
//
// A wake's mark in the book is found by its key: BLAKE3 of the tool id, a zero byte, the wake id and a zero byte, in
// hex (the engine's own key for a declared wake).
import { text } from 'node:stream/consumers';
import { readFileSync } from 'node:fs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const STATES = JSON.parse(readFileSync(new URL('../read-data/states.json', import.meta.url), 'utf8'));

/** The engine's key for one declared wake: the BLAKE3 hex alone, without the identity's `1f:`. */
export function wakeKey(tool, id) {
  return makeHashCodeHexFromBytes(new TextEncoder().encode(`${tool}\u0000${id}\u0000`)).slice('1f:'.length);
}

/** The milliseconds a change stamp was made at (a stamp is milliseconds shifted 16 bits, plus a counter). */
const stampMs = stamp => Math.floor(Math.max(0, stamp) / 65536);

/** What a wake waits for, in plain words. */
function waitsFor(on) {
  if (on.record) {
    const what = on.record.kind ? `a ${on.record.kind} record` : on.record.prefix ? `a record named ${on.record.prefix}…` : 'any record';
    return `when ${what} changes in ${on.record.resource}`;
  }
  if (on.arrival) return `when ${on.arrival.source} sends something`;
  if (on.time?.every_ms) return `every ${duration(on.time.every_ms)}`;
  if (on.time?.at_ms !== undefined) return `once, at ${new Date(on.time.at_ms).toISOString()}`;
  return 'a cause this screen does not know';
}

function duration(ms) {
  const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000]];
  const [name, size] = units.find(([, size]) => ms % size === 0 && ms >= size) ?? ['millisecond', 1];
  const count = ms / size;
  return count === 1 ? name : `${count} ${name}s`;
}

/** The states that hold for one wake now, with why each holds. */
function holding(wake, mark, live, now, stamps, lateAfter) {
  // An off wake is only off: nothing is due while it is off.
  if (mark?.off) return [['off', 'you turned it off']];
  const held = [];
  if (live) held.push(['running', 'a cause of it is running or waiting to run']);
  if (mark?.outcome === 'failed') held.push(['failed', 'its last run failed']);
  if (mark?.outcome === 'unknown') held.push(['unknown', 'its last run may have happened, and its answer was lost']);
  if (mark?.unfunded_ms !== undefined) held.push(['unfunded', `due since ${new Date(mark.unfunded_ms).toISOString()}; this period's budget is spent`]);
  const due = nextRun(wake, mark);
  if (due !== null && now > due + lateAfter) held.push(['late', `due at ${new Date(due).toISOString()} and nothing ran it`]);
  const resource = wake.on.record?.resource;
  const stamp = resource ? stamps?.[resource] : undefined;
  // Stamps pass 2^53, so they are compared by their milliseconds, which a JSON number holds exactly.
  if (stamp !== undefined && stampMs(stamp) > stampMs(mark?.after ?? 0) && now > stampMs(stamp) + lateAfter) {
    held.push(['late', `${resource} changed at ${new Date(stampMs(stamp)).toISOString()} and nothing read it`]);
  }
  if (!mark && !wake.on.arrival) held.push(['unplaced', 'the engine has not picked it up; if this stays, the engine is not running its causes']);
  held.push(['on', 'waiting for its cause']);
  return held;
}

/** When a wake runs next, when that is a time; null when it waits for a change or an arrival, or never runs again. */
function nextRun(wake, mark) {
  if (wake.on.time?.every_ms) return mark?.next_ms ?? null;
  if (wake.on.time?.at_ms !== undefined) return mark?.done ? null : wake.on.time.at_ms;
  return null;
}

export function seeWhatRunsOnItsOwn(input, states = STATES) {
  const now = input.now_ms;
  if (!Number.isFinite(now)) throw new Error('Send now_ms: the engine\'s time now, in milliseconds.');
  if (!Array.isArray(input.wakes)) throw new Error('Send wakes: the causes the tool rows declare, as [{ tool, id, on, budget }].');
  const book = input.book ?? { marks: {}, live: {} };
  const lateAfter = input.late_after_ms ?? states.late_after_ms;
  const rank = new Map(states.order.map((state, index) => [state, index]));
  const causes = input.wakes.map(wake => {
    if (!wake?.tool || !wake?.id || !wake?.on) throw new Error('Each wake is { tool, id, on, budget }, as its tool row declares it.');
    const mark = book.marks?.[wakeKey(wake.tool, wake.id)];
    const live = Object.values(book.live ?? {}).some(cause => cause.tool === wake.tool && cause.wake === wake.id);
    const held = holding(wake, mark, live, now, input.stamps, lateAfter);
    const [state, why] = held.reduce((best, one) => (rank.get(one[0]) < rank.get(best[0]) ? one : best));
    const shown = states.states[state];
    const off = Boolean(mark?.off);
    return {
      tool: wake.tool,
      id: wake.id,
      waits_for: waitsFor(wake.on),
      state,
      label: shown.label,
      red: shown.red,
      why,
      also: held.filter(([one]) => one !== state && one !== 'on').map(([one, reason]) => ({ state: one, why: reason })),
      last_run_ms: mark?.ran_ms ?? null,
      last_outcome: mark?.outcome ?? null,
      next_run_ms: nextRun(wake, mark),
      switch: { tool: wake.tool, id: wake.id, on: !off, turn: off ? 'on' : 'off', label: off ? 'Turn on' : 'Turn off' },
    };
  });
  causes.sort((a, b) => Number(b.red) - Number(a.red) || a.tool.localeCompare(b.tool) || a.id.localeCompare(b.id));
  return {
    causes,
    red: causes.filter(cause => cause.red).length,
    on: causes.filter(cause => cause.switch.on).length,
    off: causes.filter(cause => !cause.switch.on).length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: seeWhatRunsOnItsOwn(input) }));
}

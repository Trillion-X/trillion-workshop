// tools/what-runs-on-its-own/do-work/what-runs-on-its-own.mjs
//
// Every cause the person's engine wakes on its own, one row each: what it waits for, its state, its last run, and
// the switch that turns it off or on. A cause that should have run and did not is red (its last run failed, its
// answer was lost, a fact came with no budget left to run it, or a kept-running program the engine never started),
// so a guard that quietly stops shows the moment it stops. Run by the Workshop tool `tool:see-what-runs-on-its-own`:
//
//   node do-work/what-runs-on-its-own.mjs < <the input as JSON>
//
// Input: `wakes`, the rows `wake:list` answers ([{ tool, id, on, budget, switched_on, mark }], `on` being
// { fact: { kind, from, match?, watch? } } | { running: {} }). The states and their words are DATA
// (read-data/states.json). Prints { result } on its last line. Reads nothing else and keeps nothing.
import { text } from 'node:stream/consumers';
import { readFileSync } from 'node:fs';

const STATES = JSON.parse(readFileSync(new URL('../read-data/states.json', import.meta.url), 'utf8'));
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** One schedule a fact wake watches, in plain words: "every day at 14:00 UTC". */
function scheduleWords(schedule) {
  const { unit, interval = 1, weekdays } = schedule.cadence ?? {};
  const every = interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
  const days = Array.isArray(weekdays) && weekdays.length ? ` on ${weekdays.map(day => WEEKDAYS[day % 7]).join(', ')}` : '';
  const at = schedule.local_window?.start && unit !== 'hour' ? ` at ${schedule.local_window.start}` : '';
  return `${every}${days}${at}${schedule.timezone ? ` ${schedule.timezone}` : ''}`;
}

/** What a wake waits for, in plain words. */
function waitsFor(on) {
  if (on.running) return 'kept running, started again if it stops';
  if (on.fact) {
    const schedules = on.fact.watch?.schedules ?? [];
    if (schedules.length) return schedules.map(scheduleWords).join('; ');
    const match = Object.entries(on.fact.match ?? {}).map(([field, value]) => `${field} ${value}`).join(', ');
    return `when ${(on.fact.from ?? []).join(' or ')} tells ${on.fact.kind}${match ? ` (${match})` : ''}`;
  }
  return 'a cause this screen does not know';
}

/** The states that hold for one wake now, with why each holds. */
function holding(wake) {
  const mark = wake.mark ?? {};
  // An off wake is only off: nothing runs while it is off.
  if (!wake.switched_on) return [['off', 'it is switched off']];
  const held = [];
  if (mark.running || mark.fired_ms > (mark.ran_ms ?? 0)) held.push(['running', 'a cause of it is running or waiting to run']);
  if (mark.outcome === 'failed') held.push(['failed', `its last run failed${mark.outcome_cause ? `: ${mark.outcome_cause}` : ''}`]);
  if (mark.outcome === 'unknown') held.push(['unknown', 'its last run may have happened, and its answer was lost']);
  if (mark.unfunded_ms !== undefined) held.push(['unfunded', `a fact came at ${new Date(mark.unfunded_ms).toISOString()} with this period's budget spent`]);
  // A fact wake has no mark until its first fact, so no mark is not a fault; a kept-running one is started at once.
  if (wake.on.running && !mark.running) held.push(['unplaced', 'the engine has not started its program; if this stays, the engine is not running its causes']);
  held.push(['on', 'waiting for its cause']);
  return held;
}

export function seeWhatRunsOnItsOwn(input, states = STATES) {
  if (!Array.isArray(input.wakes)) throw new Error('Send wakes: the rows wake:list answers, [{ tool, id, on, switched_on, mark }].');
  const rank = new Map(states.order.map((state, index) => [state, index]));
  const causes = input.wakes.map(wake => {
    if (!wake?.tool || !wake?.id || !wake?.on) throw new Error('Each wake is a wake:list row: { tool, id, on, switched_on, mark }.');
    const held = holding(wake);
    const [state, why] = held.reduce((best, one) => (rank.get(one[0]) < rank.get(best[0]) ? one : best));
    const shown = states.states[state];
    const on = Boolean(wake.switched_on);
    return {
      tool: wake.tool,
      id: wake.id,
      waits_for: waitsFor(wake.on),
      state,
      label: shown.label,
      red: shown.red,
      why,
      also: held.filter(([one]) => one !== state && one !== 'on').map(([one, reason]) => ({ state: one, why: reason })),
      last_run_ms: wake.mark?.ran_ms ?? null,
      last_outcome: wake.mark?.outcome ?? null,
      switch: { tool: wake.tool, id: wake.id, on, turn: on ? 'off' : 'on', label: on ? 'Turn off' : 'Turn on' },
    };
  });
  causes.sort((a, b) => Number(b.red) - Number(a.red) || Number(b.switch.on) - Number(a.switch.on) || a.tool.localeCompare(b.tool) || a.id.localeCompare(b.id));
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

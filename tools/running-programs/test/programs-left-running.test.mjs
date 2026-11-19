// workflow:stop-programs-left-running (tools/workflows/recipes/stop-programs-left-running.json) run on the workflow engine
// with made-up programs: the list, the rule rows and the store are pretend, and the choosing and stopping are the real
// tool:choose-programs-left-running and tool:stop-programs-left-running with a pretend signal, so no real program is
// touched. Then each tool's own refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';
import { chooseProgramsLeftRunning, stopProgramsLeftRunning } from '../do-work/programs-left-running.mjs';

const recipe = JSON.parse(readFileSync(new URL('../../workflows/recipes/stop-programs-left-running.json', import.meta.url), 'utf8')).records[0].payload;
const [wake] = recipe.wakes;
const NOW = Date.UTC(2026, 10, 19, 12, 50);
const HOUR = 3_600_000;

// One program: by default a shell its session left behind three hours ago, busy the whole time.
const program = (pid, fields = {}) => ({ pid, name: 'sh', footprint_bytes: 1, resident_bytes: 1, parent_pid: 1, session_id: pid,
  started_at_ms: NOW - 3 * HOUR, cpu_ms: 3 * HOUR * 0.99, command: '/bin/sh -c while true; do run-tests; done', ...fields });
const LEFT_BEHIND = [{ id: 'busy-shell-left-behind', why: 'A shell a closed session left behind, still busy', parent_pid: 1,
  session_owner_gone: true, older_than_minutes: 60, cpu_share_at_least: 0.5, command_pattern: '^/bin/sh -c ' }];
const NEVER_STOP = [{ id: 'the-model-proxy', why: 'Every AI session talks through it', command_pattern: 'model-proxy' }];

/** One sweep on the engine: every tool the recipe asks answered by a pretend door; returns the run, the signals sent and
 *  each tool call. `rules` is what the store holds for each rule type (null: no row of that type). */
async function sweep(programs, { rules = { 'program-left-behind-rule': LEFT_BEHIND, 'program-never-stop-rule': NEVER_STOP }, complete = true } = {}) {
  const running = new Map(programs.map(one => [one.pid, one]));
  const signals = [], calls = [], kept = [];
  const stopDeps = {
    read: async () => [...running.values()],
    signal: (pid, name) => { signals.push([pid, name]); running.delete(pid); },
    alive: pid => running.has(pid), now: () => NOW, sleep: async () => {},
  };
  const tools = {
    'tool:list-running-programs': () => ({ total: running.size, programs: [...running.values()], complete }),
    'tool:run-sql-in-my-database': input => {
      if (input.sql.startsWith('insert')) { kept.push(input.params); return { columns: [], rows: [], row_count: 1 }; }
      return { columns: ['rules'], rows: [{ rules: rules[input.params[0]] ?? null }], row_count: 1 };
    },
    'tool:choose-programs-left-running': input => chooseProgramsLeftRunning(input, {}, { now: () => NOW, self: [] }),
    'tool:stop-programs-left-running': input => stopProgramsLeftRunning(input, {}, stopDeps),
    'tool:tell-the-person': input => ({ told: true, said: input.title }),
  };
  const door = {
    async run(name, input) {
      calls.push(name);
      // A tool that ran and failed fails the run, as the person's door answers it.
      try { return await tools[name](input); } catch (error) { throw Object.assign(error, { outcome: 'committed' }); }
    },
  };
  const run = await runWorkflow({ recipe, input: wake.input }, { door });
  return { run, signals, calls, kept, told: calls.filter(name => name === 'tool:tell-the-person').length };
}

test('the recipe wakes every ten minutes at its first step, names no program, and holds the rights of exactly the tools it asks', () => {
  assert.deepEqual(wake.on, { time: { every_ms: 600_000 } });
  assert.equal(wake.input.start_at, recipe.definition.steps[0].id);
  assert.deepEqual(recipe.records.runs, ['tool:choose-programs-left-running', 'tool:list-running-programs', 'tool:run-sql-in-my-database', 'tool:stop-programs-left-running', 'tool:tell-the-person']);
  const definition = JSON.stringify(recipe.definition);
  assert.doesNotMatch(definition, /_pattern|parent_pid|older_than/, 'every judgment is a row the person keeps, read at every sweep');
  assert.match(definition, /program-left-behind-rule/);
  assert.match(definition, /program-never-stop-rule/);
});

test('a program the left-behind rows describe is asked to end, kept as one row and told once', async () => {
  const { run, signals, kept, told } = await sweep([program(4242)]);
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  assert.equal(kept.length, 1);
  const [address, row] = kept[0];
  assert.equal(address, `program-stopped:4242:${NOW - 3 * HOUR}`);
  assert.deepEqual([row.rule, row.why, row.outcome, row.asked_at, row.ended_at], ['busy-shell-left-behind', LEFT_BEHIND[0].why, 'ended', new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
  assert.equal(told, 1);
});

test('a program a never-stop row names is kept, and nothing is told', async () => {
  const { run, signals, kept, told } = await sweep([program(4243, { command: '/bin/sh -c exec model-proxy --port 1' })]);
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual([signals, kept, told], [[], [], 0]);
});

test('a program with a live parent, or whose session still has an owner, is kept whatever the rows say', async () => {
  const withParent = await sweep([program(77, { parent_pid: 70, name: 'terminal', command: 'terminal' }), program(4250, { parent_pid: 77, session_id: 77 })]);
  assert.equal(withParent.run.status, 'completed', withParent.run.error_message);
  assert.deepEqual(withParent.signals, [], 'its parent is alive');
  const { parent_pid: _anyParent, ...bySession } = LEFT_BEHIND[0];
  const rules = { 'program-left-behind-rule': [{ ...bySession, id: 'busy-shell-whose-session-ended' }], 'program-never-stop-rule': NEVER_STOP };
  const owner = program(500, { parent_pid: 77, name: 'terminal', command: 'terminal' });
  const child = program(4244, { session_id: 500 });
  assert.deepEqual((await sweep([owner, child], { rules })).signals, [], 'its session leader still has a live parent');
  assert.deepEqual((await sweep([child], { rules })).signals, [[4244, 'SIGTERM']], 'the same program is stopped once its session leader is gone from a complete list');
  assert.deepEqual((await sweep([child], { rules, complete: false })).signals, [], 'a list cut short cannot show that the session ended');
});

test('a store with no never-stop row refuses the sweep before anything is stopped', async () => {
  const { run, signals, calls } = await sweep([program(4245)], { rules: { 'program-left-behind-rule': LEFT_BEHIND } });
  assert.equal(run.status, 'failed');
  assert.match(run.error_message, /never-stop list was not given/);
  assert.deepEqual(signals, []);
  assert.ok(!calls.includes('tool:stop-programs-left-running'));
});

test('a young program and an idle one are kept', async () => {
  const young = program(4246, { started_at_ms: NOW - 10 * 60_000, cpu_ms: 10 * 60_000 });
  const idle = program(4247, { cpu_ms: 60_000 });
  const { run, signals, told } = await sweep([young, idle]);
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual([signals, told], [[], 0]);
});

test('choosing refuses a list not given, a misspelt condition, and a left-behind row with no pattern; an empty list given is said', () => {
  const given = { programs: [program(1)], complete: true, left_behind: LEFT_BEHIND, never_stop: NEVER_STOP };
  assert.throws(() => chooseProgramsLeftRunning({ ...given, never_stop: undefined }), /never-stop list was not given/);
  assert.throws(() => chooseProgramsLeftRunning({ ...given, left_behind: null }), /left-behind list was not given/);
  assert.throws(() => chooseProgramsLeftRunning({ ...given, never_stop: [{ id: 'x', why: 'y', comand_pattern: 'z' }] }), /holds comand_pattern, which a never_stop row may not hold/);
  assert.throws(() => chooseProgramsLeftRunning({ ...given, left_behind: [{ id: 'x', why: 'y', parent_pid: 1, older_than_minutes: 5 }] }), /must name a command_pattern, a name_pattern, or both/);
  assert.throws(() => chooseProgramsLeftRunning({ ...given, complete: undefined }), /complete/);
  const none = chooseProgramsLeftRunning({ ...given, never_stop: [] }, {}, { now: () => NOW, self: [] });
  assert.match(none.said, /0 never-stop rules \(the person keeps none\)/);
});

test('choosing keeps the system\'s first process, the run itself, and a program whose command a pattern needs could not be read', () => {
  const given = { complete: true, left_behind: LEFT_BEHIND, never_stop: NEVER_STOP };
  const first = program(1);
  const self = program(4248);
  const unread = program(4249, { command: null });
  const { picked } = chooseProgramsLeftRunning({ ...given, programs: [first, self, unread] }, {}, { now: () => NOW, self: [4248] });
  assert.deepEqual(picked, []);
});

test('stopping asks only the same program, forces nothing, and says what happened to each', async () => {
  const chosen = [{ pid: 10, started_at_ms: 100 }, { pid: 11, started_at_ms: 100 }, { pid: 12, started_at_ms: 100 }];
  const running = [{ pid: 10, started_at_ms: 100 }, { pid: 11, started_at_ms: 999 }];
  const signals = [];
  let clock = 0;
  const { stops, notices } = await stopProgramsLeftRunning({ programs: chosen, grace_ms: 1000 }, {}, {
    read: async () => running, signal: (pid, name) => signals.push([pid, name]), alive: () => true,
    now: () => clock, sleep: async ms => { clock += ms; },
  });
  assert.deepEqual(signals, [[10, 'SIGTERM']], 'a reused process id is not asked, and nothing is forced');
  assert.deepEqual(stops.map(stop => [stop.pid, stop.outcome]), [[10, 'still-running'], [11, 'not-the-same-program'], [12, 'already-gone']]);
  assert.deepEqual(notices, [], 'no notice when nothing ended');
  await assert.rejects(stopProgramsLeftRunning({ programs: [{ pid: 1, started_at_ms: 1 }] }), /needs the pid and started_at_ms/);
  await assert.rejects(stopProgramsLeftRunning({ programs: [], grace_ms: 120_000 }), /grace_ms from 0 to 60000/);
});

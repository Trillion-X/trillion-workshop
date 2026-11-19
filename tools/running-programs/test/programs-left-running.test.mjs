// workflow:stop-programs-left-running (tools/workflows/recipes/stop-programs-left-running.json) run on the workflow engine
// with made-up programs and a pretend signal, so no real program is touched. The store is an empty PostgreSQL database
// (PGlite) that the recipe's own SQL runs on, as tool:run-sql-in-my-database would run it; the choosing and stopping are the
// real tool:choose-programs-left-running and tool:stop-programs-left-running. Then each tool's own refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
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

const stepSql = id => recipe.definition.steps.find(step => step.id === id).config.input.sql;
/** The person's rules kept as program_rules rows: { <kind>: [rule] }. The tables are made by the recipe's own first steps. */
async function keepRules(db, rules) {
  for (const id of ['make-rules-table', 'make-stops-table']) await db.query(stepSql(id));
  for (const [kind, list] of Object.entries(rules)) {
    for (const rule of list) await db.query('insert into program_rules (id, kind, rule) values ($1, $2, $3)', [`${kind}:${rule.id}`, kind, JSON.stringify(rule)]);
  }
}

/** One sweep on the engine: every tool the recipe asks answered by a pretend door, the store's SQL run on `db` (a new
 *  database holding `rules` when none is given); returns the run, the signals sent, each tool call and the kept stops. */
async function sweep(programs, { rules = { 'left-behind': LEFT_BEHIND, 'never-stop': NEVER_STOP }, complete = true, db = null } = {}) {
  if (!db) { db = new PGlite(); await keepRules(db, rules); }
  const running = new Map(programs.map(one => [one.pid, one]));
  const signals = [], calls = [];
  const stopDeps = {
    read: async () => [...running.values()],
    signal: (pid, name) => { signals.push([pid, name]); running.delete(pid); },
    alive: pid => running.has(pid), now: () => NOW, sleep: async () => {},
  };
  const tools = {
    'tool:list-running-programs': () => ({ total: running.size, programs: [...running.values()], complete }),
    // As node-postgres sends them: an object is sent as its JSON text.
    'tool:run-sql-in-my-database': async input => {
      const params = (input.params ?? []).map(value => (value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value));
      const result = await db.query(input.sql, params);
      return { columns: result.fields.map(field => field.name), rows: result.rows, row_count: result.affectedRows ?? result.rows.length };
    },
    'tool:choose-programs-left-running': input => chooseProgramsLeftRunning(input, {}, { now: () => NOW, self: [] }),
    'tool:stop-programs-left-running': input => stopProgramsLeftRunning(input, {}, stopDeps),
  };
  const door = {
    async run(name, input) {
      calls.push(name);
      // A tool that ran and failed fails the run, as the run's host actions answer it (tool_run_failed, committed).
      try { return await tools[name](input); } catch (error) { throw Object.assign(error, { outcome: 'committed' }); }
    },
  };
  const run = await runWorkflow({ recipe, input: wake.input }, door);
  const kept = (await db.query('select address, stop from program_stops order by address')).rows.map(row => [row.address, row.stop]);
  // Told is what the person's store keeps: one told_the_person row per notice, the table workflow:read-my-notices reads.
  const notices = await db.query("select 1 from information_schema.tables where table_name = 'told_the_person'");
  const told = notices.rows.length ? (await db.query('select count(*)::int as n from told_the_person')).rows[0].n : 0;
  return { run, signals, calls, kept, told };
}

test('the recipe wakes every ten minutes at its first step, names no program, and holds the rights of exactly the tools it asks', () => {
  // The engine keeps no clock: the ten minutes are a due-time schedule the noticer tells as a fact.
  assert.deepEqual(wake.on.fact.watch.schedules[0].cadence, { unit: 'minute', interval: 10 });
  assert.equal(wake.on.fact.match.schedule_id, wake.on.fact.watch.schedules[0].schedule_id);
  assert.equal(wake.input.start_at, recipe.definition.steps[0].id);
  assert.deepEqual(recipe.records.runs, ['tool:choose-programs-left-running', 'tool:list-running-programs', 'tool:run-sql-in-my-database', 'tool:stop-programs-left-running']);
  const definition = JSON.stringify(recipe.definition);
  assert.doesNotMatch(definition, /_pattern|parent_pid|older_than/, 'every judgment is a row the person keeps, read at every sweep');
  assert.match(definition, /create table if not exists program_rules/);
  assert.match(definition, /create table if not exists program_stops/);
});

test('a program the left-behind rows describe is asked to end, kept as one row and told once', async () => {
  const { run, signals, kept, told } = await sweep([program(4242)]);
  assert.equal(run.status, 'completed', run.error_message ?? JSON.stringify(run.waiting));
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  assert.equal(kept.length, 1);
  const [address, row] = kept[0];
  assert.equal(address, `program-stopped:4242:${NOW - 3 * HOUR}`);
  assert.deepEqual([row.rule, row.why, row.outcome, row.asked_at, row.ended_at], ['busy-shell-left-behind', LEFT_BEHIND[0].why, 'ended', new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
  assert.equal(told, 1);
});

test('a program a never-stop row names is kept, and nothing is told', async () => {
  const { run, signals, kept, told } = await sweep([program(4243, { command: '/bin/sh -c exec model-proxy --port 1' })]);
  assert.equal(run.status, 'completed', run.error_message ?? JSON.stringify(run.waiting));
  assert.deepEqual([signals, kept, told], [[], [], 0]);
});

test('a program with a live parent, or whose session still has an owner, is kept whatever the rows say', async () => {
  const withParent = await sweep([program(77, { parent_pid: 70, name: 'terminal', command: 'terminal' }), program(4250, { parent_pid: 77, session_id: 77 })]);
  assert.equal(withParent.run.status, 'completed', withParent.run.error_message);
  assert.deepEqual(withParent.signals, [], 'its parent is alive');
  const { parent_pid: _anyParent, ...bySession } = LEFT_BEHIND[0];
  const rules = { 'left-behind': [{ ...bySession, id: 'busy-shell-whose-session-ended' }], 'never-stop': NEVER_STOP };
  const owner = program(500, { parent_pid: 77, name: 'terminal', command: 'terminal' });
  const child = program(4244, { session_id: 500 });
  assert.deepEqual((await sweep([owner, child], { rules })).signals, [], 'its session leader still has a live parent');
  assert.deepEqual((await sweep([child], { rules })).signals, [[4244, 'SIGTERM']], 'the same program is stopped once its session leader is gone from a complete list');
  assert.deepEqual((await sweep([child], { rules, complete: false })).signals, [], 'a list cut short cannot show that the session ended');
});

test('a store with no never-stop row refuses the sweep before anything is stopped', async () => {
  const { run, signals, calls } = await sweep([program(4245)], { rules: { 'left-behind': LEFT_BEHIND } });
  assert.equal(run.status, 'failed');
  assert.match(run.error_message, /never-stop list was not given/);
  assert.deepEqual(signals, []);
  assert.ok(!calls.includes('tool:stop-programs-left-running'));
});

test('from an empty database the first sweep makes its tables and refuses with no never-stop row, then works once rows are kept', async () => {
  const db = new PGlite();
  const first = await sweep([program(4251)], { db });
  assert.equal(first.run.status, 'failed');
  assert.match(first.run.error_message, /never-stop list was not given/);
  assert.deepEqual(first.signals, []);
  const tables = (await db.query("select table_name from information_schema.tables where table_name like 'program_%' order by table_name")).rows.map(row => row.table_name);
  assert.deepEqual(tables, ['program_rules', 'program_stops']);
  await keepRules(db, { 'left-behind': LEFT_BEHIND, 'never-stop': NEVER_STOP });
  const second = await sweep([program(4251)], { db });
  assert.equal(second.run.status, 'completed', second.run.error_message);
  assert.deepEqual(second.signals, [[4251, 'SIGTERM']]);
  assert.equal(second.kept.length, 1);
  const again = await sweep([], { db });
  assert.equal(again.run.status, 'completed', 'making the tables again changes nothing');
  assert.equal(again.kept.length, 1);
});

test('a young program and an idle one are kept', async () => {
  const young = program(4246, { started_at_ms: NOW - 10 * 60_000, cpu_ms: 10 * 60_000 });
  const idle = program(4247, { cpu_ms: 60_000 });
  const { run, signals, told } = await sweep([young, idle]);
  assert.equal(run.status, 'completed', run.error_message ?? JSON.stringify(run.waiting));
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

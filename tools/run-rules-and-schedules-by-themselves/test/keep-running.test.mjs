// test/keep-running.test.mjs: started things keep going by themselves (src/keep-running.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_RUNNING, inTurns, makeKeepRunning, stoppedThings } from '../src/keep-running.mjs';

const T0 = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 3600000;

function harness({ held = [], schedules = [], runs = [], owed = [], refused = [], waiting = [], unowned = [], unclassified = [], askAgain = null, resume = null, ends = {}, idleAt = null, saved = null, code = null, tellFailures = 0, tellCommitsThenFails = 0 } = {}) {
  let fact = saved;
  let clock = T0;
  let nextIdle = idleAt;
  const did = { asked_again: [], released: [], ran: [], admitted: [], resumed: [], handed: [], told: [], repeated: [], fact_reads: 0, idle_reads: 0, things_writes: 0, clock_writes: 0 };
  const world = { held, schedules, runs, owed, refused, waiting, unowned, unclassified, ended: new Set(), watch: null, tellFailures, tellCommitsThenFails };
  const createKeeper = () => makeKeepRunning({
    code,
    now: () => clock,
    read: {
      idleNext: async () => { did.idle_reads += 1; return nextIdle; },
      held: async () => world.held,
      schedules: async () => world.schedules,
      runs: async watch => { world.watch = watch; return world.runs; },
      failedRunPending: async watch => world.runs.some(run => run.state === 'failed' && !run.withdrawal
        && !watch.skip({ at: run.card_at, card: { run_id: run.run_id, state: run.state, recoverable: true } })),
      // As the store answers it: a job is on until it is finished.
      jobOpen: id => !world.ended.has(id),
      owed: async () => world.owed,
      refused: async () => world.refused,
      unowned: async () => world.unowned,
      unclassified: async () => world.unclassified,
      // As the store reads it: the person's own work handed before `before` that no AI holds.
      waiting: async before => world.waiting.filter(item => Date.parse(item.handed_at) < before),
      runEnd: async started => ends[started.task_id ?? started.run_id] ?? { state: 'finished' },
    },
    act: {
      release: async key => { did.released.push(key); },
      runNow: async id => { did.ran.push(id); },
      admit: async run_id => { did.admitted.push(run_id); },
      resume: async run_id => { did.resumed.push(run_id); return resume?.(run_id, world); },
      askAgain: async message_id => { did.asked_again.push(message_id); if (askAgain) return askAgain(message_id); return { asked: true }; },
      // As agents.handOff does: the same once_per is the job already handed.
      handOff: async input => {
        const earlier = did.handed.findIndex(one => one.once_per === input.once_per);
        if (earlier !== -1) { did.repeated.push(input); return { handoff: { handoff_id: `h_${earlier + 1}` }, repeated: true }; }
        did.handed.push(input); return { handoff: { handoff_id: `h_${did.handed.length}` } };
      },
      // As tell-the-person does: one notice per key.
      tell: async input => {
        if (world.tellFailures > 0) { world.tellFailures -= 1; throw new Error('notice store busy'); }
        if (!did.told.some(one => one.key === input.key)) did.told.push(input);
        if (world.tellCommitsThenFails > 0) { world.tellCommitsThenFails -= 1; throw new Error('notice response lost after commit'); }
        return { told: true };
      },
    },
    watched: { read: () => { did.fact_reads += 1; return fact?.things ?? null; }, write: value => { fact = { ...fact, things: structuredClone(value) }; did.things_writes += 1; } },
    clock: { read: () => fact?.clock ?? null, write: value => { fact = { ...fact, clock: structuredClone(value) }; did.clock_writes += 1; } },
  });
  let keeper = createKeeper();
  return { get keeper() { return keeper; }, reopen: () => { keeper = createKeeper(); return keeper; }, did, world, fact: () => fact, setIdleAt: at => { nextIdle = at; }, tick: ms => { clock += ms; } };
}

test('a held timed job is released once, then handed to an AI and the person told when it stops again', async () => {
  const entry = { key: 'event-reads|gmail', held: true, failures: 6, error: 'token expired' };
  const h = harness({ held: [entry] });
  const first = await h.keeper.sweep();
  assert.deepEqual(h.did.released, ['event-reads|gmail']);
  assert.equal(first.restarted.length, 1);
  assert.equal(h.did.handed.length, 0);

  // Released, it runs fine for a sweep, then is held again within the remembered window.
  h.world.held = [];
  h.tick(HOUR);
  await h.keeper.sweep();
  h.world.held = [entry];
  h.tick(HOUR);
  const third = await h.keeper.sweep();
  assert.equal(h.did.released.length, 1, 'never restarted forever');
  assert.equal(third.handed_off.length, 1);
  assert.match(h.did.handed[0].job, /token expired/);
  assert.equal(h.did.told[0].kind, KEEP_RUNNING.notice_kind);

  // The same stop is handed off once.
  h.tick(HOUR);
  const fourth = await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1);
  assert.deepEqual(fourth.still_stopped, ['held:event-reads|gmail']);
});

test('a schedule whose last run failed is run now, and a workflow waiting on an AI step is read, then goes to an AI when still stopped', async () => {
  const h = harness({
    schedules: [{ schedule_id: 'weekly-post', label: 'Weekly post', enabled: true, last_run: { at: '2026-10-03T09:00:00Z', task_id: 't1' } }],
    ends: { t1: { state: 'failed', error: 'no approved post' } },
    runs: [{ run_id: 'r1', recipe: { id: 'workflow:plan', label: 'Plan' }, state: 'working', started_at: new Date(T0 - 8 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'research', title: 'Research' }] }],
  });
  const result = await h.keeper.sweep();
  assert.deepEqual(h.did.ran, ['weekly-post']);
  assert.deepEqual(h.did.admitted, ['r1'], 'the run is read first, which admits anything its step already handed back');
  assert.equal(h.did.handed.length, 0);
  assert.equal(result.stopped, 2);
  h.tick(HOUR);
  await h.keeper.sweep();
  const workflowJobs = h.did.handed.filter(one => one.input.keep_running.kind === 'workflow_stalled');
  assert.equal(workflowJobs.length, 1, 'still stopped after it was read, so an AI has it');
  assert.match(workflowJobs[0].job, /submit_workflow_step/);
});

test('nothing is acted on for what is moving, and a fresh workflow run is not called stopped', () => {
  const found = stoppedThings({
    now: T0,
    held: [{ key: 'a', held: false, failures: 2 }],
    schedules: [{ schedule_id: 's', enabled: true, next_run_at: new Date(T0 + HOUR).toISOString(), last_run: { at: '2026-10-03T11:00:00Z' } }],
    runs: [{ run_id: 'r', state: 'working', started_at: new Date(T0 - HOUR).toISOString(), done: {}, waiting: [{ step_id: 'x' }] }],
  });
  assert.deepEqual(found, []);
});

test('a schedule past its time by more than the grace is late; empty accounts ask for no alarm', async () => {
  const late = stoppedThings({ now: T0, schedules: [{ schedule_id: 's', label: 'Morning brief', enabled: true, next_run_at: new Date(T0 - 3 * HOUR).toISOString() }] });
  assert.equal(late[0].kind, 'schedule_late');

  // A schedule alone is looked at when the store's owners say it could have stopped (idleNext), never by the hour.
  const busy = harness({ schedules: [{ schedule_id: 's', enabled: true, next_run_at: new Date(T0 + HOUR).toISOString() }], idleAt: T0 + HOUR + KEEP_RUNNING.late_schedule_grace_minutes * 60000 });
  assert.equal(await busy.keeper.nextAt(), T0 + HOUR + KEEP_RUNNING.late_schedule_grace_minutes * 60000);
  await busy.keeper.sweep();
  assert.equal(await busy.keeper.nextAt(), T0 + HOUR + KEEP_RUNNING.late_schedule_grace_minutes * 60000);

  const idle = harness();
  assert.equal(await idle.keeper.nextAt(), null, 'even the first empty account has no automatic wake');
  await idle.keeper.sweep();
  assert.equal(await idle.keeper.nextAt(), null);
});

test('repeated alarm checks read the watched fact once per store instance and see a sweep write', async () => {
  const h = harness();
  for (let i = 0; i < 100; i += 1) assert.equal(await h.keeper.nextAt(), null);
  assert.equal(h.did.fact_reads, 1);
  assert.equal(h.did.idle_reads, 1, 'an unchanged idle store does not scan its owners again');
  await h.keeper.sweep();
  for (let i = 0; i < 100; i += 1) assert.equal(await h.keeper.nextAt(), null);
  assert.equal(h.did.fact_reads, 1, 'the sweep updates the snapshot used by later alarms');
  assert.equal(h.did.idle_reads, 1, 'a sweep that changed nothing keeps the cached idle answer; an owner write refreshes it');
  h.world.schedules.push({ schedule_id: 'one', enabled: true, next_run_at: new Date(T0 + HOUR).toISOString() });
  h.setIdleAt(T0);
  h.keeper.invalidate();
  assert.equal(await h.keeper.nextAt(), T0, 'a new write supplies a due time after an idle sweep');
  h.setIdleAt(T0 + 3 * HOUR);
  await h.keeper.sweep();
  assert.equal(await h.keeper.nextAt(), T0 + 3 * HOUR, 'a schedule keeps its own time after the sweep, never an hourly one');
  assert.equal(h.did.fact_reads, 1);
});

test('an idle answer a sweep already passed is read again, and an owner that keeps naming a passed time waits an hour, never a second', async () => {
  // Found 2026-10-06: a woken store kept the idle answer it had cached, already past, swept, and was due again a second
  // later, all day.
  const h = harness({ idleAt: T0 - HOUR });
  assert.equal(await h.keeper.nextAt(), T0 - HOUR);
  h.setIdleAt(T0 + 2 * HOUR);
  await h.keeper.sweep();
  assert.equal(await h.keeper.nextAt(), T0 + 2 * HOUR, 'the spent answer is dropped and read again');
  const stuck = harness({ idleAt: T0 - 60000 });
  await stuck.keeper.sweep();
  assert.equal(await stuck.keeper.nextAt(), T0 + KEEP_RUNNING.every_minutes * 60000, 'an owner still naming a time the sweep passed is swept again an hour later');
  const reads = stuck.did.idle_reads;
  for (let i = 0; i < 50; i += 1) await stuck.keeper.nextAt();
  assert.equal(stuck.did.idle_reads, reads, 'and its answer is not read again on every alarm check');
});

test('a sweep that finds the same stopped things writes only its time, never the list again, and a woken store waits an hour from it', async () => {
  const entry = { key: 'event-reads|gmail', held: true, failures: 6, error: 'token expired' };
  const h = harness({ held: [entry] });
  await h.keeper.sweep();
  const written = h.did.things_writes;
  const clockWrites = h.did.clock_writes;
  for (let i = 0; i < 24; i += 1) { h.tick(HOUR); await h.keeper.sweep(); }
  assert.ok(h.did.things_writes - written <= 2, `the stopped things were written ${h.did.things_writes - written} times in 24 unchanged sweeps`);
  assert.equal(h.did.clock_writes - clockWrites, 24, 'a store that is watching something keeps each sweep\'s time, one small write a sweep');
  assert.equal(await h.keeper.nextAt(), T0 + 24 * HOUR + KEEP_RUNNING.every_minutes * 60000);
  // Found 2026-10-08: the time was kept in memory only, so every restart of the object swept at once, and each sweep
  // handed another five of the old backlog.
  const woken = harness({ held: [entry], saved: h.fact() });
  assert.equal(await woken.keeper.nextAt(), T0 + 24 * HOUR + KEEP_RUNNING.every_minutes * 60000, 'a store that wakes sweeps an hour after its last sweep, not at once');
  const idle = harness();
  await idle.keeper.sweep();
  await idle.keeper.sweep();
  assert.equal(idle.did.clock_writes, 0, 'an idle store keeps its sweep time in memory only');
});

test('a new store instance recomputes pending work after hibernation', async () => {
  const before = harness();
  await before.keeper.sweep();
  assert.equal(await before.keeper.nextAt(), null);
  const unchanged = harness({ saved: before.fact(), idleAt: T0 + HOUR });
  assert.equal(await unchanged.keeper.nextAt(), null, 'the persisted empty answer avoids a scan on an unchanged wake');
  assert.equal(unchanged.did.idle_reads, 0);
  const upgraded = harness({ saved: before.fact(), idleAt: T0 + HOUR, code: 'new-code' });
  assert.equal(await upgraded.keeper.nextAt(), T0 + HOUR, 'new code rechecks an earlier empty answer');
  before.keeper.invalidate();
  const after = harness({ saved: before.fact(), idleAt: T0 + HOUR });
  assert.equal(await after.keeper.nextAt(), T0 + HOUR);
  assert.equal(after.did.fact_reads, 1);
  assert.equal(after.did.idle_reads, 1);
});

test('a hand-off that fails is kept and tried on the next sweep', async () => {
  const runs = [{ run_id: 'r', state: 'working', started_at: new Date(T0 - 7 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'x' }] }];
  let refuse = true;
  const fact = { value: null, clock: null };
  const keeper = makeKeepRunning({
    now: () => T0,
    read: { held: async () => [], schedules: async () => [], runs: async () => runs, runEnd: async () => null },
    act: { release: async () => {}, runNow: async () => {}, admit: async () => {}, tell: async () => ({}), handOff: async () => { if (refuse) throw new Error('store busy'); return { handoff: { handoff_id: 'h1' } }; } },
    watched: { read: () => fact.value, write: value => { fact.value = structuredClone(value); } },
    clock: { read: () => fact.clock, write: value => { fact.clock = structuredClone(value); } },
  });
  assert.equal((await keeper.sweep()).restarted.length, 1, 'read first');
  const first = await keeper.sweep();
  assert.equal(first.problems[0].problem, 'store busy');
  refuse = false;
  const second = await keeper.sweep();
  assert.equal(second.handed_off[0].handoff_id, 'h1');
});

test('a failed person notice is retried for the same handoff until it is delivered', async () => {
  const run = { run_id: 'r-notice', recipe: { id: 'workflow:plan' }, state: 'working', started_at: new Date(T0 - 8 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'research' }] };
  const h = harness({ runs: [run], tellFailures: 1 });
  await h.keeper.sweep();
  const failedNotice = await h.keeper.sweep();
  assert.equal(failedNotice.handed_off.length, 1);
  assert.match(failedNotice.problems[0].problem, /notice store busy/);
  assert.equal(h.did.handed.length, 1);
  assert.equal(h.fact().things.things['workflow:r-notice:research'].notice_sent, false);

  const retry = await h.keeper.sweep();
  assert.equal(retry.handed_off.length, 0, 'the existing handoff is reused');
  assert.equal(h.did.handed.length, 1, 'a notice retry never creates another job');
  assert.equal(h.did.told.length, 1);
  assert.equal(h.fact().things.things['workflow:r-notice:research'].notice_sent, true);
  const canonicalNoticeKey = 'keep-running:workflow:r-notice:research:2026-10-03T04:00:00.000Z';
  assert.deepEqual(h.did.told.map(one => one.key), [canonicalNoticeKey]);
  const settledWrites = h.did.things_writes;
  await h.keeper.sweep();
  assert.equal(h.did.things_writes, settledWrites, 'a later unchanged sweep does not rewrite things');

  const noticeLost = harness({ runs: [run], tellFailures: 1 });
  await noticeLost.keeper.sweep();
  const pending = await noticeLost.keeper.sweep();
  assert.equal(pending.handed_off.length, 1);
  assert.equal(noticeLost.fact().things.things['workflow:r-notice:research'].notice_sent, false);
  noticeLost.world.ended.add('h_1');
  noticeLost.keeper.invalidate();
  const deliveredAfterRehand = await noticeLost.keeper.sweep();
  assert.equal(deliveredAfterRehand.handed_off.length, 1);
  assert.equal(noticeLost.did.handed.length, 2, 'an ended job is handed again for the same stopped thing');
  assert.equal(noticeLost.did.told.length, 1, 'the failed notice is delivered after rehanding');
  assert.deepEqual(noticeLost.did.told.map(one => one.key), [canonicalNoticeKey], 'the notice key remains canonical across rehanding');
  assert.equal(noticeLost.fact().things.things['workflow:r-notice:research'].notice_sent, true);

  noticeLost.world.ended.add('h_2');
  noticeLost.keeper.invalidate();
  await noticeLost.keeper.sweep();
  assert.equal(noticeLost.did.handed.length, 3);
  assert.equal(noticeLost.did.told.length, 1, 'a delivered notice is not repeated after another retry job');

  const markLost = harness({ runs: [run], tellCommitsThenFails: 1 });
  await markLost.keeper.sweep();
  const committedNotice = await markLost.keeper.sweep();
  assert.equal(committedNotice.handed_off.length, 1);
  assert.equal(markLost.did.told.length, 1, 'the owner committed the notice before its response was lost');
  assert.equal(markLost.fact().things.things['workflow:r-notice:research'].notice_sent, false);
  markLost.fact().things.things = {};
  markLost.reopen();
  const restoredWithoutMark = await markLost.keeper.sweep();
  assert.equal(restoredWithoutMark.restarted.length, 1, 'losing the whole recovery mark also loses its restart count');
  const recoveredMark = await markLost.keeper.sweep();
  assert.equal(recoveredMark.still_stopped.length, 1, 'the repeated hand-off is recognized after its mark is lost');
  assert.equal(markLost.did.handed.length, 1, 'the existing hand-off is not duplicated');
  assert.equal(markLost.did.repeated.length, 1);
  assert.deepEqual(markLost.did.told.map(one => one.key), [canonicalNoticeKey], 'the idempotent owner suppresses a duplicate committed notice');
  assert.equal(markLost.fact().things.things['workflow:r-notice:research'].notice_sent, true);
  const recoveredWrites = markLost.did.things_writes;
  await markLost.keeper.sweep();
  assert.equal(markLost.did.things_writes, recoveredWrites, 'a successful subsequent sweep does not write unchanged things');

  h.world.ended.add('h_1');
  h.keeper.invalidate();
  const handedAgain = await h.keeper.sweep();
  assert.equal(handedAgain.handed_off.length, 1, 'an ended job is handed again for the same stopped thing');
  assert.equal(h.did.handed.length, 2);
  assert.equal(h.did.told.length, 1, 'a delivered notice is not repeated for the retry job');
});

test('overlapping recovery sweeps share one run-now and clear the shared sweep after failure', async () => {
  const schedule = { schedule_id: 'weekly-post', label: 'Weekly post', enabled: true, last_run: { at: '2026-10-03T09:00:00Z', task_id: 'failed-run' } };
  let finishRestart;
  const restartGate = new Promise(resolve => { finishRestart = resolve; });
  let signalRestartStarted;
  const restartStarted = new Promise(resolve => { signalRestartStarted = resolve; });
  let runs = 0;
  let scheduleReads = 0;
  let failRead = false;
  let scheduleActive = true;
  const fact = { value: null, clock: null };
  const keeper = makeKeepRunning({
    now: () => T0,
    read: {
      held: async () => [], schedules: async () => { scheduleReads += 1; if (failRead) { failRead = false; throw new Error('read failed'); } return scheduleActive ? [schedule] : []; },
      runs: async () => [], runEnd: async () => ({ state: 'failed', error: 'retry me' }),
    },
    act: { release: async () => {}, runNow: async () => { runs += 1; signalRestartStarted(); await restartGate; scheduleActive = false; }, admit: async () => {}, resume: async () => {}, askAgain: async () => {}, handOff: async () => ({}), tell: async () => ({}) },
    watched: { read: () => fact.value, write: value => { fact.value = structuredClone(value); } },
    clock: { read: () => fact.clock, write: value => { fact.clock = structuredClone(value); } },
  });
  const first = keeper.sweep();
  const overlapping = keeper.sweep();
  assert.equal(overlapping, first, 'both scheduler wakes join the in-flight sweep');
  await restartStarted;
  assert.equal(runs, 1);
  finishRestart();
  await Promise.all([first, overlapping]);
  assert.equal(runs, 1);
  scheduleReads = 0;
  await keeper.sweep();
  assert.equal(scheduleReads, 1, 'a later sequential sweep runs after the shared one settles');
  assert.equal(runs, 1, 'a sequential sweep does not restart a schedule that recovered');

  failRead = true;
  await assert.rejects(keeper.sweep(), /read failed/);
  await keeper.sweep();
  assert.equal(scheduleReads, 3, 'a rejected sweep clears the singleflight so a later retry can proceed');
});

test('a stop a sweep missed (a busy read) and then saw again is not handed or told again', async () => {
  const run = { run_id: 'r1', recipe: { id: 'workflow:inbox', label: 'Handle what arrived' }, state: 'working', started_at: new Date(T0 - 8 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'handle', title: 'Handle' }] };
  const h = harness({ runs: [run] });
  await h.keeper.sweep();
  h.tick(15 * 60000);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1);
  assert.equal(h.did.told.length, 1);
  for (let round = 0; round < 4; round += 1) {
    h.world.runs = [];
    h.tick(15 * 60000);
    await h.keeper.sweep();
    h.world.runs = [run];
    h.tick(15 * 60000);
    await h.keeper.sweep();
  }
  assert.equal(h.did.handed.length, 1, 'one job for one stop');
  assert.equal(h.did.told.length, 1, 'the person is told once');
  // The run moves, then stops again: that is a new stop.
  h.world.runs = [{ ...run, done: { handle: { admitted_at: new Date(T0 + 2 * HOUR).toISOString() } } }];
  h.tick(10 * HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 2);
});

test('a stalled step whose own job is still open is read once and left to that job, never handed a second job', async () => {
  const h = harness({ runs: [{ run_id: 'r2', recipe: { id: 'workflow:inbox' }, state: 'working', started_at: new Date(T0 - 8 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'handle', title: 'Handle', agent: { handoff_id: 'h_own', state: 'open' } }] }] });
  for (let n = 0; n < 5; n += 1) { await h.keeper.sweep(); h.tick(HOUR); }
  assert.deepEqual(h.did.admitted, ['r2'], 'read once, so a job finished where the run never heard of it is admitted');
  assert.equal(h.did.handed.length, 0, 'no second job beside its own');
  assert.equal(h.did.told.length, 0);
});

test('a stalled run whose step was already done somewhere is moved by reading it, and no AI or person is troubled', async () => {
  const run = { run_id: 'r3', recipe: { id: 'workflow:inbox' }, state: 'working', started_at: new Date(T0 - 9 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'handle', title: 'Handle', agent: { handoff_id: 'h_done', state: 'open' } }] };
  const h = harness({ runs: [run] });
  await h.keeper.sweep();
  assert.deepEqual(h.did.admitted, ['r3']);
  // Reading it admitted the job's finished output: the run finished, so it is no longer read as working.
  h.world.runs = [];
  h.tick(HOUR);
  const after = await h.keeper.sweep();
  assert.equal(h.did.handed.length, 0);
  assert.equal(h.did.told.length, 0);
  assert.deepEqual(after.moving_again, [], 'remembered as restarted, never handed');
});

test('a decision nobody said was done goes to one AI as one job, and the person is not told', async () => {
  const owed = { case_id: 'source:abc', goal: 'Password sign-in', next_action: 'Land the sign-in form', success_measure: 'A proof account signs in with a password', decided_at: '2026-10-03T09:00:00.000Z' };
  const h = harness({ owed: [owed] });
  await h.keeper.sweep();
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1, 'once per decision, however many sweeps or AIs');
  assert.match(h.did.handed[0].job, /export_decision/);
  assert.match(h.did.handed[0].job, /say_what_was_done with case_id source:abc/);
  assert.equal(h.did.told.length, 0, 'the AIs own work is not a notice to the person');
  // Said done: it leaves the list and is let go.
  h.world.owed = [];
  h.tick(HOUR);
  const after = await h.keeper.sweep();
  assert.deepEqual(after.moving_again, ['decision:source:abc']);
});

test('a service that refuses any of the own AIs is told to the person once per refusal, and clears when it answers again', async () => {
  const refusal = { provider: 'anthropic', label: 'Claude', since: '2026-10-04T04:42:42.475Z', why: 'The tool answered 400: Your credit balance is too low' };
  const h = harness({ refused: [refusal] });
  await h.keeper.sweep();
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1, 'once per refusal');
  assert.match(h.did.handed[0].job, /credit balance is too low/);
  assert.match(h.did.handed[0].job, /say_what_is_in_the_way/);
  assert.equal(h.did.told.length, 1, 'only the person can add credit, so they are told');
  assert.match(h.did.told[0].title, /Claude/);
  assert.match(h.did.told[0].body, /Claude stopped taking your AI's work/, 'its own words, not the shared ones');
  h.world.refused = [];
  h.tick(HOUR);
  const after = await h.keeper.sweep();
  assert.deepEqual(after.moving_again, ['refused:anthropic']);
  // A new refusal later is a new stop.
  h.world.refused = [{ ...refusal, since: '2026-10-05T01:00:00.000Z' }];
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 2);
});

test('the person\'s own work no AI took is told to them once and handed to no AI; work handed recently is not', async () => {
  const minutes = KEEP_RUNNING.own_work_waiting_after_minutes;
  const old = { handoff_id: 'h_recording', said: 'Work through my 6-minute recording', handed_at: new Date(T0 - (minutes + 5) * 60000).toISOString() };
  const fresh = { handoff_id: 'h_press', said: 'Look into my goal', handed_at: new Date(T0 - 60000).toISOString() };
  const h = harness({ waiting: [old, fresh] });
  const first = await h.keeper.sweep();
  assert.deepEqual(first.told, ['waiting:h_recording'], 'only work past the wait is a stop');
  assert.equal(h.did.handed.length, 0, 'a job nobody took is never handed to another AI');
  assert.equal(h.did.told.length, 1);
  assert.equal(h.did.told[0].kind, KEEP_RUNNING.words.own_work_waiting.notice_kind);
  assert.equal(h.did.told[0].title, '"Work through my 6-minute recording" is still waiting for an AI');
  assert.match(h.did.told[0].body, new RegExp(`in ${minutes + 5} minutes`));
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.told.length, 2, 'the fresh press, now past the wait, is told; the recording is not told twice');
  assert.equal(h.did.told[1].refs.handoff_id, 'h_press');
  // Taken: it leaves the read and is let go, so a later stop of the same job is new.
  h.world.waiting = [];
  h.tick(HOUR);
  const after = await h.keeper.sweep();
  assert.deepEqual(after.moving_again.sort(), ['waiting:h_press', 'waiting:h_recording']);
});

test('own work waiting is a stop named by its job and when it was handed', () => {
  const item = { handoff_id: 'h_1', said: 'Do what I asked', handed_at: '2026-10-03T10:00:00.000Z' };
  const [thing] = stoppedThings({ now: T0, waiting: [item] });
  assert.equal(thing.key, 'waiting:h_1');
  assert.equal(thing.stop, item.handed_at);
  assert.equal(thing.values.minutes, 120);
  assert.equal(thing.words.hand_off, false);
});

test('the person\'s message whose decision was opened with no job is handed as that message\'s own job, once, and the person is not told', async () => {
  const item = { case_id: 'source:bWVtbw', message_id: 'message:2026-09-28T05:32:24.919Z:c8a2', goal: 'A voice memo called "UI Feedback Trillion App"', created_at: '2026-09-30T05:02:20.118Z' };
  const h = harness({ unowned: [item] });
  await h.keeper.sweep();
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1, 'once per message, however many sweeps');
  const job = h.did.handed[0];
  assert.equal(job.once_per, item.message_id, 'the job is the message\'s own job, never a second one beside it');
  assert.equal(job.case_id, item.case_id);
  assert.deepEqual(job.input.arrived, { message_id: item.message_id, case_id: item.case_id, from_person: true });
  assert.equal(job.priority, KEEP_RUNNING.words.words_unowned.priority, 'the person\'s own words carry their own priority');
  assert.match(job.job, /next_question/);
  assert.match(job.said, /UI Feedback Trillion App/);
  assert.equal(h.did.told.length, 0, 'the job itself shows on AI work; no notice');
  // Owned now: the reader no longer returns it, and it is let go.
  h.world.unowned = [];
  h.tick(HOUR);
  const after = await h.keeper.sweep();
  assert.deepEqual(after.moving_again, [`words:${item.message_id}`]);
});

test('an unowned message is a stop named by its message and when its decision was opened', () => {
  const [thing] = stoppedThings({ now: T0, unowned: [{ case_id: 'source:x', message_id: 'message:a', goal: 'g', created_at: '2026-10-01T00:00:00.000Z' }] });
  assert.equal(thing.key, 'words:message:a');
  assert.equal(thing.kind, 'words_unowned');
  assert.equal(thing.stop, '2026-10-01T00:00:00.000Z');
  assert.equal(thing.restart, null);
  assert.equal(thing.hand.once_per, 'message:a');
});

test('words the classifier never answered about are asked again once, and handed to an AI as their message\'s job if that fails', async () => {
  const item = { message_id: 'message:fart', at: '2026-10-06T14:52:43.022Z', facts: { route: 'Listening', text: 'Trillian, clip that and put it on socials' } };
  const h = harness({ unclassified: [item], askAgain: async () => { throw new Error('the store was busy'); } });
  await h.keeper.sweep();
  assert.deepEqual(h.did.asked_again, ['message:fart'], 'first asked again');
  assert.equal(h.did.handed.length, 0);
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.asked_again.length, 1, 'asked again once');
  assert.equal(h.did.handed.length, 1, 'then an AI judges it');
  assert.equal(h.did.handed[0].once_per, 'message:fart');
  assert.match(h.did.handed[0].said, /clip that and put it on socials/);
  assert.equal(h.did.told.length, 0);
});

test('words asked again and answered leave the list and are let go', async () => {
  const item = { message_id: 'message:a', at: '2026-10-06T10:00:00.000Z', facts: { route: 'Listening', text: 'can we' } };
  const h = harness({ unclassified: [item] });
  await h.keeper.sweep();
  h.world.unclassified = [];
  h.tick(HOUR * 25);
  const after = await h.keeper.sweep();
  assert.deepEqual(after.moving_again, ['unclassified:message:a']);
  assert.equal(h.did.handed.length, 0);
});

test('the kinds of stop take the sweep\'s room in turn, so many of one kind never keep another from being handed', async () => {
  assert.deepEqual(inTurns([{ kind: 'a', n: 1 }, { kind: 'a', n: 2 }, { kind: 'a', n: 3 }, { kind: 'b', n: 4 }, { kind: 'c', n: 5 }, { kind: 'b', n: 6 }]).map(thing => thing.n), [1, 4, 5, 2, 6, 3]);
  assert.deepEqual(inTurns([]), []);
  const owed = Array.from({ length: 20 }, (_, n) => ({ case_id: `case:owed-${n}`, goal: `Owed ${n}`, next_action: 'Do it', success_measure: 'Done', decided_at: '2026-10-06T00:00:00.000Z' }));
  const unowned = [{ case_id: 'source:bWVtbw', message_id: 'message:memo', goal: 'Book the court', created_at: '2026-10-06T00:00:00.000Z' }];
  const h = harness({ owed, unowned });
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, KEEP_RUNNING.most_handed_off_per_sweep, 'the room is the same');
  assert.ok(h.did.handed.some(job => job.once_per === 'message:memo'), 'the person\'s message is handed in the first sweep despite twenty owed decisions');
});

test('stops already handed take no turn, so a kind whose new stop sits behind its handed ones is not starved', async () => {
  const owed = Array.from({ length: 6 }, (_, n) => ({ case_id: `case:owed-${n}`, goal: `Owed ${n}`, next_action: 'Do it', success_measure: 'Done', decided_at: '2026-10-06T00:00:00.000Z' }));
  const h = harness({ owed });
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, KEEP_RUNNING.most_handed_off_per_sweep, 'the first five owed decisions are handed');
  // The sixth owed decision now sits behind five handed ones, while ten of the person's messages arrive with no job.
  h.world.unowned = Array.from({ length: 10 }, (_, n) => ({ case_id: `source:m${n}`, message_id: `message:m${n}`, goal: `Said ${n}`, created_at: '2026-10-06T00:00:00.000Z' }));
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.ok(h.did.handed.some(job => job.once_per.includes('decision:case:owed-5:')), 'the waiting owed decision is handed in the next sweep, beside the messages');
});


test('cold invalidation uses only the clock when no idle answer is saved', async () => {
  for (const initialClock of [null, {}, { idle_checked: false, swept_at: new Date(T0).toISOString() }]) {
    let watchedReads = 0;
    let clockReads = 0;
    let clockWrites = 0;
    let idleReads = 0;
    let watchedUnavailable = true;
    const keeper = makeKeepRunning({
      now: () => T0,
      read: { idleNext: async () => { idleReads += 1; return T0 + HOUR; } },
      act: {},
      watched: { read: () => {
        watchedReads += 1;
        if (watchedUnavailable) throw new Error('the full watched history must not be hydrated by invalidation');
        return { watching: 0, things: {} };
      }, write: () => assert.fail('invalidation does not write watched work') },
      clock: { read: () => { clockReads += 1; return initialClock; }, write: () => { clockWrites += 1; } },
    });
    for (let i = 0; i < 100; i += 1) keeper.invalidate();
    assert.equal(watchedReads, 0);
    assert.equal(clockReads, 1);
    assert.equal(clockWrites, 0);
    watchedUnavailable = false;
    assert.equal(await keeper.nextAt(), T0 + HOUR, 'a later scheduling read still loads the watched state');
    assert.equal(watchedReads, 1);
    assert.equal(idleReads, 1);
  }
});

test('cold invalidation preserves watching work and dirties only a saved idle answer', async () => {
  for (const watching of [0, 2]) {
    let savedClock = { idle_checked: true, idle_next_at: T0 + HOUR, idle_code: null, swept_at: new Date(T0).toISOString() };
    let watchedReads = 0;
    let clockWrites = 0;
    const keeper = makeKeepRunning({
      now: () => T0,
      read: { idleNext: async () => T0 + 2 * HOUR }, act: {},
      watched: { read: () => { watchedReads += 1; return { watching, things: {} }; }, write: () => assert.fail('invalidation must preserve watched work') },
      clock: { read: () => savedClock, write: value => { savedClock = structuredClone(value); clockWrites += 1; } },
    });
    keeper.invalidate();
    assert.equal(watchedReads, 1);
    assert.equal(clockWrites, watching ? 0 : 1);
    assert.equal(savedClock.idle_checked, Boolean(watching));
    assert.equal(await keeper.nextAt(), T0 + (watching ? HOUR : 2 * HOUR));
  }
});

test('a run that stopped long ago is still handed: no looked-back window lets started work go unwatched', async () => {
  const run = { run_id: 'r-old', recipe: { id: 'workflow:x-mode', label: 'X mode' }, state: 'working', started_at: new Date(T0 - 30 * 24 * HOUR).toISOString(), done: { scope: { admitted_at: new Date(T0 - 20 * 24 * HOUR).toISOString() } }, waiting: [{ step_id: 'reuse', title: 'Reuse' }] };
  const h = harness({ runs: [run] });
  await h.keeper.sweep();
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1, 'read, then handed to an AI');
  assert.equal(h.did.handed[0].input.keep_running.run_id, 'r-old');
});

test('a job that ended while its run is still stopped is handed again as a new job, and the person is told only once', async () => {
  const run = { run_id: 'r1', recipe: { id: 'workflow:plan', label: 'Plan' }, state: 'working', started_at: new Date(T0 - 8 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'research', title: 'Research' }] };
  const h = harness({ runs: [run] });
  await h.keeper.sweep();
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1);
  assert.equal(h.did.told.length, 1);
  // Its job is finished, and the run never moved: the idle answer is due at once and the sweep hands it again.
  h.world.ended.add('h_1');
  h.keeper.invalidate();
  h.tick(5 * 60000);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 2, 'a second job for the same stop');
  assert.notEqual(h.did.handed[1].once_per, h.did.handed[0].once_per, 'a new job, never the finished one answered back');
  assert.match(h.did.handed[1].job, /h_1/, 'the new job says which job ended without the outcome');
  assert.equal(h.did.told.length, 1, 'the person is not told again');
  // While the new job is on, the run is left to it.
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 2);
});

test('an idle store whose handed job ended is due now, not at its next owner time', async () => {
  const run = { run_id: 'r1', recipe: { id: 'workflow:plan' }, state: 'working', started_at: new Date(T0 - 8 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'research' }] };
  const h = harness({ runs: [run], idleAt: T0 + 48 * HOUR });
  await h.keeper.sweep();
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1);
  h.tick(HOUR);
  await h.keeper.sweep();
  h.keeper.invalidate();
  assert.equal(await h.keeper.nextAt(), T0 + 48 * HOUR, 'with its job on, the store waits for its owner time');
  h.world.ended.add('h_1');
  h.keeper.invalidate();
  assert.ok(await h.keeper.nextAt() <= T0 + 3 * HOUR, 'the ended job makes the sweep due');
});

test('a run handed for an unchanged card whose job is on is not read again, and its mark is carried', async () => {
  const run = { run_id: 'r1', recipe: { id: 'workflow:plan' }, state: 'working', started_at: new Date(T0 - 8 * HOUR).toISOString(), done: {}, waiting: [{ step_id: 'research' }], card_at: new Date(T0 - 8 * HOUR).toISOString() };
  const h = harness({ runs: [run] });
  await h.keeper.sweep();
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1);
  const card = { seq: 7, at: run.card_at, card: { run_id: 'r1', state: 'working', waiting: [{ step_id: 'research' }] } };
  h.tick(HOUR);
  h.world.runs = [];
  await h.keeper.sweep();
  assert.equal(h.world.watch.skip(card), true, 'settled from its card, so the run is not read whole');
  const after = await h.keeper.sweep();
  assert.deepEqual(after.moving_again, [], 'the carried mark is kept, never let go');
  assert.equal(h.world.watch.skip({ ...card, at: new Date(T0 + 3 * HOUR).toISOString() }), true, 'a card written within the stall wait cannot have stalled');
  assert.equal(h.world.watch.skip({ ...card, at: new Date(T0 - 7 * HOUR).toISOString() }), false, 'a card written again since it was handed is read');
  h.world.ended.add('h_1');
  assert.equal(h.world.watch.skip(card), false, 'its job ended, so the run is read again');
  assert.equal(h.world.watch.skip({ ...card, card: { ...card.card, waiting: [{ step_id: 'research', waits_until: new Date(T0 + 9 * HOUR).toISOString() }] } }), true, 'a run waiting for a time still to come is not read');
  assert.equal(h.world.watch.skip({ ...card, card: { ...card.card, run_id: 'r9', waiting: [{ step_id: 's', handoff_id: 'h_own' }] } }), true, 'a step whose own job is on is that job\'s');
});

test('a terminal failed run without a waiting step is resumed once, then carried by one repair job', async () => {
  const run = { run_id: 'failed-run', state: 'failed', recipe: { id: 'workflow:original' }, error: 'Catalog unavailable',
    started_at: new Date(T0).toISOString(), card_at: new Date(T0).toISOString(), waiting: [], done: {} };
  const h = harness({ runs: [run], idleAt: T0 + 48 * HOUR });
  assert.equal(await h.keeper.nextAt(), T0, 'a fresh terminal failure is due immediately on an otherwise idle account');
  await h.keeper.sweep();
  assert.deepEqual(h.did.resumed, ['failed-run']);
  assert.equal(h.did.admitted.length, 0, 'failure uses the existing resume operation, not a read with no continuation');
  assert.equal(h.fact().things.watching, 1, 'failure remains watched after its one restart');
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1);
  assert.match(h.did.handed[0].job, /failed-run.*Catalog unavailable/);
  assert.match(h.did.handed[0].job, /original input, recipe and admitted answers/);
  const card = { at: run.card_at, card: { run_id: run.run_id, state: 'failed', recoverable: true, waiting: [{ step_id: null }] } };
  await h.keeper.status();
  assert.equal(h.world.watch.skip(card), true, 'the unchanged failure belongs to its existing open repair job');
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 1);
  assert.equal(h.fact().things.watching, 0, 'an open repair job removes the hourly watch');
  h.keeper.invalidate();
  assert.equal(await h.keeper.nextAt(), T0 + 48 * HOUR, 'the settled failed card does not create a new idle wake');
  h.world.ended.add('h_1');
  h.keeper.invalidate();
  assert.ok(await h.keeper.nextAt() <= T0 + 2 * HOUR, 'an ended repair job makes unfinished failure due again');
  assert.equal(h.world.watch.skip(card), false);
  await h.keeper.sweep();
  assert.equal(h.did.handed.length, 2);
  assert.notEqual(h.did.handed[0].once_per, h.did.handed[1].once_per);
  assert.match(h.did.handed[1].job, /h_1/);
  assert.equal(h.did.told.length, 1, 'repair reoffer preserves the original single notice');
});

test('successful failed-run recovery clears the parent watch and never duplicates the original run', async () => {
  const run = { run_id: 'recover', state: 'failed', error: 'Temporary failure', card_at: new Date(T0).toISOString(), waiting: [] };
  const h = harness({ runs: [run], resume: (_id, world) => { world.runs[0] = { ...run, state: 'finished' }; } });
  await h.keeper.sweep();
  h.tick(HOUR);
  await h.keeper.sweep();
  assert.deepEqual(h.did.resumed, ['recover']);
  assert.equal(h.did.handed.length, 0);
  assert.equal(h.fact().things.watching, 0);
  assert.equal(await h.keeper.nextAt(), null);
});

test('explicit workflow and agent withdrawals never become automatic failed-run recovery work', async () => {
  const runs = ['workflow-stop', 'agent-withdrawal'].map((kind, n) => ({ run_id: `cancelled-${n}`, state: 'failed',
    error: 'Withdrawn', waiting: [], withdrawal: { kind, reason: 'Cancelled by the person.' } }));
  const h = harness({ runs });
  assert.equal(await h.keeper.nextAt(), null);
  const result = await h.keeper.sweep();
  assert.equal(result.stopped, 0);
  assert.deepEqual(h.did.resumed, []);
  assert.deepEqual(h.did.handed, []);
  assert.equal(h.world.watch.skip({ card: { run_id: 'cancelled-0', state: 'failed', recoverable: false } }), true);
});

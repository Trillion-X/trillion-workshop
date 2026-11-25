// tools/check-a-computer-from-inside/do-work/due-times-told.mjs: was each due occurrence told? A due-time wake whose last
// expected occurrence (its own cadence, as timed-action says) was not told by its window plus the grace is late: told on
// time, one missed tick, a wake switched on after the last occurrence, a daily wake, and a day a clock change folds or
// skips. Every computer here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFromInside, checkHere, wakeBookFindings } from '../do-work/check-from-inside.mjs';
import { dueTimesNotTold, notToldFinding, readOwnDueTimeWakes, switchedOnAt } from '../do-work/due-times-told.mjs';

const at = iso => Date.parse(iso);
const schedule = (id, cadence, start = '00:00', { timezone = 'UTC', minutes = 1 } = {}) => ({
  schedule_id: `schedule:${id}`, schedule_revision: 1, source_generation: 1, timezone, start_local_date: '1970-01-01', cadence,
  local_window: { start, duration_minutes: minutes }, dst: { fold: 'earlier', gap: 'next-valid' },
  action: { operation: 'tell-the-engine', owner_ref: `tool:${id}`, completion: { mode: 'synchronous-owner-return' }, owner_dispatch: { name: `tool:${id}`, input: {} } },
});
const wake = (id, schedules, firedIso, more = {}) => ({ tool: 'tool:keep-something', id, switched_on: true, switch_stands: true,
  on: { fact: { kind: 'due-time', from: ['run'], match: {}, watch: { schedules } } },
  mark: firedIso ? { fired_ms: at(firedIso), on: true, outcome: 'ran' } : { on: true }, ...more });
const everyFive = schedule('five', { unit: 'minute', interval: 5 });
const starts = result => result.late.map(item => [item.wake, item.start]);

test('a wake told at its occurrence is on time, and one still inside its window plus the grace is not yet late', () => {
  const told = wake('a', [everyFive], '2026-11-25T14:00:00.500Z');
  assert.deepEqual(dueTimesNotTold([told], [], at('2026-11-25T14:03:10Z')), { late: [], not_judged: [] });
  const waiting = wake('a', [everyFive], '2026-11-25T13:55:00.500Z');
  assert.deepEqual(dueTimesNotTold([waiting], [], at('2026-11-25T14:02:30Z')).late, [], 'the 14:00 window ended 14:01; the grace runs to 14:03');
});

test('one missed tick is late once its window and the grace have passed, and is told with its time', () => {
  const missed = wake('a', [everyFive], '2026-11-25T13:55:00.500Z');
  const seen = dueTimesNotTold([missed], [], at('2026-11-25T14:03:10Z'));
  assert.deepEqual(starts(seen), [['a', '2026-11-25T14:00:00.000Z']]);
  assert.match(seen.late[0].said, /a was due at 2026-11-25T14:00:00\.000Z and not told by 2026-11-25T14:03:00\.000Z; it last fired at 2026-11-25T13:55:00\.500Z\./);
});

test('what another wake was told does not hide this wake\'s missed tick: told is its own mark, not the kind\'s last fact', () => {
  const stuck = wake('stuck', [everyFive], '2026-11-25T13:50:00.500Z', { kind_last_told: { at_ms: at('2026-11-25T14:00:00.616Z'), heard_by_this: false } });
  const fine = wake('fine', [everyFive], '2026-11-25T14:00:00.500Z', { kind_last_told: { at_ms: at('2026-11-25T14:00:00.616Z'), heard_by_this: true } });
  assert.deepEqual(starts(dueTimesNotTold([stuck, fine], [], at('2026-11-25T14:03:10Z'))), [['stuck', '2026-11-25T14:00:00.000Z']]);
});

test('a wake switched on after its last expected occurrence is not late; one switched on before it, and never told, is', () => {
  const never = wake('a', [everyFive], null);
  const history = on => [{ id: 'a', tool: 'tool:keep-something', on: true, at_ms: at(on) }];
  assert.deepEqual(dueTimesNotTold([never], history('2026-11-25T14:00:30Z'), at('2026-11-25T14:03:10Z')).late, [], 'switched on 30 s after the 14:00 occurrence began');
  assert.deepEqual(starts(dueTimesNotTold([never], history('2026-11-25T13:59:30Z'), at('2026-11-25T14:03:10Z'))), [['a', '2026-11-25T14:00:00.000Z']], 'a full tick after its switch and still not fired');
  assert.deepEqual(dueTimesNotTold([never], [], at('2026-11-25T14:03:10Z')), { late: [], not_judged: ['a'] }, 'no fired time and no switch time is not judged, never called on time');
  const switchedLater = wake('a', [everyFive], '2026-11-25T13:50:00.500Z');
  assert.deepEqual(dueTimesNotTold([switchedLater], history('2026-11-25T14:01:00Z'), at('2026-11-25T14:03:10Z')).late, [], 'a switch after the occurrence began beats an older fire');
  assert.equal(switchedOnAt(never, [{ id: 'a', tool: 'tool:keep-something', on: false, at_ms: 5 }, ...history('2026-11-25T13:00:00Z'), ...history('2026-11-25T12:00:00Z')]), at('2026-11-25T13:00:00Z'));
  assert.equal(switchedOnAt(never, [{ id: 'a', tool: 'tool:other', on: true, at_ms: 5 }]), null, 'another tool\'s wake of the same id is not this one');
});

test('a daily wake is late only after today\'s occurrence has begun, its window and the grace passed, and not told since', () => {
  const daily = schedule('daily', { unit: 'day' }, '14:00');
  const yesterday = wake('d', [daily], '2026-11-24T14:00:00.400Z');
  assert.deepEqual(dueTimesNotTold([yesterday], [], at('2026-11-25T13:00:00Z')).late, [], 'today\'s occurrence has not begun');
  assert.deepEqual(dueTimesNotTold([yesterday], [], at('2026-11-25T14:02:00Z')).late, [], 'inside the grace');
  assert.deepEqual(starts(dueTimesNotTold([yesterday], [], at('2026-11-25T14:03:10Z'))), [['d', '2026-11-25T14:00:00.000Z']]);
  assert.deepEqual(dueTimesNotTold([wake('d', [daily], '2026-11-25T14:00:01Z')], [], at('2026-11-25T20:00:00Z')).late, []);
});

test('a day a clock change folds or skips: the occurrence is where timed-action puts it', () => {
  const chicago = schedule('night', { unit: 'day' }, '01:30', { timezone: 'America/Chicago' });
  // Nov 1 2026 falls back at 2:00 AM CDT: 1:30 AM happens twice, and the earlier one (06:30 UTC) is the occurrence.
  const fold = dueTimesNotTold([wake('n', [chicago], '2026-10-31T06:30:00.300Z')], [], at('2026-11-01T06:33:10Z'));
  assert.deepEqual(starts(fold), [['n', '2026-11-01T06:30:00.000Z']]);
  assert.deepEqual(dueTimesNotTold([wake('n', [chicago], '2026-11-01T06:30:00.300Z')], [], at('2026-11-01T12:00:00Z')).late, [], 'told on the fold day, not told twice');
  // Mar 8 2026 springs forward at 2:00 AM CST: 2:30 AM does not exist, and next-valid puts the occurrence at 3:00 AM CDT (08:00 UTC).
  const skipped = schedule('gap', { unit: 'day' }, '02:30', { timezone: 'America/Chicago' });
  const gap = dueTimesNotTold([wake('g', [skipped], '2026-03-07T08:30:00.300Z')], [], at('2026-03-08T08:03:10Z'));
  assert.deepEqual(starts(gap), [['g', '2026-03-08T08:00:00.000Z']]);
  assert.deepEqual(dueTimesNotTold([wake('g', [skipped], '2026-03-07T08:30:00.300Z')], [], at('2026-03-08T07:50:00Z')).late, [], 'before the skipped hour\'s occurrence');
});

test('wakes nothing is expected of are not judged: off, not standing, another kind, no schedule', () => {
  const missed = '2026-11-25T13:00:00.500Z';
  const cases = [wake('off', [everyFive], missed, { switched_on: false }), wake('not-standing', [everyFive], missed, { switch_stands: false }),
    wake('other-kind', [everyFive], missed, { on: { fact: { kind: 'something-changed', watch: { schedules: [everyFive] } } } }), wake('one-off', [], missed),
    wake('kept-workflow', [everyFive], missed, { on: { fact: { kind: 'kept-workflow-due', watch: { schedules: [everyFive] } } } })];
  assert.deepEqual(dueTimesNotTold(cases, [], at('2026-11-25T14:03:10Z')), { late: [], not_judged: [] });
});

test('a schedule timed-action refuses is not judged, and the finding names the late wakes once and shows its cause', () => {
  assert.deepEqual(dueTimesNotTold([wake('bad', [{ ...everyFive, cadence: { unit: 'fortnight' } }], '2026-11-25T13:00:00Z')], [], at('2026-11-25T14:03:10Z')), { late: [], not_judged: ['bad'] });
  const late = dueTimesNotTold([wake('a', [everyFive], '2026-11-25T13:00:00Z'), wake('b', [everyFive], '2026-11-25T13:00:00Z')], [], at('2026-11-25T14:03:10Z')).late;
  const finding = notToldFinding('this-computer', late);
  assert.deepEqual([finding.kind, finding.level, finding.about], ['due-time-not-told', 'alert', 'this-computer']);
  assert.match(finding.said, /2 due-time wakes were not told when due on this-computer: a, b\./);
  assert.equal(notToldFinding('x', []), null);
});

test('a computer read over SSH tells a due-time wake not told when due, unless a missing teller already says why', async () => {
  const stale = wake('keep-steps/a', [everyFive], '2026-11-25T13:50:00.500Z');
  const teller = { tool: 'tool:notice-when-something-shows-up', id: 'keep-noticing/x', on: { running: {} }, switched_on: true, switch_stands: true, mark: {} };
  const now = at('2026-11-25T14:03:10Z');
  assert.deepEqual(wakeBookFindings([{ unit: 'u', wakes: [stale, teller], switch_history: [] }], now).map(finding => finding.kind), ['due-time-not-told'], 'a teller that is on but stuck');
  assert.deepEqual(wakeBookFindings([{ unit: 'u', wakes: [stale], switch_history: [] }], now).map(finding => finding.kind), ['due-time-wakes-without-a-teller'], 'the missing teller is the cause, not told twice');
  assert.deepEqual(wakeBookFindings([{ unit: 'u', wakes: [wake('keep-steps/a', [everyFive], '2026-11-25T14:00:00.500Z'), teller], switch_history: [] }], now), [], 'on time');
  const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMadeUpMadeUpMadeUpMadeUpMadeUpMadeUpMadeUp';
  const engineUnit = { unit: 'engine.service', user: 'engine', program: 'the-engine', slots: { a: { health_listen: '127.0.0.1:7199' } },
    settings: { agent_socket: '/var/lib/engine/agent.sock', persons: '/var/lib/engine/persons', local_agents: [{ id: 'root', uid: 0, person: 'p_1' }] } };
  const run = script => script.includes('wake:list')
    ? { status: 0, stdout: JSON.stringify({ result: { structuredContent: { wakes: [stale, teller], switch_history: [], next: null } } }), stderr: '' }
    : { status: 0, stdout: `@@df\n@@ready 0 127.0.0.1:7199\n${JSON.stringify({ persons: 1 })}\n@@persons 0\n@@units\n@@end\n`, stderr: '' };
  const seen = await checkFromInside({ name: 'made-up', address: '192.0.2.10', host_key: HOST_KEY, runs: { units: [engineUnit] }, row_read_at: new Date(now).toISOString() }, { run, nowMs: now });
  assert.deepEqual(seen.findings.map(finding => [finding.kind, finding.level, finding.about]), [['due-time-not-told', 'alert', 'engine.service']]);
});

test('this computer is read through its own door, with no SSH: late wakes, a refused door, no door, and a pretended book', async () => {
  const now = at('2026-11-25T14:03:10Z');
  const door = { url: 'http://127.0.0.1:7199/mcp', resource: '@own-records', capability: 'a-capability' };
  const asked = [];
  const doorGiving = pages => async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url, input: body.params.arguments.input, authorization: init.headers.authorization, method: body.params.arguments.method, address: body.params.arguments.address });
    const page = pages[asked.length - 1] ?? pages.at(-1);
    return { ok: true, text: async () => (typeof page === 'string' ? page : JSON.stringify({ result: { structuredContent: page } })) };
  };
  const stale = wake('keep-steps/a', [everyFive], '2026-11-25T13:50:00.500Z');
  const fine = wake('keep-steps/b', [everyFive], '2026-11-25T14:00:00.500Z');
  const seen = await checkHere({ name: 'ignored' }, { door, nowMs: now, fetchImpl: doorGiving([{ computer: 'the-mac', wakes: [fine], switch_history: [], next: 'a\u001fb' }, { computer: 'the-mac', wakes: [stale], next: null }]) });
  assert.equal(seen.checked, true);
  assert.equal(seen.name, 'the-mac', 'the door says which computer answered');
  assert.deepEqual(seen.findings.map(finding => [finding.computer, finding.kind, finding.about]), [['the-mac', 'due-time-not-told', 'this-computer']]);
  assert.deepEqual(seen.wake_books[0].not_told, ['keep-steps/a']);
  assert.deepEqual(asked.map(item => [item.method, item.address, item.input, item.authorization]), [['wake:list', '@own-records', { kind: 'due-time' }, 'Bearer a-capability'], ['wake:list', '@own-records', { kind: 'due-time', after: 'a\u001fb' }, 'Bearer a-capability']]);
  const clean = await checkHere({}, { door, nowMs: now, fetchImpl: doorGiving([{ computer: 'the-mac', wakes: [fine], next: null }]) });
  assert.deepEqual([clean.findings, clean.wake_books[0].due_time_wakes, clean.wake_books[0].not_told], [[], ['keep-steps/b'], []]);
  const refused = await checkHere({}, { door, nowMs: now, fetchImpl: doorGiving([{ isError: true, content: 'x' }, JSON.stringify({ result: { isError: true, structuredContent: { code: 'scope_refused' } } })].slice(1)) });
  assert.deepEqual(refused.findings.map(finding => finding.kind), ['wake-book-not-read'], 'a door that refuses is its own finding, never a clean book');
  assert.match(refused.findings[0].said, /scope_refused/);
  assert.equal((await checkHere({}, { door: null, nowMs: now })).checked, false);
  assert.deepEqual(await readOwnDueTimeWakes(door, { fetchImpl: async () => { throw new Error('connection refused'); } }), { why: 'the door did not answer wake:list: connection refused' });
  const pretended = await checkHere({ name: 'p', pretend: { wake_books: { here: [stale] } } }, { door, nowMs: now });
  assert.deepEqual(pretended.findings.map(finding => [finding.kind, finding.pretend]), [['due-time-not-told', true]]);
  const viaTool = await checkFromInside({ here: true, name: 'p', pretend: { wake_books: { here: { refused: 'no door' } } } }, { door, nowMs: now });
  assert.deepEqual(viaTool.findings.map(finding => [finding.kind, finding.pretend]), [['wake-book-not-read', true]], 'here: true takes the own-door road');
});

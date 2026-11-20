// The change chain over a stand-in door: a labelled change is routed under its own event id and kept; each settled
// person is told once with one ready action (a call when the next call is soon, else a draft read from what was sent
// and the calendar, scored and saved in the owner's mailbox, which he sends himself); a failed draft step still tells
// what changed; a failed notice gives its claim back and removes its draft. Made-up rows; nothing is sent.
import { PGlite } from '@electric-sql/pglite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAsTheTool } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';

const recipe = name => JSON.parse(readFileSync(new URL(`../recipes/${name}.json`, import.meta.url), 'utf8')).records[0].payload;
const KEEP = recipe('keep-each-told-change-in-the-history');
const TELL = recipe('tell-the-owner-what-changed-for-each-person');
const ROUTER = recipe('route-each-row-change');
const wakeOf = (row, id) => row.wakes.find(wake => wake.id === id);
const address = name => [name, 'example.com'].join('@');

// A door that answers each tool a step asks from `answers` (a function of the tool and its input) and keeps every call.
function door(answers) {
  const calls = [];
  return {
    calls,
    async run(name, input) { calls.push({ name, input }); if (name === 'tool:choose-the-workflows-that-fire') return chooseTheWorkflowsThatFire(input); return answers(name, input); },
    async operation(name, input) { calls.push({ name, input }); return { result: { admitted: true } }; },
  };
}
// As the engine starts a run: the person's switch input, then the row's own wake input over it (the row's fields win).
const wake = (row, id, fact, eventId, own = {}) => ({ run: { row: row.id, ...own, ...wakeOf(row, id).input }, woken_by: { kind: 'x', event_id: eventId, payload: fact, coalesced: 0 } });
test('neither row names anything a person owns: its wakes carry only where a run starts', () => {
  for (const row of [KEEP, TELL]) for (const each of row.wakes) assert.deepEqual(Object.keys(each.input), ['start_at'], `${row.id} ${each.id}`);
});

test('a labelled change is routed under the event id it was told by, so two changes of one booking are two choices', async () => {
  const fact = change => ({ kind: 'something-changed', where: 'my-booking-service-key', place: 'booking', change, at: '2026-11-19T13:00:00.000Z', key: '101', after: JSON.stringify({ id: 101 }), kinds: JSON.stringify(change === 'added' ? ['call-booked'] : ['booking-changed']) });
  const told = [];
  for (const [change, id] of [['added', 'where::something-changed@my-booking-service-key:booking:101:added:a'], ['changed', 'where::something-changed@my-booking-service-key:booking:101:changed:b']]) {
    const d = door(() => ({}));
    const run = await runAsTheTool(wake(ROUTER, 'a-row-changed', fact(change), id), d);
    assert.equal(run.status, 'completed', run.error_message);
    told.push(...d.calls.filter(call => call.name === 'wake:arrive').map(call => call.input));
  }
  const kept = told.filter(fact => fact.payload.workflow === KEEP.id);
  assert.equal(kept.length, 2, 'the keeping workflow is chosen for both changes');
  assert.notEqual(kept[0].event_id, kept[1].event_id);
  assert.deepEqual(Object.keys(kept[1].payload).sort(), ['after', 'at', 'change', 'condition', 'key', 'place', 'where', 'workflow']);
  assert.equal(kept[1].payload.at, '2026-11-19T13:00:00.000Z', 'the source\'s own time rides with the told change (a fact holds 8 fields, so kinds, read only by the router, stays out)');
  assert.ok(told.some(fact => fact.payload.workflow === 'workflow:contact-a-booker-right-after-they-book'), 'call-booked chooses the booking workflows by their own fires_when');
});

test('a change handed to the router directly, with no fact behind it, is named by its own key', async () => {
  const d = door(() => ({}));
  const run = await runAsTheTool({ run: { row: ROUTER.id, start_at: 'choose', fact: { where: 'w', place: 'booking', change: 'added', key: 'k-1', kinds: '["call-booked"]' } } }, d);
  assert.equal(run.status, 'completed', run.error_message);
  const kept = d.calls.find(call => call.name === 'wake:arrive' && call.input.payload.workflow === KEEP.id);
  assert.equal(kept.input.event_id, `k-1:${KEEP.id}:a change a source told`);
});

test('a thought with kinds but no source and no change is not a told change', async () => {
  const { chosen } = await chooseTheWorkflowsThatFire({ parts: [{ words: 'a note', kinds: ['call-booked'] }] });
  assert.equal(chosen.some(item => item.workflow === KEEP.id), false);
});

test('a kept change is one statement of the told change, keyed by where, place, key, change and what it carried', async () => {
  const d = door(() => ({ columns: ['id', 'meaning'], rows: [{ id: 1, meaning: 'booked' }], row_count: 1 }));
  const fact = { workflow: KEEP.id, where: 'my-booking-service-key', place: 'booking', change: 'added', key: '101', after: '{"id":101}', at: '2026-11-19T13:00:00.000Z' };
  const run = await runAsTheTool(wake(KEEP, 'chosen--a-change-a-source-told', fact, 'f1', { history: { credential_name: 'my-history-connection' } }), d);
  assert.equal(run.status, 'completed', run.error_message);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].input.credential_name, 'my-history-connection', 'the history is the one the person switched on with');
  assert.deepEqual(d.calls[0].input.params, ['my-booking-service-key', 'booking', 'added', '101', '{"id":101}', '2026-11-19T13:00:00.000Z'], 'the statement is at the time the source says it happened');
  assert.match(d.calls[0].input.sql, /ON CONFLICT \(source, told\) DO NOTHING/);
});

test('a database row change with no kinds is chosen too, and the keep step keeps only what the history has rules for', async () => {
  const row = { kind: 'something-changed', where: 'my-shop-database', place: 'payment_events', change: 'added', at: '2026-11-19T13:00:00.000Z', key: '7', after: JSON.stringify({ customer_email: 'bo@example.test' }), by: 'shop' };
  const d = door(() => ({}));
  const run = await runAsTheTool(wake(ROUTER, 'a-row-changed', row, 'where::something-changed@my-shop-database:payment_events:7:added:a'), d);
  assert.equal(run.status, 'completed', run.error_message);
  assert.ok(d.calls.some(call => call.name === 'wake:arrive' && call.input.payload.workflow === KEEP.id), 'a row change with a source, a place and a change is chosen for the history');
  const db = new PGlite();
  await db.exec(`CREATE TABLE statements (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source text, told text, place text, change text, at timestamptz, key text, after jsonb, meaning text, UNIQUE (source, told));
    CREATE TABLE meaning_rules (position int PRIMARY KEY, source text, place text, change text, path text, meaning text NOT NULL);
    CREATE TABLE mention_rules (source text, place text, path text NOT NULL, role text NOT NULL, scheme text NOT NULL);
    INSERT INTO meaning_rules VALUES (1, 'my-shop-database', 'payment_events', 'added', null, 'paid');
    INSERT INTO mention_rules VALUES (null, 'message', '$.after.to', 'with', 'email');`);
  const keep = KEEP.definition.steps.find(step => step.id === 'keep').config.input.sql;
  const told = (where, place, key) => db.query(keep, [where, place, 'added', key, '{}', '2026-11-19T13:00:00.000Z']);
  assert.equal((await told('my-shop-database', 'payment_events', '7')).rows.length, 1, 'a source and place a meaning rule names is kept');
  assert.equal((await told('my-shop-database', 'payment_events', '7')).rows.length, 0, 'told again, it is kept once');
  assert.equal((await told('my-own-rows', 'tasks', '1')).rows.length, 0, 'a source no rule names is not kept');
  assert.equal((await told('my-shop-database', 'people', '2')).rows.length, 0, 'a place of a ruled source that no rule names is not kept');
  assert.equal((await told('any-mail-source', 'message', '3')).rows.length, 1, 'a rule that names no source keeps its place from any source');
  assert.deepEqual((await db.query('SELECT source, place, key FROM statements ORDER BY id')).rows, [
    { source: 'my-shop-database', place: 'payment_events', key: '7' }, { source: 'any-mail-source', place: 'message', key: '3' }]);
});

// The person's own switch input: everything this row names none of.
const SETTINGS = { history: { credential_name: 'my-history-connection' }, address_scheme: 'email', soon_minutes: 120, time_zone: 'America/Chicago',
  notices: { credential_name: 'my-notices-connection', kind: 'needs-you' },
  mail: { provider: 'gmail', connection: { connection_id: 'service_connection:google-account:example' } }, calendar: { provider: 'google-calendar', connection: { connection_id: 'service_connection:google-account:example' }, calendar_id: 'primary' },
  voice: { adapter: '/opt/example-adapter', base_model: '/opt/example-model', criterion: { id: 'x' }, min_paragraph_chars: 40, decider_common_dir: '/opt/example-decider' },
  phrase_rules: [{ id: 'no-filler', words: ['just checking in'] }] };
const due = (soon, extra = {}) => ({ thing_scheme: 'person', thing_value: 'person:bo', through: 9, meanings: ['booked', 'cancelled'], words: 'moved the call', addresses: address('bo'), address: address('bo.work'),
  next_call_at: '2026-11-21T13:00:00.000Z', next_call_said: 'Sat Nov 21, 7:00 AM America/Chicago', soon, now_at: '2026-11-19T13:00:00Z', calendar_to: '2026-11-22T13:00:00Z', history: '[]', ...extra });
function tellDoor({ rows, claimed = true, fail = null, answer = {} }) {
  return door((name, input) => {
    if (name in answer) return answer[name];
    const notice = name === 'tool:run-sql-in-my-database' && input.sql.startsWith('insert into notices');
    if (fail === name || (fail === 'notice' && notice)) throw Object.assign(new Error(`${name} refused`), { code: 'tools_run_input_refused' });
    if (notice) return { rows: [{ notification_id: 'told:1' }], row_count: 1 };
    if (name === 'tool:run-sql-in-my-database') {
      if (input.sql.includes('due_tells')) return { rows, row_count: rows.length };
      if (input.sql.startsWith('INSERT INTO tells')) return claimed ? { rows: [{ call_now: input.params[4], write_now: !input.params[4] }], row_count: 1 } : { rows: [], row_count: 0 };
      return { rows: [], row_count: 1 };
    }
    if (name === 'tool:ask-a-model') return { choices: [{ message: { role: 'assistant', content: '{"subject":"Our call","text":"See you then."}' } }] };
    if (name === 'tool:find-mail') return { messages: [{ subject: 'Your call', to: address('bo') }] };
    if (name === 'tool:read-calendar-events') return { blocks: [{ title: 'Call with Bo', start: '2026-11-21T13:00:00Z' }] };
    if (name === 'tool:score-writing-with-a-voice-adapter') return { result: { paragraph_scores: [{ index: 0, chars: 40, p_pass: 0.8 }], body_min: 0.8 } };
    if (name === 'tool:judge-against-rules') return { passed: true, status: 'passed', findings: [], lines: [], said: 'clean' };
    if (name === 'tool:save-a-mail-draft') return { draft_id: 'draft-1', message_id: null, thread_id: null };
    if (name === 'tool:delete-a-mail-draft') return { deleted: true };
    throw new Error(`no stand-in for ${name}`);
  });
}
const tellRun = d => runAsTheTool(wake(TELL, 'every-five-minutes', { schedule_id: 'x' }, 'clock::due@1', SETTINGS), d);
const MADE = ['CREATE', 'CREATE', 'alter'];
const DRAFTED = [...MADE, 'WITH', 'INSERT', 'tool:find-mail', 'tool:read-calendar-events', 'tool:ask-a-model', 'tool:score-writing-with-a-voice-adapter', 'tool:judge-against-rules', 'tool:save-a-mail-draft', 'notice'];
const asked = d => d.calls.map(call => call.name !== 'tool:run-sql-in-my-database' ? call.name : call.input.sql.startsWith('insert into notices') ? 'notice' : call.input.sql.split(/\s/)[0]);
/** A notice's own fields, from the insert's params ($1 kind, $2 title, $3 body, $4 key). */
const noticeOf = call => ({ credential_name: call.input.credential_name, kind: call.input.params[0], title: call.input.params[1], body: call.input.params[2], key: call.input.params[3] });

test('a settled person is told once: a checked draft to the address used last, in the owner\'s mailbox, and a notice that it is there', async () => {
  const d = tellDoor({ rows: [due(false)] });
  const run = await tellRun(d);
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(asked(d), DRAFTED);
  assert.equal(d.calls[0].input.credential_name, 'my-notices-connection', 'the notices table is made where the person keeps their notices');
  assert.equal(d.calls[3].input.credential_name, 'my-history-connection', 'the history is the one the person switched on with');
  assert.equal(d.calls[5].input.text, `to:${address('bo.work')}`);
  assert.deepEqual(d.calls[9].input.rules, SETTINGS.phrase_rules);
  assert.match(d.calls[7].input.messages[1].content, /Mail already sent to them: .*Your call.*Calendar: .*Call with Bo/);
  const save = d.calls.at(-2).input;
  const notice = noticeOf(d.calls.at(-1));
  assert.equal(save.to, address('bo.work'));
  assert.equal(save.subject, 'Our call');
  assert.equal(notice.key, 'history:person:person:bo:9', 'one notice per person and change: telling it again keeps no second');
  assert.equal(notice.credential_name, 'my-notices-connection');
  assert.equal(notice.kind, 'needs-you');
  assert.match(notice.title, /draft to .* is in your mailbox: moved the call/);
  assert.match(notice.body, /sending it is your yes\. Voice score \(lowest paragraph\): 0\.8\. Phrase rules: clean\. Draft id: draft-1/);
});

test('a next call sooner than soon_minutes is a call to make now, with no draft', async () => {
  const d = tellDoor({ rows: [due(true)] });
  assert.equal((await tellRun(d)).status, 'completed');
  assert.deepEqual(asked(d), [...MADE, 'WITH', 'INSERT', 'notice']);
  assert.match(noticeOf(d.calls.at(-1)).title, /^Call .* now: their call starts at Sat Nov 21, 7:00 AM America\/Chicago$/);
  const read = d.calls.find((call) => call.name === 'tool:run-sql-in-my-database' && call.input.sql.includes('due_tells'));
  assert.equal(read.input.params[2], 'America/Chicago', 'the owner\'s time zone from the switch says every time a notice or draft names');
});

test('changes already told are not told again: the claim refuses and nothing is drafted or told', async () => {
  const d = tellDoor({ rows: [due(false)], claimed: false });
  assert.equal((await tellRun(d)).status, 'completed');
  assert.deepEqual(asked(d), [...MADE, 'WITH', 'INSERT']);
});

test('a draft is made from the history when mail, calendar, voice or phrase steps cannot run; only no model answer means no draft', async () => {
  for (const failing of ['tool:find-mail', 'tool:read-calendar-events', 'tool:score-writing-with-a-voice-adapter', 'tool:judge-against-rules']) {
    const d = tellDoor({ rows: [due(false)], fail: failing });
    assert.equal((await tellRun(d)).status, 'completed');
    assert.ok(asked(d).includes('tool:ask-a-model'), failing);
    assert.deepEqual(asked(d).slice(-2), ['tool:save-a-mail-draft', 'notice'], failing);
    assert.match(noticeOf(d.calls.at(-1)).title, /draft to .* is in your mailbox/, failing);
    if (failing === 'tool:score-writing-with-a-voice-adapter') assert.match(noticeOf(d.calls.at(-1)).body, /Voice score \(lowest paragraph\): not scored: no voice scorer answered on this computer\. Phrase rules: clean\./);
    if (failing === 'tool:judge-against-rules') assert.match(noticeOf(d.calls.at(-1)).body, /Voice score \(lowest paragraph\): 0\.8\. Phrase rules: not checked: no phrase rules were given, or the check could not run\./);
  }
  const noMailbox = tellDoor({ rows: [due(false)], fail: 'tool:save-a-mail-draft' });
  assert.equal((await tellRun(noMailbox)).status, 'completed');
  assert.deepEqual(asked(noMailbox).slice(-2), ['tool:save-a-mail-draft', 'notice']);
  assert.match(noticeOf(noMailbox.calls.at(-1)).body, /^No mailbox took the draft, so here it is\. Subject: .+\. Text: .+\. Voice score/);
  const noScore = tellDoor({ rows: [due(false)], answer: { 'tool:score-writing-with-a-voice-adapter': { result: null } } });
  assert.equal((await tellRun(noScore)).status, 'completed');
  assert.match(noticeOf(noScore.calls.at(-1)).body, /Voice score \(lowest paragraph\): not scored: the voice scorer answered with no score\./);
  const noModel = tellDoor({ rows: [due(false)], fail: 'tool:ask-a-model' });
  assert.equal((await tellRun(noModel)).status, 'completed');
  assert.deepEqual(asked(noModel).slice(-2), ['tool:ask-a-model', 'notice']);
  assert.match(noticeOf(noModel.calls.at(-1)).body, /^No draft was made/);
  const told = tellDoor({ rows: [due(false)], fail: 'notice' });
  await tellRun(told);
  assert.deepEqual(asked(told).slice(-3), ['notice', 'DELETE', 'tool:delete-a-mail-draft']);
  assert.equal(told.calls.at(-1).input.draft_id, 'draft-1');
});

test("every kind the noticer's example booking waiter gives a change is one some workflow's fires_when reads", () => {
  const kit = JSON.parse(readFileSync(new URL('../../notice-when-something-shows-up/kits/notice-when-something-shows-up.json', import.meta.url), 'utf8'));
  const waiter = kit.worked_examples.at(-1).mcp.input.input.input.waiters[0];
  const given = new Set(waiter.mechanism_settings.shape.kinds.flatMap(rule => rule.kinds));
  const workflows = JSON.parse(readFileSync(new URL('../recipes/workflows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const read = new Set(JSON.stringify(workflows.map(row => row.fires_when ?? [])).match(/"values":\[[^\]]*\]/g).flatMap(list => JSON.parse(list.slice(9))));
  assert.ok(given.size > 0);
  for (const kind of given) assert.ok(read.has(kind), `${kind} is read by a workflow's fires_when`);
});

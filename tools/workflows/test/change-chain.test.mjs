// The change chain over a stand-in door: a labelled change is routed under its own event id and kept; each settled
// person is told once with one ready action (a call when the next call is soon, else a scored, saved draft); a failed
// notice gives its claim back and removes its draft; only the owner's yes sends. Made-up rows; nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAsTheTool } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';

const recipe = name => JSON.parse(readFileSync(new URL(`../recipes/${name}.json`, import.meta.url), 'utf8')).records[0].payload;
const KEEP = recipe('keep-each-told-change-in-the-history');
const TELL = recipe('tell-the-owner-what-changed-for-each-person');
const SEND = recipe('send-what-the-owner-said-yes-to');
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
const wake = (row, id, fact, eventId, extra = {}) => ({ run: { row: row.id, ...wakeOf(row, id).input, ...extra }, woken_by: { kind: 'x', event_id: eventId, payload: fact, coalesced: 0 } });

test('a labelled change is routed under the event id it was told by, so two changes of one booking are two choices', async () => {
  const fact = change => ({ kind: 'something-changed', where: 'my-booking-service-key', place: 'booking', change, at: '2026-11-19T13:00:00.000Z', key: '101', after: JSON.stringify({ id: 101 }), kinds: JSON.stringify(change === 'added' ? ['call-booked'] : ['booking-changed']) });
  const told = [];
  for (const [change, id] of [['added', 'where::something-changed@my-booking-service-key:booking:101:added:a'], ['changed', 'where::something-changed@my-booking-service-key:booking:101:changed:b']]) {
    const d = door(() => ({}));
    const run = await runAsTheTool(wake(ROUTER, 'a-row-changed', fact(change), id), { door: d });
    assert.equal(run.status, 'completed', run.error_message);
    told.push(...d.calls.filter(call => call.name === 'wake:arrive').map(call => call.input));
  }
  const kept = told.filter(fact => fact.payload.workflow === KEEP.id);
  assert.equal(kept.length, 2, 'the keeping workflow is chosen for both changes');
  assert.notEqual(kept[0].event_id, kept[1].event_id);
  assert.deepEqual(Object.keys(kept[1].payload).sort(), ['after', 'change', 'condition', 'key', 'kinds', 'place', 'where', 'workflow']);
  assert.equal(kept[1].payload.kinds, '["booking-changed"]');
  assert.ok(told.some(fact => fact.payload.workflow === 'workflow:contact-a-booker-right-after-they-book'), 'call-booked chooses the booking workflows by their own fires_when');
});

test('a change handed to the router directly, with no fact behind it, is named by its own key', async () => {
  const d = door(() => ({}));
  const run = await runAsTheTool({ run: { row: ROUTER.id, start_at: 'choose', fact: { where: 'w', place: 'booking', change: 'added', key: 'k-1', kinds: '["call-booked"]' } } }, { door: d });
  assert.equal(run.status, 'completed', run.error_message);
  const kept = d.calls.find(call => call.name === 'wake:arrive' && call.input.payload.workflow === KEEP.id);
  assert.equal(kept.input.event_id, `k-1:${KEEP.id}:a change a source told carries kinds`);
});

test('a thought with kinds but no source and no change is not a told change', async () => {
  const { chosen } = await chooseTheWorkflowsThatFire({ parts: [{ words: 'a note', kinds: ['call-booked'] }] });
  assert.equal(chosen.some(item => item.workflow === KEEP.id), false);
});

test('a kept change is one statement of the told change, keyed by where, place, key, change and what it carried', async () => {
  const d = door(() => ({ columns: ['id', 'meaning'], rows: [{ id: 1, meaning: 'booked' }], row_count: 1 }));
  const fact = { workflow: KEEP.id, where: 'my-booking-service-key', place: 'booking', change: 'added', key: '101', after: '{"id":101}', kinds: '["call-booked"]' };
  const run = await runAsTheTool(wake(KEEP, 'chosen--a-change-a-source-told-carries-kinds', fact, 'f1'), { door: d });
  assert.equal(run.status, 'completed', run.error_message);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].input.credential_name, 'own-rows-postgres-connection');
  assert.deepEqual(d.calls[0].input.params, ['my-booking-service-key', 'booking', 'added', '101', '{"id":101}']);
  assert.match(d.calls[0].input.sql, /ON CONFLICT \(source, told\) DO NOTHING/);
});

const SETTINGS = { voice: { adapter: '/opt/example-adapter', base_model: '/opt/example-model', criterion: { id: 'x' }, min_paragraph_chars: 40, decider_common_dir: '/opt/example-decider' },
  mail: { provider: 'gmail', connection: { connection_id: 'service_connection:google-account:example' } } };
const due = (soon, extra = {}) => ({ thing_scheme: 'person', thing_value: 'person:bo', through: 9, meanings: ['booked', 'cancelled'], words: 'moved the call', addresses: address('bo'), address: address('bo.work'),
  next_call_at: '2026-11-21T13:00:00.000Z', soon, history: '[]', ...extra });
function tellDoor({ rows, claimed = true, fail = null }) {
  return door((name, input) => {
    if (fail === name) throw Object.assign(new Error(`${name} refused`), { code: 'tools_run_input_refused' });
    if (name === 'tool:run-sql-in-my-database') {
      if (input.sql.includes('due_tells')) return { rows, row_count: rows.length };
      if (input.sql.startsWith('INSERT INTO tells')) return claimed ? { rows: [{ call_now: input.params[4], write_now: !input.params[4] }], row_count: 1 } : { rows: [], row_count: 0 };
      return { rows: [], row_count: 1 };
    }
    if (name === 'tool:ask-a-model') return { choices: [{ message: { role: 'assistant', content: '{"subject":"Our call","text":"See you then."}' } }] };
    if (name === 'tool:score-writing-with-a-voice-adapter') return { paragraph_scores: [{ p_pass: 0.8 }], body_min: 0.8 };
    if (name === 'tool:save-a-mail-draft') return { draft_id: 'draft-1', message_id: null, thread_id: null };
    return { told: true };
  });
}
const tellRun = d => runAsTheTool(wake(TELL, 'every-five-minutes', { schedule_id: 'x' }, 'clock::due@1', SETTINGS), { door: d });
const asked = d => d.calls.map(call => call.name === 'tool:run-sql-in-my-database' ? call.input.sql.split(/\s/)[0] : call.name);

test('a settled person is told once: a scored, saved draft to the address used last, and a notice about that draft', async () => {
  const d = tellDoor({ rows: [due(false)] });
  const run = await tellRun(d);
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(asked(d), ['WITH', 'INSERT', 'tool:ask-a-model', 'tool:score-writing-with-a-voice-adapter', 'tool:save-a-mail-draft', 'tool:tell-the-person']);
  const [save, notice] = d.calls.slice(-2).map(call => call.input);
  assert.equal(save.to, address('bo.work'));
  assert.equal(save.subject, 'Our call');
  assert.deepEqual(notice.about, { kind: 'mail-draft', id: 'draft-1' });
  assert.equal(notice.key, 'history:person:person:bo:9');
  assert.match(notice.title, /moved the call/);
});

test('a next call sooner than soon_minutes is a call to make now, with no draft', async () => {
  const d = tellDoor({ rows: [due(true)] });
  assert.equal((await tellRun(d)).status, 'completed');
  assert.deepEqual(asked(d), ['WITH', 'INSERT', 'tool:tell-the-person']);
  assert.match(d.calls.at(-1).input.title, /^Call .* now: their call starts at 2026-11-21T13:00:00.000Z$/);
});

test('changes already told are not told again: the claim refuses and nothing is drafted or told', async () => {
  const d = tellDoor({ rows: [due(false)], claimed: false });
  assert.equal((await tellRun(d)).status, 'completed');
  assert.deepEqual(asked(d), ['WITH', 'INSERT']);
});

test('a notice that failed gives its claim back and removes its draft; a draft that failed gives the claim back only', async () => {
  const told = tellDoor({ rows: [due(false)], fail: 'tool:tell-the-person' });
  await tellRun(told);
  assert.deepEqual(asked(told).slice(-3), ['tool:tell-the-person', 'DELETE', 'tool:delete-a-mail-draft']);
  assert.equal(told.calls.at(-1).input.draft_id, 'draft-1');
  const drafted = tellDoor({ rows: [due(false)], fail: 'tool:ask-a-model' });
  await tellRun(drafted);
  assert.deepEqual(asked(drafted), ['WITH', 'INSERT', 'tool:ask-a-model', 'DELETE']);
});

test("only the owner's yes sends, once, and the history keeps that it went", async () => {
  assert.deepEqual(wakeOf(SEND, 'the-owner-said-yes').on, { fact: { kind: 'owner-said-yes', from: ['sender'] } });
  const d = door(name => (name === 'tool:send-a-mail-draft' ? { message_id: 'message-1', thread_id: null } : { rows: [{ id: 2 }], row_count: 1 }));
  const fact = { draft_id: 'draft-1', provider: 'gmail', connection_id: 'service_connection:google-account:example', to: address('ana') };
  const run = await runAsTheTool(wake(SEND, 'the-owner-said-yes', fact, 'yes:draft-1'), { door: d });
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(d.calls[0], { name: 'tool:send-a-mail-draft', input: { provider: 'gmail', connection: { connection_id: fact.connection_id }, draft_id: 'draft-1' } });
  assert.deepEqual(d.calls[1].input.params, ['draft-1', 'message-1', address('ana')]);
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

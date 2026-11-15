import test from 'node:test';
import assert from 'node:assert/strict';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import fixtures from './policy-fixtures.json' with { type: 'json' };
import { createHQSharing } from '../read-data/hq-sharing.mjs';
import { createJourney } from '../read-data/journey.mjs';
import { createHandToAccount } from '../read-data/hand-to-an-account.mjs';
import { createCustomersHQ } from '../read-data/customers-hq.mjs';
import { createFormerNamesCounter } from '../read-data/former-names-count.mjs';
import { journeyRecords } from '../do-work/journey-records.mjs';

const ops = ['records:read', 'records:list', 'records:write'];
async function world(t, types) {
  const fake = await startFakeDoor({ rights: types.map(kind => ({ kind, operations: ops })), pageCut: 1 });
  t.after(fake.close);
  return { fake, door: openRecordsDoor({ descriptor: fake.descriptor }) };
}
const invoke = fixtures.tray.records[0].payload.invoke;
const report = (note = 'Original report') => ({ invoke, from: { ref: 'authenticated-account', user: 'member', name: 'Member' }, things: [], note, where: 'Files', screen: '', browser: '', more: { kind: 'friction' }, capture: { submission_id: 'task:1', execution_ref: 'execution:1', origin: 'synthetic' }, at: '2026-10-08T03:00:00.000Z', sent_by: 'ai', harness: 'Codex', their_words: 'their words' });
const handoffs = createHandToAccount(fixtures.reports, { recordJourney: async () => {}, reportKindOf: value => value });

test('live scoped sharing choices require the signed-in account, preserve defaults, erase on off and never share content without activity', async t => {
  const { door, fake } = await world(t, ['hq-sharing', 'customer-journey']);
  const choices = createHQSharing(fixtures.sharing);
  const journey = createJourney(fixtures.reports, choices);
  const env = { account: 'member', sharingDoor: door, operatorAccount: 'hq' };
  env.journeyLog = shard => journeyRecords(door, fixtures.reports.journey, shard);
  env.forgetJourney = (account, options) => journey.forgetJourney(env, account, options);
  assert.deepEqual(await choices.readSharing(env, 'member'), { activity: true, content: false, set_at: null, via: 'default' });
  await choices.writeDefaultSharing(env, 'member');
  await choices.writeSharing(env, 'member', { content: true });
  assert.equal(await journey.recordJourney(env, 'member', [{ kind: 'report', facts: { kind: 'bug' }, words: { note: 'private' } }]), 1);
  assert.equal([...fake.kept.values()].filter(row => row.type === 'customer-journey').length, 1);
  assert.equal((await choices.writeSharing(env, 'member', { activity: false })).content, false);
  assert.equal([...fake.kept.values()].filter(row => row.type === 'customer-journey').length, 0);
  assert.equal((await choices.writeSharing(env, 'member', { content: true })).content, false);
  await assert.rejects(choices.writeSharing(env, 'other', { activity: true }), /signed-in account/);
  assert.equal(await journey.recordJourney(env, 'member', [{ kind: 'tool_run', facts: { tool: 'later' } }]), 0);
});

test('an unsuccessful erasure is surfaced after the live choice is already off', async t => {
  const { door } = await world(t, ['hq-sharing']);
  const choices = createHQSharing(fixtures.sharing);
  const env = { account: 'member', sharingDoor: door, forgetJourney: async () => { throw new Error('erasure refused'); } };
  await assert.rejects(choices.writeSharing(env, 'member', { activity: false }), /erasure refused/);
  assert.equal((await choices.readSharing(env, 'member')).activity, false);
});

test('journey rows over paged door preserve source summaries, trouble ordering, retention and word consent', async t => {
  const { door, fake } = await world(t, ['customer-journey']);
  const now = Date.now();
  const policy = fixtures.reports.journey;
  const journey = createJourney(fixtures.reports, { readSharing: async () => ({ activity: true, content: false }) });
  let choiceReads = 0;
  const operator = createJourney(fixtures.reports, { readSharing: async () => { choiceReads++; return { activity: true }; } });
  const env = { operatorAccount: 'hq', journeyLog: shard => journeyRecords(door, policy, shard) };
  assert.equal(await operator.recordJourney(env, 'hq', [{ kind: 'tool_run' }]), 0);
  assert.equal(choiceReads, 0);
  await journey.recordJourney(env, 'a', [
    { kind: 'report', facts: { kind: 'bug' }, words: { note: 'not allowed' }, at: now - 20 },
    { kind: 'client_error', facts: { path: '/files', category: 'script' }, at: now - 10 },
    { kind: 'tool_run', facts: { tool: 'old' }, at: now - (policy.keep_days + 1) * 86400000 },
  ]);
  await journey.recordJourney(env, 'b', [{ kind: 'tool_run', facts: { tool: 'new' }, at: now }]);
  const read = await journey.readJourneys(env, now);
  assert.deepEqual(read.map(row => row.account), ['a', 'b']);
  assert.equal(read[0].struggling, true);
  assert.equal(read[0].total, 2);
  assert.equal(read[0].recent, 2);
  assert.deepEqual(read[0].by_kind, { client_error: 1, report: 1 });
  assert.deepEqual(read[0].timeline.map(row => row.kind), ['client_error', 'report']);
  assert.ok(!JSON.stringify(read).includes('not allowed'));
  let removed = 0;
  for (let shard = 0; shard < policy.shards; shard++) removed += (await env.journeyLog(shard).sweep({ now })).removed;
  assert.equal(removed, 1);
  assert.equal([...fake.kept.values()].filter(row => row.type === 'customer-journey').length, 3);
});

test('a report retry repairs work joins without replacing report, review or outcome; conflicting replay is refused', async t => {
  const kind = `record:${invoke.list.row_type ?? invoke.list.id}`;
  const { door } = await world(t, ['list', kind]);
  let fails = true, notices = 0;
  const owners = { door, tools: [{ invoke }], keep: async file => ({ name: file.name }), tell: async () => { notices++; }, handOff: async () => { if (fails) throw new Error('work unavailable'); return { handoff: { handoff_id: 'work:1' } }; } };
  await assert.rejects(handoffs.keepHandOffOverDoor(owners, report()), /work unavailable/);
  const stored = [];
  for await (const row of door.list({ type: kind })) stored.push(row);
  assert.equal(stored.length, 1);
  const record = stored[0];
  assert.equal(record.value.note, 'Original report');
  await door.write([{ ...record, value: { ...record.value, review: 'approved', outcome: 'kept outcome' }, expected: { type: kind, value: record.value } }]);
  fails = false;
  const kept = await handoffs.keepHandOffOverDoor(owners, report());
  const after = await door.read(kind, kept.source_ref);
  assert.equal(after.review, 'approved');
  assert.equal(after.outcome, 'kept outcome');
  assert.equal(after.note, 'Original report');
  assert.equal(after.harness, 'Codex');
  assert.equal(after.sent_by, 'ai');
  assert.equal(after.their_words, 'their words');
  assert.equal(kept.work_ref, 'work:1');
  assert.equal(notices, 2);
  await assert.rejects(handoffs.keepHandOffOverDoor(owners, report('different report')), /different report/);
  await assert.rejects(handoffs.keepHandOffOverDoor(owners, { ...report(), invoke: { ...invoke, said: 'forged' } }), /not one Trillion sends/);
  assert.equal((await door.read(kind, kept.source_ref)).note, 'Original report');
});

test('the former-name counter keeps only closed-table ids and suppresses repeated names within its interval', async () => {
  const sent = [];
  const counter = createFormerNamesCounter({ formerNames: () => ({ ids: ['old-tool'], note_every_minutes: 1 }), serverEvent: (kind, facts) => ({ kind, facts }), noteInteractions: async (_, events) => sent.push(...events) });
  await counter.countFormerIds({}, ['unregistered-private-input', 'old-tool', 'old-tool'], 100);
  assert.deepEqual(sent, [{ kind: 'former_id_used', facts: { former_id: 'old-tool' } }]);
  assert.equal(counter.countFormerIds({}, ['old-tool'], 200), null);
  await counter.countFormerIds({}, ['old-tool'], 60101);
  assert.equal(sent.length, 2);
});

test('the Customers entry refuses every nonoperator before it reads reports, names or journeys', async () => {
  let reads = 0;
  const hq = createCustomersHQ(fixtures.reports, { readJourneys: async () => { reads++; return []; }, htmlPage: (page, headers) => ({ page, headers }) });
  const env = { operatorAccount: 'hq', own: { memberReports: async () => { reads++; return []; } }, accountName: async () => { reads++; return null; } };
  const url = new URL('https://app.example/work/api/customers');
  const request = new Request(url);
  const refused = await hq.answerCustomers(request, { env, userId: 'other', url, origin: url.origin });
  assert.equal(refused.status, 404);
  assert.equal(reads, 0);
  const allowed = await hq.answerCustomers(request, { env, userId: 'hq', url, origin: url.origin });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { reports: [], report_count: 0, customers: [] });
  const page = hq.customersPage({ reports: [], customers: [] }, url.origin);
  assert.equal(page.headers['x-trillion-privacy'], 'customer-scope');
});

test('required erasure cannot succeed without its authorized log, and a retry finishes after an erasure failure', async t => {
  const journey = createJourney(fixtures.reports, { readSharing: async () => ({ activity: false }) });
  await assert.rejects(journey.forgetJourney({}, 'member', { required: true }), /authorized journey log/);
  assert.equal(await journey.forgetJourney({}, 'member'), 0);
  const { door } = await world(t, ['hq-sharing']);
  const choices = createHQSharing(fixtures.sharing);
  let attempts = 0;
  const env = { account: 'member', sharingDoor: door, forgetJourney: async (_, { required }) => {
    assert.equal(required, true);
    if (++attempts === 1) throw new Error('temporarily unavailable');
  } };
  await assert.rejects(choices.writeSharing(env, 'member', { activity: false }), /temporarily unavailable/);
  assert.equal((await choices.readSharing(env, 'member')).activity, false);
  await choices.writeSharing(env, 'member', { activity: false });
  assert.equal(attempts, 2);
});

test('unavailable customer reports and journey bindings stay failures through the Customers consumer', async () => {
  const journey = createJourney(fixtures.reports, { readSharing: async () => ({ activity: true }) });
  await assert.rejects(journey.readJourneys({}), /authorized journey log/);
  const hq = createCustomersHQ(fixtures.reports, { readJourneys: async () => [], htmlPage: value => value });
  const url = new URL('https://app.example/work/api/customers');
  const env = { operatorAccount: 'hq', own: { memberReports: async () => { throw new Error('reports unavailable'); } } };
  await assert.rejects(hq.answerCustomers(new Request(url), { env, userId: 'hq', url, origin: url.origin }), /reports unavailable/);
});

test('sharing reads always see their current door and failed writes cannot change a live consent choice', async t => {
  const first = await world(t, ['hq-sharing']);
  const second = await world(t, ['hq-sharing']);
  const choices = createHQSharing(fixtures.sharing);
  const env = door => ({ account: 'member', sharingDoor: door, forgetJourney: async () => {} });
  await choices.writeSharing(env(first.door), 'member', { activity: false });
  assert.equal((await choices.readSharing(env(first.door), 'member')).activity, false);
  assert.equal((await choices.readSharing(env(second.door), 'member')).activity, true);
  const stale = await first.door.readRecord('hq-sharing', 'hq-sharing:member');
  const conflictingDoor = {
    readRecord: async () => stale,
    write: async rows => {
      await choices.writeSharing(env(first.door), 'member', { activity: true });
      return first.door.write(rows);
    },
  };
  await assert.rejects(choices.writeSharing(env(conflictingDoor), 'member', { content: true }), /records changed/);
  assert.equal((await choices.readSharing(env(first.door), 'member')).content, false);
  assert.equal((await choices.readSharing(env(first.door), 'member')).activity, true);
});

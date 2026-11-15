import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAudienceSends, audienceToolOutcome, fillAudienceInput } from '../read-data/audience-sends.mjs';
import { audienceRecords } from '../read-data/audience-records.mjs';
import { audiencePolicy } from '../read-data/audience-policy.mjs';
import { readAudienceSendContent, checkedAudienceSendContent } from '../read-data/audience-send-content.mjs';

// Synthetic rows and admitted effect stand-ins; no provider or real recipient.
function fixture() {
  const rows = new Map(), writes = [], delivered = [], scheduled = [];
  const clock = { at: Date.parse('2026-10-04T10:00:00Z') };
  let rejectMarker = false, links = 0;
  const door = {
    async readRecord(type, id) { const row = rows.get(id); return row ? structuredClone({ type: row.type, value: row.value }) : null; },
    async read(type, id) { return (await this.readRecord(type, id))?.value ?? null; },
    async *list({ type }) { for (const row of rows.values()) if (row.type === type) yield structuredClone(row); },
    async write(records) {
      for (const row of records) {
        const before = rows.get(row.id);
        if (Object.hasOwn(row, 'expected') && JSON.stringify(row.expected) !== JSON.stringify(before ? { type: before.type, value: before.value } : null))
          throw Object.assign(new Error('conflict'), { code: 'original_command_conflict' });
        if (rejectMarker && Object.values(row.value?.channels ?? {}).some(channel => channel.unknown)) throw new Error('marker unavailable');
      }
      for (const row of records) { rows.set(row.id, structuredClone(row)); writes.push(structuredClone(row)); }
      return {};
    },
  };
  const content = { ...structuredClone(audiencePolicy),
    channels: [{ id: 'email', road: 'test', address: 'email', label: 'Email' }],
    timings: ['manual', 'now', 'at', 'each_new'], audience_states: { sent: { label: 'Reached' }, opened: { label: 'Opened' } },
    words: { saved: 'Saved {count}', done: '{sent} sent', asked_not_to: 'Suppressed', yourself: 'Yourself' }, screen: {},
  };
  const host = {
    content, now: () => clock.at, lists: { rowsOf: async () => { throw new Error('not used'); } },
    isShareable: async () => ({ title: 'Test record' }), isPriced: async () => false,
    makeLink: async () => ({ share_id: `s${++links}`, address: `https://example.invalid/${links}` }),
    linkState: async () => ({ opened: true }), linkOpen: async () => true,
    roads: { test: async (row, facts) => { delivered.push(facts); return { sent: true }; } },
    experiments: {}, automations: { schedule: async value => { scheduled.push(value); return { schedule_id: 'later' }; }, forget: async () => ({}) },
  };
  const owner = (extra = {}) => makeAudienceSends({ ...host, ...extra, eeaf: audienceRecords(door) });
  const save = extra => owner().save({ record: 'note:test', audience: [{ people: [{ email: 'ANA@example.invalid' }] }], channels: ['email'], when: 'manual', ...extra });
  return { door, rows, writes, delivered, scheduled, clock, content, host, owner, save, rejectMarker: () => { rejectMarker = true; } };
}

test('independent door clients claim once and normalize the recipient', async () => {
  const f = fixture(), { send } = await f.save();
  await Promise.allSettled([f.owner().run({ send_id: send.id }), f.owner().run({ send_id: send.id })]);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0].to, 'ana@example.invalid');
  const result = await f.owner().results({ send_id: send.id });
  assert.equal(result.totals.sent, 1);
  assert.equal(result.people[0].opened, true);
  assert.equal((await f.owner().run({ send_id: send.id })).sent, 0);
});

test('possible dispatch is durably marked before a road and never replayed after a lost result', async () => {
  const f = fixture(), { send } = await f.save();
  let called = 0;
  const owner = () => f.owner({ roads: { test: async () => {
    called++;
    assert.ok(f.writes.some(row => Object.values(row.value?.channels ?? {}).some(channel => channel.unknown === true)));
    throw new Error('lost reply');
  } } });
  assert.equal((await owner().run({ send_id: send.id })).unknown, 1);
  f.clock.at += 20 * 60_000;
  await owner().run({ send_id: send.id });
  assert.equal(called, 1);
});

test('a refused dispatch marker prevents the effect', async () => {
  const f = fixture(), { send } = await f.save();
  f.rejectMarker();
  await f.owner().run({ send_id: send.id });
  assert.equal(f.delivered.length, 0);
});

test('a stale process cannot overwrite a new claimant and dispatch twice', async () => {
  const f = fixture(), { send } = await f.save();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const old = f.owner({ makeLink: async () => { entered(); await pending; return { share_id: 'old', address: 'https://example.invalid/old' }; } });
  const oldRun = old.run({ send_id: send.id });
  await started;
  f.clock.at += 20 * 60_000;
  await f.owner().run({ send_id: send.id });
  release();
  await assert.rejects(oldRun, /conflict/);
  assert.equal(f.delivered.length, 1);
});

test('changed current channel and opted-out addresses cannot dispatch', async () => {
  const f = fixture(), { send } = await f.save();
  await f.owner().do_not_send({ address: 'ANA@example.invalid' });
  assert.equal((await f.owner().run({ send_id: send.id })).skipped, 1);
  const second = await f.save({ audience: [{ people: [{ email: 'ben@example.invalid' }] }] });
  const changed = structuredClone(f.content); changed.channels[0].input = { changed: true };
  assert.equal((await f.owner({ content: changed }).run({ send_id: second.send.id })).failed, 1);
  assert.equal(f.delivered.length, 0);
});

test('actual receipt import is bounded, normalized and never overwrites an attempt', async () => {
  const f = fixture(), { send } = await f.save();
  const input = { send_id: send.id, receipts: [{ key: 'ANA@example.invalid', email: 'ANA@example.invalid', source_ref: 'fixture:observed', at: '2026-10-01T00:00:00Z', state: 'sent' }] };
  assert.deepEqual((await f.owner().import_receipts(input)).kept, ['ana@example.invalid']);
  assert.deepEqual((await f.owner().import_receipts(input)).existing, ['ana@example.invalid']);
  assert.equal((await f.owner().run({ send_id: send.id })).sent, 0);
  assert.equal((await f.owner().results({ send_id: send.id })).totals.unconfirmed_channels, 0);
});

test('content comes from rows, missing rows remain empty, and outages propagate', async () => {
  const f = fixture();
  for (const key of ['channels', 'timings', 'audience_states', 'words', 'screen']) await f.door.write([{ id: `audience-send-content:${key}`, type: 'audience-send-content', value: { content: f.content[key] } }]);
  assert.deepEqual((await readAudienceSendContent(f.door)).channels, f.content.channels);
  f.rows.delete('audience-send-content:channels');
  assert.deepEqual((await readAudienceSendContent(f.door)).channels, []);
  await assert.rejects(readAudienceSendContent({ read: async () => { throw new Error('offline'); } }), /offline/);
  assert.throws(() => checkedAudienceSendContent({ ...f.content, channels: [{ ...f.content.channels[0], outcome: { sent: '__proto__.sent' } }] }));
});

test('a tool contract and templates retain explicit delivery acknowledgement and safe paths', () => {
  assert.equal(audienceToolOutcome({ state: 'completed', contract: { passed: true }, output: {} }, { label: 'Fixture' }).unknown, true);
  assert.deepEqual(fillAudienceInput({ number: '{person.count}' }, { person: { count: 4 } }), { number: 4 });
  assert.throws(() => fillAudienceInput('{__proto__.value}', {}));
});

// Proof of workflow:send-each-new-notice-to-my-devices (tools/workflows/recipes): the recipe runs on the workflow host as a
// due time wakes it, its statements run on PGlite (a plain PostgreSQL), and tool:send-notification-to-my-devices is a stand-in
// that keeps what it was asked. Each new unread notice goes once to each registered phone or browser made before it;
// a live device, a device registered after the notice and a notice already sent are left alone. Made-up devices only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { runAsTheTool } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';

const SEND = JSON.parse(readFileSync(new URL('../recipes/send-each-new-notice-to-my-devices.json', import.meta.url), 'utf8')).records[0].payload;
const wake = SEND.wakes.find(item => item.id === 'every-five-minutes');
const SWITCH = { store: { credential_name: 'my-notices-connection' }, audience: 'person:me' };

function door(db, sent, outcome = () => 'sent') {
  return {
    async run(name, input) {
      if (name === 'tool:run-sql-in-my-database') {
        assert.equal(input.credential_name, 'my-notices-connection');
        // node-postgres (tools/run-sql-in-my-database) sends a list as a Postgres array and an object as text it was never
        // meant to be, so a statement that reads JSON must be handed JSON text: a list or object param is refused here, as
        // the live run refused one on Nov 19 2026 ("invalid input syntax for type json").
        for (const value of input.params ?? []) assert.ok(value === null || typeof value !== 'object', `a param is JSON text, not ${JSON.stringify(value).slice(0, 40)}`);
        const result = await db.query(input.sql, input.params ?? []);
        return { rows: result.rows, row_count: result.affectedRows ?? result.rows.length };
      }
      if (name === 'tool:send-notification-to-my-devices') {
        sent.push(input);
        // As the tool answers: each route's device_results, and the devices its push service said are gone.
        const results = input.devices.map(device => ({ device_id: device.device_id, stage: outcome(device.device_id) === 'gone' ? 'not-sent' : outcome(device.device_id), ...(outcome(device.device_id) === 'gone' ? { gone: true } : {}) }));
        const routes = {};
        for (const device of input.devices) (routes[device.route] ??= { device_results: [] }).device_results.push(results.find(result => result.device_id === device.device_id));
        const gone = results.filter(result => result.gone).map(result => result.device_id);
        return { notification_id: input.notification.notification_id, delivered: results.some(result => result.stage === 'sent'), stage: 'sent', routes, live_device_ids: [], gone_device_ids: gone, said: 'sent' };
      }
      throw new Error(`no stand-in for ${name}`);
    },
    async operation() { return { result: { admitted: true } }; },
  };
}
const fire = (db, sent, outcome) => runAsTheTool({ run: { row: SEND.id, ...SWITCH, ...wake.input }, woken_by: { kind: 'due-time', event_id: 'clock::due@1', payload: { schedule_id: 'x' }, coalesced: 0 } }, door(db, sent, outcome));

test('each new notice goes once to each phone and browser registered before it, and is kept as sent', async () => {
  const db = new PGlite();
  const sent = [];
  assert.equal((await fire(db, sent)).status, 'completed', 'the first run makes the tables and sends nothing');
  assert.deepEqual(sent, []);
  await db.query("INSERT INTO devices (id, platform, token, registered_at) VALUES ('phone', 'apns', 'abc123', now() - interval '1 hour'), ('browser', 'web-push', $1, now() - interval '1 hour'), ('mac', 'live', null, now() - interval '1 hour'), ('late', 'web-push', $1, now() + interval '1 hour')",
    [JSON.stringify({ endpoint: 'https://push.example.test/1', keys: { p256dh: 'p', auth: 'a' } })]);
  await db.query("INSERT INTO notices (title, body, kind, key) VALUES ('Bo cancelled the Friday call', 'Their history is ready.', 'needs-you', 'k1')");
  await db.query("INSERT INTO notices (title, device_id) VALUES ('Only for the phone', 'phone')");
  await db.query("INSERT INTO notices (title, read_at) VALUES ('Already read', now())");
  const run = await fire(db, sent);
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(sent.map(item => [item.notification.notification_id, item.notification.title, item.devices.map(device => device.device_id)]), [
    ['told:1', 'Bo cancelled the Friday call', ['browser', 'phone']],
    ['told:2', 'Only for the phone', ['phone']]]);
  assert.deepEqual(sent[0].devices.find(device => device.device_id === 'browser').address, { endpoint: 'https://push.example.test/1', keys: { p256dh: 'p', auth: 'a' } }, 'a browser is addressed by its push subscription');
  assert.equal(sent[0].devices.find(device => device.device_id === 'phone').address, 'abc123', 'a phone by its token');
  assert.deepEqual([sent[0].audience, sent[0].notification.audience_refs, sent[0].notification.kind], ['person:me', ['person:me'], 'needs-you']);
  assert.deepEqual((await db.query('SELECT notice_id::int AS n, device_id, stage FROM notice_sends ORDER BY 1, 2')).rows,
    [{ n: 1, device_id: 'browser', stage: 'sent' }, { n: 1, device_id: 'phone', stage: 'sent' }, { n: 2, device_id: 'phone', stage: 'sent' }]);
  assert.equal((await fire(db, sent)).status, 'completed');
  assert.equal(sent.length, 2, 'a notice sent to a device is not sent to it again');
});

test('a definite failure is tried again, three tries in all; an uncertain one is not; a gone device is sent nothing more', async () => {
  const db = new PGlite();
  const sent = [];
  await fire(db, sent);
  await db.query("INSERT INTO devices (id, platform, token, registered_at) VALUES ('flaky', 'apns', 't1', now() - interval '1 hour'), ('unsure', 'apns', 't2', now() - interval '1 hour'), ('old', 'web-push', $1, now() - interval '1 hour')",
    [JSON.stringify({ endpoint: 'https://push.example.test/old', keys: { p256dh: 'p', auth: 'a' } })]);
  await db.query("INSERT INTO notices (title) VALUES ('One thing')");
  const outcome = id => ({ flaky: 'not-sent', unsure: 'uncertain', old: 'gone' })[id];
  for (let run = 0; run < 4; run += 1) assert.equal((await fire(db, sent, outcome)).status, 'completed');
  assert.deepEqual(sent.map(item => item.devices.map(device => device.device_id)), [['flaky', 'old', 'unsure'], ['flaky'], ['flaky']]);
  assert.deepEqual((await db.query('SELECT device_id, stage, tries FROM notice_sends ORDER BY 1')).rows,
    [{ device_id: 'flaky', stage: 'not-sent', tries: 3 }, { device_id: 'old', stage: 'gone', tries: 1 }, { device_id: 'unsure', stage: 'uncertain', tries: 1 }]);
  assert.equal((await db.query("SELECT token FROM devices WHERE id = 'old'")).rows[0].token, null, 'a gone device keeps its row but no address');
  await db.query("INSERT INTO notices (title) VALUES ('Another thing')");
  await fire(db, sent, () => 'sent');
  assert.deepEqual(sent.at(-1).devices.map(device => device.device_id), ['flaky', 'unsure'], 'a gone device is not sent the next notice either');
});

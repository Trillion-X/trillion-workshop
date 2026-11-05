// Ported from old trillion test/own-ais-apps.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The person's AIs grouped by the AI app they connected (src/own-ais-apps.mjs here): one row per
// app, its sessions and agents under it as instances, the computer as where each runs, stale unnamed records in no row. The
// four grouping tests are the old ones. The last drew the Your AIs card of the catalogue screen tool:ai (old
// src/screen-reads.mjs aiSetupFacts through test/catalogue-screens-for-tests.mjs); no repository draws that screen now
// (searched aiSetupFacts, aiScreen, marketplace-screens in trillion-workshop tools/, trillion-apps web/, trillion-rust src/),
// so it is left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appsOf, appOfRow, whereOf } from '../src/own-ais-apps.mjs';

const NOW = new Date('2026-10-11T10:00:00.000Z');
const minutesAgo = minutes => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const row = (id, fields) => ({ id, kind: 'chat', order: 100, live: { seen_at: minutesAgo(1), how: 'heartbeat', minutes: 60, trouble: null }, ...fields });

test('each connected app is one row, and its sessions are instances under it', () => {
  const rows = [
    row('ai:claude-code', { key: 'claude-code', label: 'Claude Code', order: 1 }),
    row('ai:claude-session-2', { key: 'claude-session-2', label: 'Claude Code', order: 1, live: { seen_at: minutesAgo(400), how: 'heartbeat', minutes: 60, trouble: null } }),
    row('ai:take-open-work-macbook-pro-3', { key: 'take-open-work-macbook-pro-3', label: 'Codex on MacBook Pro 3', kind: 'cli', order: 2, agent_id: 'take-open-work-macbook-pro-3', runs_on: { device: 'device:macbook-pro-3', place: 'placement:your-computer' } }),
    row('ai:chatgpt-connector', { key: 'chatgpt-connector', label: 'ChatGPT connector', order: 3 }),
  ];
  const apps = appsOf(rows, { now: NOW });
  assert.deepEqual(apps.map(app => [app.app, app.live_now, app.instances.length]), [
    ['Claude Code', true, 2],
    ['Codex', true, 1],
    ['ChatGPT', true, 1],
  ]);
  const claude = apps[0];
  assert.deepEqual(claude.instances.map(item => [item.id, item.live_now]), [['ai:claude-code', true], ['ai:claude-session-2', false]],
    'a live session sorts first and the stale one is still an instance, never a row of its own');
  assert.equal(apps[1].instances[0].where, 'macbook-pro-3', 'the computer is where the instance runs');
  assert.equal(apps[1].label, 'Codex', 'the app name is the label, never the computer');
});

test('a stale unnamed record adds no row, and a live unnamed one joins the other group only while live', () => {
  const rows = [
    row('ai:eeaf-on-the-log-store', { key: 'eeaf-on-the-log-store', label: 'EEAF on the log store', live: { seen_at: minutesAgo(9_000), how: 'heartbeat', minutes: 60, trouble: null } }),
    row('ai:c', { key: 'c', label: 'c', live: { seen_at: minutesAgo(3), how: 'stream', trouble: null } }),
  ];
  const apps = appsOf(rows, { now: NOW });
  assert.deepEqual(apps.map(app => [app.id, app.app, app.label, app.instances.map(item => item.label)]), [['other', null, 'Other AIs', ['c']]]);
  assert.deepEqual(appsOf([rows[0]], { now: NOW }), [], 'an unnamed stale record is in no group');
});

test('an app whose only instances are stale is one not-live row, and the trouble of its newest instance is kept', () => {
  const rows = [row('ai:codex', { key: 'codex', label: 'Codex', live: { seen_at: minutesAgo(900), how: 'heartbeat', minutes: 60, trouble: 'out of credit' } })];
  const [app] = appsOf(rows, { now: NOW });
  assert.equal(app.live_now, false);
  assert.equal(app.trouble, 'out of credit');
});

test('app names come from the harness data, the longest name wins, and a computer name is never an app', () => {
  assert.equal(appOfRow({ label: 'Claude Code on Mac mini' }).app, 'Claude Code');
  assert.equal(appOfRow({ label: 'Claude on the web' }).app, 'Claude');
  assert.equal(appOfRow({ key: 'codex', label: 'Codex on claude-mini', runs_on: { device: 'device:claude-mini' } }).app, 'Codex', 'a computer named like another app never names the app');
  assert.equal(appOfRow({ key: 'codex', label: 'Chat' }).app, 'Codex', 'the key names the app when the label does not');
  assert.equal(appOfRow({ label: 'Hermes-box' }).app, 'Hermes');
  assert.equal(whereOf({ runs_on: { device: 'device:Avery-mac' } }), 'Avery-mac');
  assert.equal(whereOf({}), null);
});

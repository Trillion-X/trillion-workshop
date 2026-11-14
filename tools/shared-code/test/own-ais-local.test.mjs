// Ported from old trillion test/own-ais-local.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. One of its eighteen tests has a running owner: whether a computer row connects
// (src/own-ais.mjs deviceRowConnected here); it is the old test, with the shipped local tool's descriptor read from where it
// is shipped now, tools/models-on-this-computer/tool-rows.json, where the old one read records/workshop-listening-tool-records.json.
// That row's invoke.kind is "computer" (the old row's kind, "computer-tool", is gone), and deviceRowConnected asks for "computer".
// The other seventeen ran a waiting job through old src/own-ais-routing.mjs ownAisRouting (its bounded scans, durable cursors,
// the local tool loop, walls, retries and releases); no repository keeps that routing (searched ownAisRouting,
// own-ais-routing in trillion-workshop tools/, trillion-apps web/, trillion-rust src/), so they are left out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceRowConnected } from '../src/own-ais.mjs';
import settings from '../src/own-ais.json' with { type: 'json' };
import rows from '../../models-on-this-computer/tool-rows.json' with { type: 'json' };

const local = settings.legacy.providers.local;
const descriptor = rows.records.map(row => row.payload ?? row).find(row => row.id === local.tool_id);
const AGENT = 'ai:local';

// The person's computer as a row: a device-model row on the computer placement, live now, with the shipped local tool.
const rowFor = (clock, extra = {}) => ({ id: AGENT, agent_id: AGENT, label: 'My computer', kind: 'device-model', order: 0,
  can: [...settings.kinds['device-model'].can], tool_id: local.tool_id, model: local.model,
  runs_on: { device: null, place: settings.placement_computer }, live: { seen_at: new Date(clock.at).toISOString(), how: 'test' }, ...extra });

test('a computer row connects only when it is the account\'s own, live, and has its shipped local tool', () => {
  const now = new Date('2026-10-07T00:00:00Z');
  const agent = { agent_id: 'my-mac', takes_work: true, skills: [{ id: local.tool_id }],
    capacity_claim: { max_concurrent: 1, expires_at: '2026-10-07T01:00:00Z' } };
  const row = rowFor({ at: now.getTime() }, { agent_id: 'my-mac' });
  const data = { tools: [descriptor], placements: [{ id: settings.placement_computer, executor: 'agent', settings: { agent_id: agent.agent_id } }] };
  const current = { data, card: id => id === agent.agent_id ? agent : null, reach: () => ({ live: true }), now };
  assert.equal(deviceRowConnected(row, current), true);
  assert.equal(deviceRowConnected(row, { ...current, card: () => null }), false, 'another account\'s computer is never enough');
  assert.equal(deviceRowConnected(row, { ...current, reach: () => ({ live: false }) }), false);
  assert.equal(deviceRowConnected(row, { ...current, now: new Date('2026-10-08T00:00:00Z') }), false);
  assert.equal(deviceRowConnected(row, { ...current, card: () => ({ ...agent, skills: [] }) }), false);
  for (const changed of [{ billing: { who: 'person' } }, { needs: { network_egress: true } },
    { invoke: { kind: 'http' } }, { placements: [settings.placement_computer, 'placement:paid-cloud'] }]) {
    assert.equal(deviceRowConnected(row, { ...current, data: { ...data, tools: [{ ...descriptor, ...changed }] } }), false);
  }
});

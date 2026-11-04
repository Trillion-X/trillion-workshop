import test from 'node:test';
import assert from 'node:assert/strict';
import { commercialEventsFor, recordCommercialEvent } from '../src/commercial-events.mjs';
import { failureOf } from '../../shared-code/src/failure.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { RECORD_INDEXES } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { funnelStages } from '../../funnels-screen/read-data/stage-projection.ts';

function fakeEeaf() {
  const rows = new Map();
  const lookedUp = [];
  const scans = [];
  let ready = true;
  return {
    rows, lookedUp, scans,
    setIndexReady: value => { ready = value; },
    read: id => { lookedUp.push(id); return rows.get(id) ?? null; },
    ids: () => { throw new Error('Funnel selection must not enumerate account event IDs.'); },
    indexReady: (type, name) => { assert.deepEqual([type, name], ['commercial-event', 'by-funnel']); return ready; },
    scan: (type, name, options) => {
      assert.deepEqual([type, name], ['commercial-event', 'by-funnel']);
      scans.push(options);
      return [...rows].filter(([id, row]) => row.kind === type && row.funnel_id === options.equal[0]
        && (options.idFrom === undefined || id >= options.idFrom))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, options.limit)
        .map(([id, row]) => ({ id, values: [row.funnel_id] }));
    },
    write: batch => batch.forEach(({ id, value }) => rows.set(id, structuredClone(value))),
  };
}

test('commercial events are retry-safe EEAF records and only read into their named funnel', () => {
  const eeaf = fakeEeaf();
  const event = {
    event_id: 'contract-7-shared', event: 'contract.shared', subject_kind: 'sales-contract', subject_id: 'contract:7',
    funnel_id: 'sales', occurred_at: '2026-09-30T10:00:00.000Z',
  };
  assert.equal(recordCommercialEvent(eeaf, event).repeated, false);
  assert.equal(recordCommercialEvent(eeaf, event).repeated, true);
  assert.deepEqual(commercialEventsFor(eeaf, 'sales').map(row => row.event), ['contract.shared']);
  assert.deepEqual(commercialEventsFor(eeaf, 'other'), []);
  assert.throws(() => recordCommercialEvent(eeaf, { ...event, event: 'contract.paid' }), /different facts/);

  const graph = {
    id: 'sales', title: 'Sales', kind: 'funnel-graph', entry_node: 'shared',
    nodes: [
      { id: 'shared', offer: { name: 'Shared contract', amount_cents: 0 }, transitions: [{ on: 'accepted', to: 'accepted' }] },
      { id: 'accepted', offer: { name: 'Accepted contract', amount_cents: 0 }, transitions: [{ on: 'paid', to: 'paid' }] },
      { id: 'paid', offer: { name: 'Paid contract', amount_cents: 0 }, transitions: [] },
    ],
    measures: { event_stage_map: { 'contract.shared': 'shared', 'contract.accepted': 'accepted', 'contract.paid': 'paid' } },
  };
  const facts = [
    ...commercialEventsFor(eeaf, 'sales'),
    { event: 'contract.accepted', converted: true },
    { event: 'contract.paid', converted: true, amount_cents: 150000 },
  ];
  const funnel = funnelStages(graph, facts);
  assert.deepEqual(funnel.stages.map(stage => [stage.id, stage.measures.visits, stage.measures.conversions]), [
    ['shared', 1, 0], ['accepted', 1, 1], ['paid', 1, 1],
  ]);
  assert.equal(funnel.stages[2].measures.revenue_cents, 150000);
});

test('funnel selection pages only the indexed funnel and preserves every event in time/id order', () => {
  const eeaf = fakeEeaf();
  for (let n = 0; n < 300; n++) {
    eeaf.rows.set(`commercial-event:unrelated-${n}`, { kind: 'commercial-event', event_id: `unrelated-${n}`,
      funnel_id: 'other', occurred_at: '2026-10-01T00:00:00Z' });
    eeaf.rows.set(`commercial-event:mine-${n}`, { kind: 'commercial-event', event_id: `mine-${n}`,
      funnel_id: 'mine', occurred_at: n % 2 ? '2026-10-02T00:00:00Z' : '2026-10-01T00:00:00Z' });
  }
  const selected = commercialEventsFor(eeaf, 'mine');
  assert.equal(selected.length, 300);
  assert.deepEqual(selected.map(row => row.event_id), [...selected].sort((a, b) =>
    a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id)).map(row => row.event_id));
  assert.equal(eeaf.scans.length, 3);
  assert.ok(eeaf.scans.every(call => call.equal[0] === 'mine' && call.limit === 128));
  assert.equal(eeaf.lookedUp.length, 300);
  assert.ok(eeaf.lookedUp.every(id => id.startsWith('commercial-event:mine-')));
});

test('an incomplete funnel index refuses rather than returning a false empty result or scanning account history', () => {
  const eeaf = fakeEeaf();
  eeaf.setIndexReady(false);
  assert.throws(() => commercialEventsFor(eeaf, 'mine'), error =>
    error.domain_code === 'commercial_events_index_pending' && failureOf(error).tries_again_later);
  assert.equal(eeaf.scans.length, 0);
  assert.equal(eeaf.lookedUp.length, 0);
});

test('an existing account gets complete funnel events only after the real log index backfills', () => {
  const host = sqliteHost(':memory:');
  try {
    const earlierIndexes = RECORD_INDEXES.filter(row => !(row.type === 'commercial-event' && row.name === 'by-funnel'));
    let eeaf = recordLogStore(host.sql, { transaction: host.transaction, indexes: earlierIndexes });
    for (let n = 0; n < 6; n++) recordCommercialEvent(eeaf, {
      event_id: `mine-${n}`, event: 'opened', subject_kind: 'offer', subject_id: `offer:${n}`,
      funnel_id: 'mine', occurred_at: `2026-10-01T00:00:0${5 - n}Z`,
    });
    for (let n = 0; n < 64; n++) recordCommercialEvent(eeaf, { event_id: `elsewhere-${String(n).padStart(2, '0')}`, event: 'opened', subject_kind: 'offer', subject_id: `offer:other-${n}`,
      funnel_id: 'other', occurred_at: '2026-10-01T00:00:00Z' });
    eeaf.checkpoint();
    eeaf = recordLogStore(host.sql, { transaction: host.transaction, indexes: RECORD_INDEXES });
    assert.equal(eeaf.indexReady('commercial-event', 'by-funnel'), false);
    assert.throws(() => commercialEventsFor(eeaf, 'mine'), error => failureOf(error).tries_again_later);
    eeaf.maintain();
    assert.equal(eeaf.indexReady('commercial-event', 'by-funnel'), false, 'one bounded step cannot certify the unknown suffix');
    eeaf = recordLogStore(host.sql, { transaction: host.transaction, indexes: RECORD_INDEXES });
    assert.throws(() => commercialEventsFor(eeaf, 'mine'), error => failureOf(error).tries_again_later, 'owner reconstruction retains partial-index refusal');
    for (let n = 0; n < 10 && !eeaf.indexReady('commercial-event', 'by-funnel'); n++) eeaf.maintain();
    assert.equal(eeaf.indexReady('commercial-event', 'by-funnel'), true);
    eeaf.ids = () => { throw new Error('An indexed funnel must not enumerate all commercial events.'); };
    const opened = [];
    const inspected = { indexReady: (...args) => eeaf.indexReady(...args), scan: (...args) => eeaf.scan(...args),
      read: id => { opened.push(id); return eeaf.read(id); } };
    assert.deepEqual(commercialEventsFor(inspected, 'mine').map(row => row.event_id),
      ['mine-5', 'mine-4', 'mine-3', 'mine-2', 'mine-1', 'mine-0']);
    assert.equal(opened.length, 6);
    assert.ok(opened.every(id => id.startsWith('commercial-event:mine-')), 'real indexed read opens no unrelated body');
    assert.equal(commercialEventsFor(eeaf, 'other').length, 64);
    const changed = eeaf.read('commercial-event:mine-0');
    eeaf.write([{ id: 'commercial-event:mine-0', type: 'commercial-event', value: { ...changed, funnel_id: 'other' } },
      { id: 'commercial-event:mine-1', value: null }]);
    assert.deepEqual(commercialEventsFor(eeaf, 'mine').map(row => row.event_id), ['mine-5', 'mine-4', 'mine-3', 'mine-2']);
    assert.equal(commercialEventsFor(eeaf, 'other').length, 65);
  } finally { host.db.close(); }
});

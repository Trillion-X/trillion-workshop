import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../read-data/tell-the-person.json' with { type: 'json' };
import { connectionToolReceipt, makeTellThePerson } from '../read-data/tell-the-person.mjs';

const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const channel = (id, evidence = 'provider-accepted') => ({ id, label: id, sender: id, delivery_evidence: evidence, on_by_default: true });

function fixture(channels, senders, extra = {}) {
  const data = { ...rows, channels, kinds: [{ id: 'test', channels: channels.map(row => row.id) }], default_kind: 'test', shown_here: channels[0].id, ...extra.rows };
  let notices = [], choices = {};
  const receipts = new Map();
  const store = { choices: () => clone(choices), putChoices: value => { choices = clone(value); },
    notices: () => clone(notices), putNotices: value => { notices = clone(value); },
    delivery: key => clone(receipts.get(key) ?? null), putDelivery: (key, value) => receipts.set(key, clone(value)) };
  const make = () => makeTellThePerson({ rows: data, store, senders, ...extra.owner });
  return { tell: make(), make, store, receipts, notices: () => clone(notices) };
}
const request = key => ({ key, kind: 'test', title: 'Synthetic assignment', body: 'Synthetic task words', retain_delivery: true, retry_failed: true });

test('storage, queued display, provider acceptance and explicit read are different evidence', async () => {
  let ready = false;
  const f = fixture([channel('stored', 'stored'), channel('pull', 'queued'), channel('push')], {
    stored: { state: () => ({ ready: true }), send: () => ({ sent: true }) },
    pull: { state: () => ({ ready: true }), send: () => ({ sent: true }) },
    push: { state: () => ({ ready }), send: () => ({ sent: true }) },
  });
  const input = request('stages');
  const recorded = await f.tell.tell(input);
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.told, false);
  assert.equal(recorded.delivery_accepted, false);
  assert.equal(recorded.awareness, 'unknown');
  assert.deepEqual(recorded.channels.map(row => row.evidence), ['stored', 'queued', 'unavailable']);
  ready = true;
  const accepted = await f.tell.tell(input);
  assert.equal(accepted.delivery_accepted, true);
  assert.equal(accepted.awareness, 'unknown');
  f.tell.markRead({ ids: [`told:${f.notices()[0].seq}`] });
  const read = await f.tell.tell(input);
  assert.equal(read.awareness, 'read-receipt');
  assert.equal(f.receipts.get('stages').read, true);
  assert.equal(Object.hasOwn(read, 'done'), false, 'read does not complete the assignment');
});

test('an older channel failure cannot erase a sibling claim or cause a duplicate send', async () => {
  const a = deferred(), b = deferred(); let bStates = 0, bSends = 0;
  const f = fixture([channel('a'), channel('b')], {
    a: { state: () => ({ ready: true }), send: () => a.promise },
    b: { state: () => ({ ready: ++bStates > 1 }), send: () => { bSends += 1; return bSends === 1 ? b.promise : { sent: true }; } },
  });
  const first = f.tell.tell(request('concurrent')); await tick();
  const second = f.tell.tell(request('concurrent')); await tick();
  a.resolve({ sent: false, retryable: true, said: 'Definite rejection' }); await first;
  b.resolve({ sent: true, said: 'Accepted' }); await second;
  await f.tell.tell(request('concurrent'));
  assert.equal(bSends, 1);
  assert.equal(f.receipts.get('concurrent').results.b.sent, true);
});

test('an explicit read stops retrying initial delivery through a channel that becomes ready later', async () => {
  let ready = false, outsideSends = 0;
  const f = fixture([channel('stored', 'stored'), channel('outside')], {
    stored: { state: () => ({ ready: true }), send: () => ({ sent: true }) },
    outside: { state: () => ({ ready }), send: () => { outsideSends += 1; return { sent: true }; } },
  });
  const input = request('read-before-outside');
  await f.tell.tell(input);
  f.tell.markRead({ ids: [`told:${f.notices()[0].seq}`] });
  ready = true;
  const result = await f.make().tell(input);
  assert.equal(outsideSends, 0);
  assert.equal(result.awareness, 'read-receipt');
  assert.equal(result.delivery_accepted, false);
});

test('accepted and uncertain action receipts survive UI eviction and a new owner', async () => {
  for (const outcome of ['accepted', 'uncertain']) {
    let attempts = 0;
    const f = fixture([channel('send')], { send: { state: () => ({ ready: true }), send: (_row, notice) => {
      if (notice.key === outcome) { attempts += 1; if (outcome === 'uncertain') throw new Error('Connection lost after the request left'); }
      return { sent: true };
    } } });
    await f.tell.tell(request(outcome));
    for (let i = 0; i < rows.keep; i += 1) await f.tell.tell(request(`${outcome}:other:${i}`));
    assert.equal(f.notices().some(row => row.key === outcome), false);
    const result = await f.make().tell(request(outcome));
    assert.equal(attempts, 1);
    assert.equal(result.delivery_accepted, outcome === 'accepted');
    assert.equal(result.uncertain, outcome === 'uncertain');
    assert.equal(Object.hasOwn(f.receipts.get(outcome), 'body'), false);
  }
});

test('a durable request refuses missing receipt persistence before any send', async () => {
  let sent = 0;
  const f = fixture([channel('send')], { send: { state: () => ({ ready: true }), send: () => { sent += 1; return { sent: true }; } } });
  delete f.store.putDelivery;
  await assert.rejects(f.make().tell(request('unwired')), /not wired/);
  assert.equal(sent, 0);
});

test('revocation while readiness waits is checked before the sender is invoked', async () => {
  const ready = deferred(); let allowed = true, sent = 0;
  const f = fixture([channel('send')], { send: { state: () => ready.promise, send: () => { sent += 1; return { sent: true }; } } });
  const running = f.tell.tell(request('revoked'), { beforeSend: () => allowed ? {} : { blocked: true, reason: 'Access was revoked' } });
  await tick(); allowed = false; ready.resolve({ ready: true });
  const result = await running;
  assert.equal(sent, 0);
  assert.equal(result.blocked, true);
  assert.equal(result.delivery_accepted, false);
});

test('recipient opt-outs and show rules suppress channels without choosing a substitute', async () => {
  let sent = 0;
  const f = fixture([channel('stored', 'stored'), channel('push')], {
    stored: { state: () => ({ ready: true }), send: () => ({ sent: true }) },
    push: { state: () => ({ ready: true }), send: () => { sent += 1; return { sent: true }; } },
  }, { owner: { shows: () => ({ silenced: true, rules: [{ label: 'Quiet' }] }) } });
  await f.tell.tell(request('quiet'));
  await f.tell.choose({ channels: { push: { on: false } } });
  await f.tell.tell(request('off'));
  assert.equal(sent, 0);
  assert.equal(f.receipts.get('quiet').results.push.stage, 'unavailable');
  assert.equal(f.receipts.get('off').results.push, undefined);
});

test('connection-tool acceptance requires a completed positive configured send receipt', () => {
  const row = rows.channels.find(row => row.sender === 'connection-tool');
  for (const state of ['queued', 'running', 'failed', 'completed']) {
    assert.equal(connectionToolReceipt(row, { ok: true }, { state }).sent, false, state);
  }
  assert.equal(connectionToolReceipt(row, { ok: true }, { state: 'completed', output: { sent: false } }).sent, false);
  assert.equal(connectionToolReceipt(row, { ok: true }, { state: 'completed', output: { sent: true } }).sent, true);
  assert.equal(connectionToolReceipt(row, { ok: false }, { state: 'completed', output: { sent: true } }).sent, false);
  assert.equal(connectionToolReceipt({ ...row, settings: {} }, { ok: true }, { state: 'completed' }).sent, false);
  assert.equal(connectionToolReceipt({ ...row, settings: { accepted_when: {} } }, { ok: true }, { state: 'completed' }).sent, false);
  for (const configured of rows.channels.filter(row => row.sender === 'connection-tool')) assert.deepEqual(configured.settings.accepted_when, { path: ['output', 'sent'], equals: true });
});

test('ending a report records its outcome without claiming an unseen stored notice reached the person', async () => {
  const f = fixture([channel('stored', 'stored'), channel('pull', 'queued')], {
    stored: { state: () => ({ ready: true }), send: () => ({ sent: true }) },
    pull: { state: () => ({ ready: true }), send: () => ({ sent: true }) },
  });
  const result = await f.tell.report({ key: 'report-only', title: 'Work', state: 'done' });
  assert.equal(result.reported, true);
  assert.equal(result.delivery_accepted, false);
  assert.equal(result.awareness, 'unknown');
  assert.doesNotMatch(result.said, /Told the person/);
  assert.match(result.said, /Recorded that the work finished/);
});

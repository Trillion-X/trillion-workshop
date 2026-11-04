import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNativeBoardLive } from '../src/native-board-live.mjs';

test('native board carrier keeps the established board/changed/records frames and closes each read/write through installed quota', async () => {
  const calls = [], sent = [], records = [{ address: 'card:1', value: { title: 'A' } }];
  let cursor = 1, pending;
  const context = { actor: 'account-1', claims: { sign_in: 'sign-in-1' }, recorder: { reader: 'account-1' } };
  const owner = {
    generation: 'content-generation-8',
    async authorize(current, mode) { calls.push(['authorize', current.actor, mode]); return { id: 'member-stable', relay: 'relay-a', name: 'Ana', may_change: true }; },
    quota: {
      async open(input) { calls.push(['open', input.resource, input.generation]); return { id: 'live-lease-1', generation: input.generation }; },
      async check(input) { calls.push(['check', input.lifetime.id]); return { accepted: true }; },
      async command(input) { calls.push(['command', input.operation, input.request_key]); return input.run(); },
      async close(input) { calls.push(['close', input.lifetime.id, input.reason]); },
      async reconcile(input) { calls.push(['reconcile', input.lifetime.id]); },
      async resume(input) { calls.push(['resume', input.token]); return { id: 'live-lease-1', generation: input.generation }; },
    },
    async read(input) { calls.push(['read', input.limit]); return { cursor: String(cursor), records: structuredClone(records) }; },
    async commit(input) {
      calls.push(['commit', input.request_key]);
      for (const change of input.changes) {
        const row = records.find(item => item.address === change.address);
        if (row) row.value = change.value;
        else records.push({ address: change.address, value: change.value });
      }
      cursor++;
      return { replayed: false, records: input.changes.map(change => ({ address: change.address, value: change.value })) };
    },
    async subscribe(input) { calls.push(['subscribe', input.cursor ?? input.view]); return { async next() { return new Promise(resolve => { pending = resolve; }); }, async return() { pending?.({ done: true }); } }; },
    async publishRecords(input) { calls.push(['publish', input.sender_id]); },
    async publishPresence(input) { calls.push(['presence', input.view]); },
  };
  const live = makeNativeBoardLive({ resolve: async ({ space_id, context: current }) => {
    assert.equal(space_id, 'space-1'); assert.equal(current, context); return owner;
  } });
  const socket = { send: text => sent.push(JSON.parse(text)), close() {}, serializeAttachment(value) { this.attachment = value; } };
  const opened = await live.open({ space_id: 'space-1', as: 'records', context, socket });
  assert.deepEqual(sent[0], { type: 'board', records });
  assert.equal(socket.attachment.kind, 'native-board-live/v1');
  assert.equal(socket.attachment.member_id, 'member-stable');

  await live.message(opened.token, JSON.stringify({ request: 'change-stable-key', changes: [{ address: 'card:1', base: { title: 'A' }, value: { title: 'B' } }] }));
  assert.deepEqual(sent[1], { type: 'changed', request: 'change-stable-key', records: [{ address: 'card:1', value: { title: 'B' } }] });
  assert.ok(calls.some(row => row[0] === 'command' && row[1] === 'boardCommit' && row[2] === 'change-stable-key'));

  const update = live.next(opened.token);
  await new Promise(resolve => setImmediate(resolve));
  pending?.({ done: false, value: { cursor: '2' } });
  await update;
  assert.ok(sent.some(frame => frame.type === 'records'));
  assert.ok(calls.some(row => row[0] === 'command' && row[1] === 'boardRecords'));
  const hibernated = { attachment: { ...socket.attachment, cursor: '0' }, sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() {},
    deserializeAttachment() { return this.attachment; }, serializeAttachment(value) { this.attachment = value; } };
  const restartedLive = makeNativeBoardLive({ resolve: async () => owner });
  const resumed = await restartedLive.resume({ socket: hibernated, context });
  assert.equal(resumed.token, opened.token, 'hibernation reopens the original lifetime admission');
  assert.ok(hibernated.sent.some(frame => frame.type === 'board'), 'resume repairs changes missed while hibernated');
  assert.ok(calls.some(row => row[0] === 'resume' && row[1] === opened.token));
  await restartedLive.close(opened.token, 'test-close');
  assert.ok(calls.some(row => row[0] === 'close' && row[1] === 'live-lease-1'));
});

test('native board presence keeps the installed member identity and view partition', async () => {
  const output = [];
  let presence;
  const context = { actor: 'account-2', claims: { sign_in: 'sign-in-2' }, recorder: { reader: 'account-2' } };
  const owner = {
    generation: 'g1',
    async authorize() { return { id: 'member-native', relay: 'relay-b', name: 'Bo', may_change: false }; },
    quota: { async open({ generation }) { return { id: 'l2', generation }; }, async check() {}, async close() {}, async reconcile() {}, async command(input) { return input.run(); } },
    async read() { return { cursor: '0', records: [] }; }, async commit() { throw new Error('write forbidden'); },
    async subscribe(input) { return { async next() { return new Promise(() => {}); }, async return() {} }; },
    async publishRecords() {}, async publishPresence(input) { presence = input; },
  };
  const live = makeNativeBoardLive({ resolve: async () => owner });
  const opened = await live.open({ space_id: 'space-2', as: 'presence', view: 'calendar', context,
    socket: { send: text => output.push(JSON.parse(text)), close() {} } });
  await live.message(opened.token, JSON.stringify({ cursor: { x: 4, y: 9 }, selection: ['x'], doing: 'editing' }));
  assert.equal(presence.message.id, 'member-native');
  assert.equal(presence.message.name, 'Bo');
  assert.equal(presence.view, 'view:calendar');
  assert.equal(presence.message.cursor.x, 4);
  await live.close(opened.token);
});

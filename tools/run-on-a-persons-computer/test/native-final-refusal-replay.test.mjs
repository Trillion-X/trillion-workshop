import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macTools, MacToolsHttpError, callerOf } from '../mac-tools.mjs';
import { nativeResultOutbox } from '../native-result-outbox.mjs';

const settings = { agent: { agent_id: 'computer-tools' }, tools: {}, capacity: { max_concurrent: 1 }, take_gap_ms: 0, renew_minutes: 30, live_retry_ms: [] };
const saved = { handoff_id: 'h_recovery', generation: 1, finish: { handoff_id: 'h_recovery', agent_id: 'computer-tools', generation: 1, result: { outside_effect: 'already completed' } }, effect_updates: [] };
const connect = () => ({ addEventListener() {} });

async function withOutbox(work) {
  const folder = await mkdtemp(join(tmpdir(), 'native-refusal-'));
  const open = () => nativeResultOutbox({ file: join(folder, 'result'), accountId: 'synthetic-account', origin: 'https://example.test' });
  try { await work(open); } finally { await rm(folder, { recursive: true, force: true }); }
}

for (const status of [400, 401, 403, 404, 409, 422]) test(`final ${status} retains a result across restart, stops revision replay, and resumes a new lease`, async () => {
  await withOutbox(async open => {
    let outbox = open(); outbox.put(saved);
    let finishes = 0, offered = false;
    const submitted = [];
    const call = async (path, body) => {
      if (path === '/handoffs/take') {
        if (!offered) return { handoff: null };
        offered = false;
        return { handoff: { handoff_id: saved.handoff_id, input: { tool_id: 'synthetic-tool' } }, generation: 2 };
      }
      if (path === '/handoffs/finish') {
        finishes++; submitted.push(body);
        if (body.generation === 1) throw new MacToolsHttpError(path, status, 'Authoritative refusal.');
        return {};
      }
      throw Error('Unexpected call ' + path);
    };
    const make = () => macTools({ settings, call, connect, resultOutbox: outbox,
      execute: async () => { throw Error('A preserved outside effect must not execute again.'); } });
    let host = make();
    await host.takeAll();
    assert.equal(finishes, 1);
    assert.deepEqual(outbox.get(saved.handoff_id).finish.result, saved.finish.result);
    assert.equal(outbox.get(saved.handoff_id).delivery_refusal.status, status);
    outbox = open(); host = make();
    for (let revision = 0; revision < 56; revision++) await host.takeAll();
    assert.equal(finishes, 1, 'restart and unrelated revisions never retry a final submission');
    offered = true;
    await host.takeAll();
    assert.equal(finishes, 2);
    assert.equal(submitted[1].generation, 2);
    assert.deepEqual(submitted[1].result, saved.finish.result);
    assert.deepEqual(open().list(), [], 'only accepted delivery removes the preserved answer');
  });
});

for (const status of [408, 429, 500, 503]) test(`transient ${status} keeps durable replay eligible`, async () => {
  await withOutbox(async open => {
    const outbox = open(); outbox.put(saved); let attempts = 0;
    const host = macTools({ settings, connect, resultOutbox: outbox, call: async (path) => {
      if (path === '/handoffs/take') return { handoff: null };
      if (path === '/handoffs/finish') { if (++attempts === 1) throw new MacToolsHttpError(path, status, 'Passing trouble'); return {}; }
      throw Error('Unexpected call');
    } });
    await host.takeAll();
    assert.equal(outbox.get(saved.handoff_id).delivery_refusal, undefined);
    await host.takeAll();
    assert.equal(attempts, 2);
    assert.deepEqual(open().list(), []);
  });
});

test('a refused effect retains both the completed result and unapplied effect until a new lease', async () => {
  await withOutbox(async open => {
    const outbox = open(); const effect = { handoff_id: saved.handoff_id, agent_id: 'computer-tools', generation: 1, state: 'done', key: 'synthetic-effect' };
    outbox.put({ ...saved, effect_updates: [effect] }); let effects = 0, finishes = 0, offered = false;
    const host = macTools({ settings, connect, resultOutbox: outbox, call: async (path, body) => {
      if (path === '/handoffs/take') { if (!offered) return { handoff: null }; offered = false; return { handoff: { handoff_id: saved.handoff_id }, generation: 2 }; }
      if (path === '/handoffs/effect') { effects++; if (body.generation === 1) throw new MacToolsHttpError(path, 400, 'Missing handoff'); return {}; }
      if (path === '/handoffs/finish') { finishes++; return {}; }
      throw Error('Unexpected call');
    }, execute: async () => { throw Error('Do not execute again'); } });
    await host.takeAll(); await host.takeAll();
    assert.equal(effects, 1); assert.equal(finishes, 0);
    assert.deepEqual(open().get(saved.handoff_id).effect_updates, [effect]);
    offered = true; await host.takeAll();
    assert.equal(effects, 2); assert.equal(finishes, 1); assert.deepEqual(open().list(), []);
  });
});

test('real HTTP caller keeps the authoritative status even when a final body says busy', async () => {
  const call = callerOf('https://example.test', 'synthetic-key', async () => Response.json({ error: 'busy is not a passing refusal here' }, { status: 400 }));
  await assert.rejects(call('/handoffs/finish', saved.finish), error => error.status === 400 && error.path === '/handoffs/finish');
});

// Append to test/native-final-refusal-replay.test.mjs; reuses its real on-disk outbox and current settings.
for (const status of [400, 413]) test(`same held lease cannot reopen final HTTP ${status} after restart or revisions`, async () => {
  await withOutbox(async open => {
    let outbox = open(); outbox.put(saved);
    let finishes = 0, renewals = 0, generation = 1, direct = false, offered = false, delivered = false;
    const submitted = [];
    const call = callerOf('https://example.test', 'fixture-key', async (url, init) => {
      const path = new URL(url).pathname.replace('/mcp/api', '');
      const body = JSON.parse(init.body);
      if (path === '/handoffs/take') {
        if (delivered) return Response.json({ handoff: null, held: [] });
        if (renewals > 3) throw Error('Unchanged refused lease was replayed repeatedly');
        if (body.handoff_id) {
          renewals++;
          return Response.json({ handoff: { handoff_id: saved.handoff_id, input: { tool_id: 'synthetic-tool' } }, generation, renewed: true });
        }
        if (direct || offered) {
          offered = false;
          return Response.json({ handoff: { handoff_id: saved.handoff_id, input: { tool_id: 'synthetic-tool' } }, generation, renewed: generation === 1 });
        }
        return Response.json({ handoff: null, held: [{ handoff_id: saved.handoff_id, generation: 1 }] });
      }
      if (path === '/handoffs/finish') {
        finishes++; submitted.push(body);
        if (body.generation === 1) return Response.json({ error: 'Request too large' }, { status });
        delivered = true; return Response.json({});
      }
      throw Error('Unexpected call ' + path);
    });
    const make = () => macTools({ settings, call, connect, resultOutbox: outbox,
      execute: async () => { throw Error('A completed external effect must never execute twice.'); } });
    let host = make();
    await host.takeAll();
    assert.equal(finishes, 1);
    assert.equal(renewals, 0, 'refused same held lease is not renewed');
    assert.equal(outbox.get(saved.handoff_id).delivery_refusal.status, status);
    assert.deepEqual(outbox.get(saved.handoff_id).finish.result, saved.finish.result);
    outbox = open(); host = make();
    for (let revision = 0; revision < 56; revision++) await host.takeAll();
    assert.equal(finishes, 1);
    assert.equal(renewals, 0);
    direct = true;
    await host.takeAll();
    assert.equal(finishes, 1, 'a direct same-generation renewal also retains the refusal');
    direct = false; generation = 2; offered = true;
    await host.takeAll();
    assert.equal(finishes, 2, 'only a genuine new lease reopens delivery');
    assert.equal(submitted[1].generation, 2);
    assert.deepEqual(submitted[1].result, saved.finish.result);
    assert.deepEqual(open().list(), []);
  });
});

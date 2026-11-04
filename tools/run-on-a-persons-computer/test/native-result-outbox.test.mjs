import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeResultOutbox } from '../native-result-outbox.mjs';

test('native result outbox survives reload and removes only accepted handoffs for its authenticated account', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'trillion-native-results-'));
  const file = path.join(folder, 'results');
  const accountId = 'account-alpha';
  const origin = 'https://example.test';
  try {
    const first = nativeResultOutbox({ file, accountId, origin });
    const row = { handoff_id: 'h_1', generation: 4, finish: { handoff_id: 'h_1', agent_id: 'computer', generation: 4, result: { done: true } } };
    first.put(row);
    const saved = { ...row, account_id: accountId, origin };
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, (await readdir(folder)).find(name => name.endsWith('.json'))), 'utf8')), [saved]);
    const restarted = nativeResultOutbox({ file, accountId, origin });
    assert.deepEqual(restarted.get('h_1'), saved);
    assert.deepEqual(nativeResultOutbox({ file, accountId, origin: 'https://other.example.test' }).list(), [], 'same account id on a different service cannot replay results');
    assert.equal(nativeResultOutbox({ file, accountId, origin: `${origin}/mcp` }).get('h_1').handoff_id, 'h_1', 'paths do not change the service identity');
    restarted.delete('h_1');
    assert.deepEqual(nativeResultOutbox({ file, accountId, origin }).list(), []);
    assert.deepEqual(nativeResultOutbox({ file, accountId: 'account-beta', origin }).list(), [], 'another sign-in has a separate outbox');
  } finally { await rm(folder, { recursive: true, force: true }); }
});


async function outputFixture(t, count = 2) {
  const folder = await mkdtemp(path.join(tmpdir(), 'native-app-outputs-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const options = { file: path.join(folder, 'results'), accountId: 'account-alpha', origin: 'https://example.test' };
  let outbox = nativeResultOutbox(options);
  const handoffId = 'h_output';
  outbox.put({ handoff_id: handoffId, generation: 4, execution: { state: 'started', steps: [{ step: 0, stage: 'app-step-returned', ok: true }] },
    finish: { handoff_id: handoffId, agent_id: 'computer', generation: 4 } });
  const workspace = outbox.createOutputWorkspace(handoffId, 4);
  const outputs = Array.from({ length: count }, (_, index) => ({ key: 'file' + index, name: 'file' + index + '.bin', media_type: 'application/octet-stream',
    path: path.join(workspace, 'outputs', 'file' + index, 'file' + index + '.bin') }));
  for (const [index, output] of outputs.entries()) { mkdirSync(path.dirname(output.path), { recursive: true }); writeFileSync(output.path, 'completed artifact ' + index); }
  outbox.stageOutputs(handoffId, 4, { outputs, result: { ok: true, answer: { completed: true } } });
  return { folder, options, outbox, handoffId, workspace, outputs, reopen: () => nativeResultOutbox(options) };
}
const acknowledge = async ({ source, output }) => { assert.match(output.identity, /^1f:[a-f0-9]{64}$/); return { identity: output.identity, bytes: source.size }; };

test('failed output upload survives helper restart; retry preserves the produced bytes without app execution', async t => {
  const f = await outputFixture(t, 1);
  await assert.rejects(f.outbox.deliverOutputs(f.handoffId, async ({ source }) => {
    assert.equal(new TextDecoder().decode(await source.readAt(0, source.size)), 'completed artifact 0');
    throw Object.assign(new Error('upload unavailable'), { status: 503 });
  }), /upload unavailable/);
  assert.equal(existsSync(f.outputs[0].path), true);
  const before = f.outbox.get(f.handoffId);
  assert.equal(before.execution.state, 'outputs');
  assert.match(before.output_delivery.files[0].identity, /^1f:/);
  const restarted = f.reopen();
  const delivered = await restarted.deliverOutputs(f.handoffId, acknowledge);
  assert.equal(delivered.execution.state, 'returned');
  assert.equal(delivered.finish.result.files[0].bytes, Buffer.byteLength('completed artifact 0'));
  assert.equal(existsSync(f.workspace), true, 'retained until final result acceptance');
  assert.throws(() => restarted.delete(f.handoffId), /completed answer is accepted/);
  restarted.put({ ...delivered, delivery_ack: { generation: delivered.generation } });
  restarted.delete(f.handoffId);
  assert.equal(existsSync(f.workspace), false);
  assert.deepEqual(f.reopen().list(), []);
});

test('partially acknowledged outputs resume only the unsaved suffix after helper restart', async t => {
  const f = await outputFixture(t);
  const called = [];
  await assert.rejects(f.outbox.deliverOutputs(f.handoffId, async request => {
    called.push(request.output.key);
    if (request.output.key === 'file1') throw Object.assign(new Error('second upload lost'), { status: 503 });
    return acknowledge(request);
  }), /second upload lost/);
  const restarted = f.reopen();
  assert.deepEqual(restarted.get(f.handoffId).execution.files, [{ identity: restarted.get(f.handoffId).output_delivery.files[0].identity, bytes: 20 }]);
  const delivered = await restarted.deliverOutputs(f.handoffId, async request => { called.push(request.output.key); return acknowledge(request); });
  assert.deepEqual(called, ['file0', 'file1', 'file1']);
  assert.equal(delivered.finish.result.files.length, 2);
  assert.equal(delivered.output_delivery.state, 'saved');
  assert.equal(readFileSync(f.outputs[0].path, 'utf8'), 'completed artifact 0');
});

test('lost upload acknowledgement retains the precomputed identity for existing sender deduplication', async t => {
  const f = await outputFixture(t, 1);
  const held = new Map();
  let transmitted = 0;
  await assert.rejects(f.outbox.deliverOutputs(f.handoffId, async request => {
    held.set(request.output.identity, Buffer.from(await request.source.readAt(0, request.source.size)));
    transmitted += request.source.size;
    throw Object.assign(new Error('reply lost'), { status: 503 });
  }), /reply lost/);
  const savedIdentity = f.reopen().get(f.handoffId).output_delivery.files[0].identity;
  await f.reopen().deliverOutputs(f.handoffId, async request => {
    assert.equal(request.output.identity, savedIdentity);
    assert.equal(held.has(request.output.identity), true, 'Namespace sender can answer already-there by exact identity');
    return { identity: request.output.identity, bytes: held.get(request.output.identity).length };
  });
  assert.equal(transmitted, 20);
});

test('output acknowledgement must confirm both exact identity and length before cleanup', async t => {
  for (const change of ['identity', 'bytes']) {
    const f = await outputFixture(t, 1);
    await assert.rejects(f.outbox.deliverOutputs(f.handoffId, async request => ({ identity: change === 'identity' ? '1f:' + 'f'.repeat(64) : request.output.identity,
      bytes: request.source.size + (change === 'bytes' ? 1 : 0) })), /acknowledge/);
    assert.equal(f.outbox.get(f.handoffId).output_delivery.files[0].saved, undefined);
    assert.throws(() => f.outbox.delete(f.handoffId), /remain retained/);
    assert.equal(existsSync(f.outputs[0].path), true);
  }
});

test('output continuation refuses another account, origin, job workspace or substituted path', async t => {
  const f = await outputFixture(t, 1);
  const saved = f.outbox.get(f.handoffId);
  for (const options of [{ ...f.options, accountId: 'account-beta' }, { ...f.options, origin: 'https://other.example.test' }]) {
    const other = nativeResultOutbox(options);
    assert.deepEqual(other.list(), []);
    assert.throws(() => other.put(saved), /authenticated private workspace/);
  }
  f.outbox.put({ ...saved, handoff_id: 'h_different' });
  await assert.rejects(f.outbox.deliverOutputs('h_different', async () => assert.fail('no cross-job upload')), /authenticated private workspace/);
  const tampered = { ...saved, output_delivery: { ...saved.output_delivery, files: [{ ...saved.output_delivery.files[0], name: '../outside.bin' }] } };
  f.outbox.put(tampered);
  await assert.rejects(f.outbox.deliverOutputs(f.handoffId, async () => assert.fail('no path substitution upload')), /authenticated private workspace/);
});

test('retained output symlink and same-size inode substitutions fail before any bytes are sent', async t => {
  for (const kind of ['file-symlink', 'directory-symlink', 'inode']) {
    const f = await outputFixture(t, 1);
    const target = f.outputs[0].path;
    if (kind === 'directory-symlink') {
      const directory = path.dirname(target);
      renameSync(directory, directory + '-moved'); symlinkSync(directory + '-moved', directory);
    } else {
      renameSync(target, target + '-original');
      if (kind === 'file-symlink') symlinkSync(target + '-original', target);
      else writeFileSync(target, 'completed artifact 0');
    }
    await assert.rejects(f.reopen().deliverOutputs(f.handoffId, async () => assert.fail('substituted file never uploaded')), /authenticated private workspace/);
    assert.equal(readFileSync(kind === 'directory-symlink' ? path.dirname(target) + '-moved/' + path.basename(target) : target + '-original', 'utf8'), 'completed artifact 0');
  }
});

test('an output changed during upload remains retained and unacknowledged', async t => {
  const f = await outputFixture(t, 1);
  await assert.rejects(f.outbox.deliverOutputs(f.handoffId, async request => {
    writeFileSync(f.outputs[0].path, 'changed artifact   0');
    return acknowledge(request);
  }), /authenticated private workspace/);
  assert.equal(f.outbox.get(f.handoffId).output_delivery.files[0].saved, undefined);
  assert.equal(existsSync(f.workspace), true);
});

test('retention cannot convert uncertain app evidence into an output continuation', async t => {
  const f = await outputFixture(t, 1);
  const row = f.outbox.get(f.handoffId);
  f.outbox.put({ ...row, execution: { ...row.execution, uncertain: true } });
  await assert.rejects(f.outbox.deliverOutputs(f.handoffId, async () => assert.fail('uncertain edits never deliver a claimed output')), /authenticated private workspace/);
  assert.equal(existsSync(f.workspace), true);
});

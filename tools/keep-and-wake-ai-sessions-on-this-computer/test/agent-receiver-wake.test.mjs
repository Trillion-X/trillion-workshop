import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { deliveryHolds, signDelivery } from '../src/agent-delivery.mjs';

const secret = 'bc'.repeat(32);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

test('signed wake queues the exact chat once without receiver claim or finish', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-agent-wake-'));
  const source = 'codex:01a0cee9-02df-76e2-a6ea-6f202cbd0668';
  let claim = null;
  let finished = false;
  let takeCalls = 0;
  let finishCalls = 0;
  let signedReturn = false;
  const api = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw || '{}');
    const result = request.url === '/mcp/api/agents/publish' ? { agent: { delivery: input.delivery }, delivery_secret: secret }
      : request.url === '/mcp/api/agents/presence' ? { sending_again: 0 }
        : request.url === '/mcp/api/agents/capacity' ? { agent: {} }
          : request.url === '/mcp/api/handoffs/read' ? { handoff: { handoff_id: input.handoff_id, state: finished ? 'finished' : 'open', to_agent: input.handoff_id === 'h_general' ? null : 'proof-codex', input: input.handoff_id === 'h_general' ? null : { arrived: { source_id: input.handoff_id === 'h_wrong' ? 'codex:other' : source } }, taken_by: claim?.taken_by ?? null, taken_at: claim?.taken_at ?? null } }
            : request.url === '/mcp/api/handoffs/take' ? (++takeCalls, {})
              : request.url === '/mcp/api/handoffs/finish' ? (++finishCalls, {})
                : request.url === '/mcp/api/handoffs/confirm-source-return' ?
                  (signedReturn = deliveryHolds(secret, request.headers['trillion-source-signature'], raw)
                    && input.handoff_id === 'h_proof' && input.source_id === source && input.message_id === 'message:proof',
                  { handoff: { source_return: { verified: signedReturn, message_id: input.message_id } } }) : {};
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  const apiPort = await listen(api);
  const reserve = createServer();
  const receiverPort = await listen(reserve);
  await close(reserve);
  const verifier = join(home, 'verify.mjs');
  writeFileSync(verifier, 'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({message_id:"message:proof",transcript_message_id:"msg_final"})));');
  const child = spawn(process.execPath, ['harness/agent-receiver.mjs', '--agent-id', 'proof-codex', '--name', 'Proof Codex', '--description', 'Wakes a chat', '--port', String(receiverPort), '--public-url', 'https://example.invalid/receiver', '--origin', `http://127.0.0.1:${apiPort}`, '--source-id', source, '--wake', 'cat', '--verify-source-return', `node ${verifier}`, '--presence-minutes', '0.001'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('test-key\n');
  const lines = [];
  createInterface({ input: child.stdout }).on('line', raw => { try { lines.push(JSON.parse(raw)); } catch {} });
  const until = async match => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const found = lines.find(match);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`No matching receiver log: ${JSON.stringify(lines)}`);
  };
  const send = async event => {
    const body = JSON.stringify(event);
    return fetch(`http://127.0.0.1:${receiverPort}`, { method: 'POST', headers: { 'trillion-event-id': event.event_id, 'trillion-signature': signDelivery(secret, body) }, body });
  };
  const event = { event_id: 'ev_codex_wake', type: 'handoff.created', subject_id: 'h_proof', to_agent: 'proof-codex', refs: { handoff_id: 'h_proof' } };
  try {
    await until(line => line.did === 'listening');
    const general = { ...event, event_id: 'ev_general', subject_id: 'h_general', refs: { handoff_id: 'h_general' } };
    assert.equal((await send(general)).status, 202);
    await until(line => line.did === 'handled' && line.event_id === general.event_id);
    assert.equal(lines.some(line => line.did === 'woke' && line.handoff_id === 'h_general'), false);
    assert.equal((await send({ ...event, event_id: 'ev_wrong', subject_id: 'h_wrong', refs: { handoff_id: 'h_wrong' } })).status, 202);
    await until(line => line.did === 'not for this receiver' && line.event_id === 'ev_wrong');
    assert.equal((await send(event)).status, 202);
    await until(line => line.did === 'woke' && line.handoff_id === 'h_proof');
    await until(line => line.did === 'handled' && line.event_id === event.event_id);
    const path = join(home, '.trillion', 'agent-receiver', 'proof-codex', `${event.event_id}.json`);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.state, 'done');
    assert.equal(takeCalls, 0);
    assert.equal(finishCalls, 0);
    const wakes = lines.filter(line => line.did === 'woke' && line.handoff_id === 'h_proof').length;
    assert.equal((await send(event)).status, 202);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(lines.filter(line => line.did === 'woke' && line.handoff_id === 'h_proof').length, wakes);
    claim = { taken_by: 'proof-codex', taken_at: new Date(Date.now() + 1000).toISOString() };
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'done');
    assert.equal(takeCalls, 0);
    assert.equal(finishCalls, 0);
    const old = { ...event, event_id: 'ev_old_claim', subject_id: 'h_old', refs: { handoff_id: 'h_old' } };
    claim = { taken_by: 'proof-codex', taken_at: new Date(Date.now() - 60_000).toISOString() };
    assert.equal((await send(old)).status, 202);
    await until(line => line.did === 'woke' && line.handoff_id === 'h_old');
    await until(line => line.did === 'handled' && line.event_id === old.event_id);
    assert.equal(JSON.parse(readFileSync(join(home, '.trillion', 'agent-receiver', 'proof-codex', `${old.event_id}.json`), 'utf8')).state, 'done', 'queue acceptance is independent of an earlier claim');
    finished = true;
    const check = { event_id: 'ev_source_result', type: 'source.return.check', subject_id: 'h_proof', to_agent: 'proof-codex', refs: { handoff_id: 'h_proof', transcript_message_id: 'msg_final' } };
    assert.equal((await send(check)).status, 202);
    await until(line => line.did === 'source result verified' && line.handoff_id === 'h_proof');
    assert.equal(signedReturn, true);
  } finally {
    child.kill();
    await close(api);
    rmSync(home, { recursive: true, force: true });
  }
});

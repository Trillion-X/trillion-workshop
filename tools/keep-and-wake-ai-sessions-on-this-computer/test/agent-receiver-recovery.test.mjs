import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { signDelivery } from '../src/agent-delivery.mjs';

const secret = 'ab'.repeat(32);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

test('a failed agent command stays unfinished and the signed event recovers after restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-agent-receiver-'));
  let finishCount = 0;
  let takeCount = 0;
  const requests = [];
  const api = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw || '{}');
    requests.push({ path: request.url, input });
    const result = request.url === '/mcp/api/agents/publish' ? { agent: { delivery: input.delivery }, delivery_secret: secret }
      : request.url === '/mcp/api/agents/presence' ? { sending_again: 0 }
        : request.url === '/mcp/api/agents/capacity' ? { agent: {} }
          : request.url === '/mcp/api/handoffs/take' ? (++takeCount, { handoff: { handoff_id: 'h_recovery', job: 'Say done', to_agent: 'proof-receiver' } })
            : request.url === '/mcp/api/handoffs/finish' ? (++finishCount, { handoff: { state: 'finished' } })
              : request.url === '/mcp/api/handoffs/read' ? { handoff: { state: finishCount ? 'finished' : 'open', to_agent: 'proof-receiver', input: { arrived: { source_id: input.handoff_id === 'h_other_chat' ? 'codex:other-chat' : 'codex:proof-chat' } } } }
                : {};
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  const apiPort = await listen(api);
  const reserve = createServer();
  const receiverPort = await listen(reserve);
  await close(reserve);
  const event = { event_id: 'ev_recovery', type: 'handoff.created', subject_id: 'h_recovery', to_agent: 'proof-receiver', refs: { handoff_id: 'h_recovery' } };
  const body = JSON.stringify(event);
  const start = work => {
    const child = spawn(process.execPath, ['harness/agent-receiver.mjs', '--agent-id', 'proof-receiver', '--name', 'Proof receiver', '--description', 'Runs a bounded job', '--port', String(receiverPort), '--public-url', 'https://example.invalid/receiver', '--origin', `http://127.0.0.1:${apiPort}`, '--source-id', 'codex:proof-chat', '--work', work], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end('test-key\n');
    const lines = [];
    const waiting = [];
    createInterface({ input: child.stdout }).on('line', raw => {
      try {
        const line = JSON.parse(raw);
        lines.push(line);
        for (const wait of [...waiting]) if (wait.match(line)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(line); }
      } catch {}
    });
    const until = (match, ms = 5000) => {
      const found = lines.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const wait = { match, resolve };
        waiting.push(wait);
        setTimeout(() => reject(new Error(`receiver did not report expected event: ${JSON.stringify(lines)}`)), ms).unref();
      });
    };
    return { child, until };
  };
  let first;
  let second;
  try {
    first = start('false');
    await first.until(line => line.did === 'listening');
    const wrong = { ...event, event_id: 'ev_wrong', to_agent: 'another-agent' };
    const wrongBody = JSON.stringify(wrong);
    const refused = await fetch(`http://127.0.0.1:${receiverPort}`, { method: 'POST', headers: { 'trillion-event-id': wrong.event_id, 'trillion-signature': signDelivery(secret, wrongBody) }, body: wrongBody });
    assert.equal(refused.status, 503);
    assert.equal(takeCount, 0);
    const other = { ...event, event_id: 'ev_other_chat', subject_id: 'h_other_chat', refs: { handoff_id: 'h_other_chat' } };
    const otherBody = JSON.stringify(other);
    const acceptedOther = await fetch(`http://127.0.0.1:${receiverPort}`, { method: 'POST', headers: { 'trillion-event-id': other.event_id, 'trillion-signature': signDelivery(secret, otherBody) }, body: otherBody });
    assert.equal(acceptedOther.status, 202);
    // Work for another chat is settled for good, never tried again (df9d5373).
    await first.until(line => line.did === 'not for this receiver' && line.event_id === other.event_id);
    assert.equal(takeCount, 0);
    const response = await fetch(`http://127.0.0.1:${receiverPort}`, { method: 'POST', headers: { 'trillion-event-id': event.event_id, 'trillion-signature': signDelivery(secret, body) }, body });
    assert.equal(response.status, 202);
    await first.until(line => line.did === 'failed' && line.event_id === event.event_id);
    assert.equal(finishCount, 0);
    assert.equal(requests.find(item => item.path === '/mcp/api/handoffs/take')?.input.only_mine, true);
    assert.equal(requests.find(item => item.path === '/mcp/api/agents/publish')?.input.source_id, 'codex:proof-chat');
    first.child.kill();
    await new Promise(resolve => first.child.once('exit', resolve));
    second = start('echo done');
    await second.until(line => line.did === 'finished' && line.handoff_id === 'h_recovery');
    assert.equal(finishCount, 1);
    await second.until(line => line.did === 'handled' && line.event_id === event.event_id);
    const saved = JSON.parse(readFileSync(join(home, '.trillion', 'agent-receiver', 'proof-receiver', 'ev_recovery.json'), 'utf8'));
    assert.equal(saved.event.subject_id, 'h_recovery');
    assert.equal(saved.state, 'done');
    assert.equal(finishCount, 1);
  } finally {
    first?.child.kill();
    second?.child.kill();
    await close(api);
    rmSync(home, { recursive: true, force: true });
  }
});

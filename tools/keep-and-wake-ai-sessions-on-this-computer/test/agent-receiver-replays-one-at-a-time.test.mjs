// A receiver holding many unfinished events replays them one at a time, and settles work that belongs to another chat
// for good. On 2026-10-03 one receiver kept 341 events for other chats pending and replayed them all at once every five
// minutes, about a hundred reads in the same second, and the person's store answered "overloaded" to every caller.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const secret = 'cd'.repeat(32);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

test('unfinished events replay one at a time and work for another chat is never read again', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-agent-receiver-replay-'));
  const inbox = join(home, '.trillion', 'agent-receiver', 'replay-receiver');
  mkdirSync(inbox, { recursive: true });
  const count = 40;
  for (let n = 0; n < count; n += 1) {
    const event = { event_id: `ev_${n}`, type: 'handoff.created', subject_id: `h_${n}`, to_agent: 'replay-receiver', refs: { handoff_id: `h_${n}` } };
    writeFileSync(join(inbox, `ev_${n}.json`), JSON.stringify({ event, state: 'pending' }));
  }
  let reading = 0;
  let mostAtOnce = 0;
  const reads = [];
  const api = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw || '{}');
    if (request.url === '/mcp/api/handoffs/read') {
      reads.push(input.handoff_id);
      reading += 1;
      mostAtOnce = Math.max(mostAtOnce, reading);
      await new Promise(resolve => setTimeout(resolve, 5));
      reading -= 1;
    }
    const result = request.url === '/mcp/api/agents/publish' ? { agent: { delivery: input.delivery }, delivery_secret: secret }
      : request.url === '/mcp/api/agents/presence' ? { sending_again: 0 }
        : request.url === '/mcp/api/handoffs/read' ? { handoff: { handoff_id: input.handoff_id, state: 'open', to_agent: 'another-chat-agent', input: { arrived: { source_id: 'codex:another-chat' } } } }
          : {};
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  const apiPort = await listen(api);
  const reserve = createServer();
  const receiverPort = await listen(reserve);
  await close(reserve);
  const child = spawn(process.execPath, ['harness/agent-receiver.mjs', '--agent-id', 'replay-receiver', '--name', 'Replay receiver', '--description', 'Wakes one chat', '--port', String(receiverPort), '--public-url', 'https://example.invalid/receiver', '--origin', `http://127.0.0.1:${apiPort}`, '--source-id', 'codex:this-chat', '--wake', 'true', '--presence-minutes', '0.005'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('test-key\n');
  const lines = [];
  createInterface({ input: child.stdout }).on('line', raw => { try { lines.push(JSON.parse(raw)); } catch {} });
  try {
    const until = async (match, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (match()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error(`the receiver did not get there: ${JSON.stringify(lines.slice(-5))}`);
    };
    await until(() => lines.filter(line => line.did === 'not for this receiver').length === count);
    // Several presence reports pass (one every 0.3 s); none reads a settled event again.
    await until(() => lines.filter(line => line.did === 'present').length >= 4);
    assert.equal(mostAtOnce, 1, 'replayed events are read one at a time');
    assert.equal(reads.length, count, 'each event for another chat is read once, never again');
    for (let n = 0; n < count; n += 1) assert.equal(JSON.parse(readFileSync(join(inbox, `ev_${n}.json`), 'utf8')).state, 'refused');
  } finally {
    child.kill();
    await close(api);
    rmSync(home, { recursive: true, force: true });
  }
});

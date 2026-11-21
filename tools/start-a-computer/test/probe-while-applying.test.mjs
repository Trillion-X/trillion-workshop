// tools/start-a-computer/test/probe-while-applying.test.mjs
//
// The apply's probe keeps every request with its target and time, and never counts its own lateness as the computer's: a
// request sent while the prober lagged is counted apart, and the percentiles are of the requests sent on time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { askOnce, parseArgs, summarize } from '../do-work/probe-while-applying.mjs';

const at = '2026-11-21T18:00:00.000Z';
const settings = { slow_ms: 1000, lag_ms: 250 };

test('a slow request sent on time is the served computer\'s, and names its target', () => {
  const requests = [
    ...Array.from({ length: 98 }, () => ({ at, url: 'https://a.example/', status: 200, ms: 20, lag_ms: 0 })),
    { at, url: 'https://b.example/', status: 200, ms: 1490, lag_ms: 3 },
    { at, url: 'https://a.example/', status: 200, ms: 30, lag_ms: 0 },
  ];
  const summary = summarize(requests, settings, at, at);
  assert.equal(summary.slow, 1);
  assert.equal(summary.slow_requests[0].url, 'https://b.example/');
  assert.equal(summary.slow_while_lagging, 0);
  assert.equal(summary.p50_ms, 20);
  assert.equal(summary.max_ms, 1490);
});

test('a slow request sent while the prober lagged is counted apart, not as the computer\'s', () => {
  const requests = [
    { at, url: 'https://a.example/', status: 200, ms: 3800, lag_ms: 900 },
    { at, url: 'https://a.example/', status: 200, ms: 25, lag_ms: 0 },
  ];
  const summary = summarize(requests, settings, at, at);
  assert.equal(summary.slow, 0);
  assert.equal(summary.slow_while_lagging, 1);
  assert.equal(summary.most_lag_ms, 900);
  assert.equal(summary.max_ms, 25);
});

test('a refused or unanswered request is a failure, kept with its target', () => {
  const summary = summarize([
    { at, url: 'https://a.example/', status: 502, ms: 10, lag_ms: 0 },
    { at, url: 'https://b.example/', error: 'TimeoutError', ms: 5000, lag_ms: 0 },
  ], settings, at, at);
  assert.equal(summary.failed, 2);
  assert.equal(summary.ok, 0);
  assert.deepEqual(summary.failures.map(f => f.url), ['https://a.example/', 'https://b.example/']);
});

test('the arguments are flags then URLs, and a URL is required', () => {
  assert.deepEqual(parseArgs(['--every-ms', '25', '--log', '/x', 'https://a.example/']),
    { every_ms: 25, slow_ms: 1000, lag_ms: 250, log: '/x', urls: ['https://a.example/'] });
  assert.throws(() => parseArgs([]), /at least one URL/);
  assert.throws(() => parseArgs(['--slow-ms', '0', 'https://a.example/']), /above 0/);
});

test('run through a linked path, the probe asks until SIGTERM and prints its summary', async () => {
  const server = createServer((request, response) => response.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const linked = join(mkdtempSync(join(tmpdir(), 'probe-')), 'probe.mjs');
  symlinkSync(new URL('../do-work/probe-while-applying.mjs', import.meta.url).pathname, linked);
  const probe = spawn(process.execPath, [linked, '--every-ms', '20', `http://127.0.0.1:${server.address().port}/`]);
  let said = '';
  probe.stdout.on('data', chunk => { said += chunk; });
  const ended = new Promise(resolve => probe.on('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 600));
  probe.kill('SIGTERM');
  assert.equal(await ended, 0);
  server.close();
  const summary = JSON.parse(said);
  assert.ok(summary.sent > 0 && summary.ok === summary.sent, `asked ${summary.sent}, ok ${summary.ok}`);
});

// A server that answers the first request on each connection and keeps it open; a request on a reused connection is a reload:
// that one is dropped unanswered and every kept connection is closed, as a front door's graceful reload closes its idle
// kept-alive connections the instant a request goes out on one.
const dropsReused = () => {
  const open = new Set();
  return createTcpServer(socket => {
    let asked = 0;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('data', () => {
      if (++asked > 1) { for (const each of open) each.destroy(); return; }
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok');
    });
  });
};
const listening = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`)));

test('a request whose kept-alive connection closes before any answer is asked again, as a browser does, and keeps that it was', async () => {
  const server = dropsReused(), url = await listening(server);
  // The client reuses a connection on its own schedule (Node's fetch: from the third request), so four are asked.
  const kept = [];
  for (let i = 0; i < 4; i++) kept.push(await askOnce(url));
  server.close();
  assert.deepEqual(kept.map(r => r.status), [200, 200, 200, 200], 'each one dropped is asked again on a new connection');
  assert.equal(kept[0].retried, undefined);
  assert.ok(kept.some(r => ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(r.retried)), 'a reused connection was dropped and asked again');
  const summary = summarize(kept.map(r => ({ at, url, lag_ms: 0, ...r })), settings, at, at);
  assert.equal(summary.failed, 0);
  assert.equal(summary.retried, kept.filter(r => r.retried).length);
});

test('a server that drops every request still fails, after one more try', async () => {
  const server = createTcpServer(socket => socket.on('data', () => socket.destroy())), url = await listening(server);
  const kept = await askOnce(url);
  server.close();
  assert.ok(kept.error, 'a failure is never hidden by the retry');
  assert.equal(summarize([{ at, url, lag_ms: 0, ...kept }], settings, at, at).failed, 1);
});

// The front door's own reload, when this computer has Caddy: requests every 10 ms through five graceful reloads all answer.
const caddy = (() => { try { execFileSync('caddy', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('requests asked through a Caddy front door while it reloads five times all answer', { skip: !caddy && 'no caddy on this computer' }, async () => {
  const free = () => new Promise(resolve => { const s = createTcpServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const [port, admin] = [await free(), await free()];
  const folder = mkdtempSync(join(tmpdir(), 'reload-')), file = join(folder, 'Caddyfile');
  const write = n => writeFileSync(file, `{\n\tadmin 127.0.0.1:${admin}\n\tgrace_period 10s\n\tstorage file_system ${folder}/data\n}\nhttp://127.0.0.1:${port} {\n\theader x-gen ${n}\n\trespond "ok"\n}\n`);
  const caddyArgs = verb => [verb, '--config', file, '--adapter', 'caddyfile', ...(verb === 'reload' ? ['--address', `127.0.0.1:${admin}`] : [])];
  write(0);
  const running = spawn('caddy', caddyArgs('run'), { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !(await askOnce(`http://127.0.0.1:${port}/`)).status; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const kept = [];
    let asking = true;
    const ask = (async () => { while (asking) { kept.push(await askOnce(`http://127.0.0.1:${port}/`)); await new Promise(resolve => setTimeout(resolve, 10)); } })();
    for (let n = 1; n <= 5; n++) {
      write(n);
      execFileSync('caddy', caddyArgs('reload'), { stdio: 'ignore' });
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    asking = false;
    await ask;
    assert.ok(kept.length > 20, `asked ${kept.length}`);
    assert.deepEqual(kept.filter(r => r.status !== 200), [], 'every request answered');
  } finally { running.kill('SIGTERM'); }
});

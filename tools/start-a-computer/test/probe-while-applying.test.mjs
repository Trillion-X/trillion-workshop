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
import { parseArgs, summarize } from '../do-work/probe-while-applying.mjs';

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

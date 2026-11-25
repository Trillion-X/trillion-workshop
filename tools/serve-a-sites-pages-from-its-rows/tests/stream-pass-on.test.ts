// A pass_on entry marked stream (an MCP door on the app host) is piped both ways as it comes: the request's headers reach the
// other program unchanged (Host, Authorization, Mcp-Session-Id), its event stream's first event reaches the visitor while the
// stream is still open, its own headers come back, and the other program's call ends when the visitor's does.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handlerOf, settingsOf } from '../do-work/serve.ts';
import type { Site } from '../do-work/serve.ts';

const base = {
  listen: '127.0.0.1:0', origin: 'https://example.com', hosts: ['app.example.com'], lang: 'en', door: { address: 'http://127.0.0.1:1', pass_credential: 'p' },
  pages: { database: 'a_site', refresh_seconds: 60, answer_seconds: 0 },
  sign_in: { address: 'http://127.0.0.1:1', page: '/sign-in', issuer: 'https://example.com', audience: 'https://example.com', team_claim: 't', members_team: 'm' },
};

test('an MCP door is streamed: headers unchanged, the first event before the stream ends, closed when the visitor leaves', async () => {
  const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let release: () => void = () => {};
  let upstreamClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
  const door = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-2', 'cache-control': 'no-cache' });
      response.write('data: {"first":true}\n\n');
      if (request.method === 'GET') { response.on('close', () => upstreamClosed()); return; }
      new Promise<void>(resolve => { release = resolve; }).then(() => response.end('data: {"last":true}\n\n'));
    });
  });
  await new Promise<void>(resolve => door.listen(0, '127.0.0.1', resolve));
  const settings = settingsOf({ ...base, pass_on: [{ name: 'the engine door (MCP)', address: `http://127.0.0.1:${(door.address() as AddressInfo).port}`, exact: ['/mcp'], hosts: ['app.example.com'], stream: true }] });
  // A stand-in site with an action row at /mcp, so the exact entry must win over it, and no page rows.
  const site = { hostOf: (forwarded: string | undefined) => forwarded ?? 'example.com', acts: () => true, pageFor: () => null, siteHead: null } as unknown as Site;
  const server = http.createServer(handlerOf(site, settings.pass_on));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const answer = await fetch(`${at}/mcp?x=1`, {
      method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      headers: { 'x-forwarded-host': 'app.example.com', authorization: 'Bearer member-pass', 'mcp-session-id': 'session-1', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('mcp-session-id'), 'session-2', 'the door\'s own headers come back');
    assert.equal(answer.headers.get('content-type'), 'text/event-stream');
    const reader = answer.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.equal(first, 'data: {"first":true}\n\n', 'the first event arrives while the door still holds the stream open');
    release();
    let rest = '';
    for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value);
    assert.equal(rest, 'data: {"last":true}\n\n');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/mcp?x=1');
    assert.equal(seen[0].body, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    assert.equal(seen[0].headers.authorization, 'Bearer member-pass', 'Authorization passes unchanged');
    assert.equal(seen[0].headers['mcp-session-id'], 'session-1', 'Mcp-Session-Id passes unchanged');
    assert.equal(seen[0].headers.host, `127.0.0.1:${(server.address() as AddressInfo).port}`, 'Host passes unchanged');
    assert.equal(seen[0].headers['x-forwarded-host'], 'app.example.com');
    // A GET stays open as the door's event stream; the visitor leaving ends the door's call too.
    const leave = new AbortController();
    const open = await fetch(`${at}/mcp`, { headers: { 'x-forwarded-host': 'app.example.com', accept: 'text/event-stream' }, signal: leave.signal });
    assert.equal(new TextDecoder().decode((await open.body!.getReader().read()).value), 'data: {"first":true}\n\n');
    leave.abort();
    await closed;
    assert.equal(seen.length, 2, 'one call each, nothing retried');
  } finally { server.close(); door.close(); }
});

test('a stream entry never carries the site head', () => {
  assert.throws(() => settingsOf({ ...base, pass_on: [{ name: 'x', address: 'http://127.0.0.1:1', exact: ['/mcp'], stream: true, site_head: true }] }), /stream/);
  assert.throws(() => settingsOf({ ...base, pass_on: [{ name: 'x', address: 'http://127.0.0.1:1', exact: ['/mcp'], stream: 'yes' }] }), /stream/);
});

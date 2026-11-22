// The model-server check: a server that loads the probe model in time is healthy; one that does not is restarted only
// with its declared argv, waited for and probed again, with what was seen before and after; report-only never restarts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { checkTheServer } from '../read-data/check-the-model-server.mjs';

const stand_in = ({ hangs }) => new Promise(resolve => {
  const state = { hangs, chats: 0 };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/version') return response.end('{"version":"stand-in"}');
      if (request.url === '/api/ps') return response.end(JSON.stringify({ models: [{ name: 'held:latest' }] }));
      if (request.url === '/api/chat') {
        state.chats += 1;
        if (state.hangs) return; // never answers, as the stuck server did
        return response.end(JSON.stringify({ message: { content: 'ok' } }));
      }
      response.statusCode = 404; response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` }));
});

const settingsAt = (base, argv) => ({ words: {}, server: { door: 'local-model-server', models: `${base}/api/tags`, health: {
  chat: '/api/chat', loaded: '/api/ps', alive: '/api/version', probe_model: 'small', probe_words: 'say ok', probe_tokens: 5,
  probe_keep_alive: '1m', limit_seconds: 5, signature: 'stalls after an eviction',
  restart: { argv, run_seconds: 5, back_within_seconds: 5 } } } });

test('a server that loads the probe model in time is healthy and is not restarted', async () => {
  const { server, base } = await stand_in({ hangs: false });
  try {
    const result = await checkTheServer({}, settingsAt(base, ['/usr/bin/false']));
    assert.equal(result.healthy, true);
    assert.equal(result.probe.loads, true);
    assert.equal('restart' in result, false);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a server that does not load in time is restarted with its declared argv and probed again', async () => {
  const { server, state, base } = await stand_in({ hangs: true });
  try {
    const pending = checkTheServer({ limit_seconds: 1 }, settingsAt(base, ['/usr/bin/true', '{uid}']), { uid: 501 });
    setTimeout(() => { state.hangs = false; }, 500); // fixed before the probe that follows the restart
    const result = await pending;
    assert.equal(result.healthy, false);
    assert.match(result.probe.why, /no answer in 1 s/);
    assert.deepEqual(result.before.loaded, ['held:latest']);
    assert.deepEqual(result.restart.argv, ['/usr/bin/true', '501']);
    assert.equal(result.restart.exit, 0);
    assert.equal(typeof result.back_after_ms, 'number');
    assert.equal(result.after.probe.loads, true);
    assert.equal(result.signature, 'stalls after an eviction');
  } finally { server.closeAllConnections(); server.close(); }
});

test('a request can lower the limit but never raise it, and report-only never restarts', async () => {
  const { server, base } = await stand_in({ hangs: true });
  try {
    const result = await checkTheServer({ limit_seconds: 1, restart: false }, settingsAt(base, ['/usr/bin/false']));
    assert.equal(result.probe.limit_seconds, 1);
    assert.equal(result.restart, null);
    const capped = await checkTheServer({ limit_seconds: 1, restart: false }, settingsAt(base, ['/usr/bin/false']));
    assert.ok(capped.probe.limit_seconds <= 5);
  } finally { server.closeAllConnections(); server.close(); }
});

test('settings with no health block are refused in words', async () => {
  await assert.rejects(checkTheServer({}, { server: { door: 'd', models: 'http://127.0.0.1:1/api/tags' } }), /server.health needs probe_model and restart.argv/);
});

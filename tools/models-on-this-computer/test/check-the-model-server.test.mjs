// The model-server check: a server that loads the probe model in time is healthy; one that does not is restarted only
// with its declared argv, waited for and probed again, with what was seen before and after; report-only never restarts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { check, checkTheServer } from '../read-data/check-the-model-server.mjs';

const stand_in = ({ hangs, resident = ['held:latest'], installed = [], badResidency = false,
  residencyStatus = 200, installedStatus = 200, recoversAfterFirstChat = false }) => new Promise(resolve => {
  const state = { hangs, chats: 0, asked: [] };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/version') return response.end('{"version":"stand-in"}');
      if (request.url === '/api/ps') {
        response.statusCode = residencyStatus;
        return response.end(JSON.stringify(badResidency ? {} : { models: resident.map(name => ({ name })) }));
      }
      if (request.url === '/api/tags') {
        response.statusCode = installedStatus;
        return response.end(JSON.stringify({ models: installed.map(name => ({ name })) }));
      }
      if (request.url === '/api/chat') {
        state.chats += 1;
        state.asked.push(JSON.parse(body).model);
        if (state.hangs) {
          if (recoversAfterFirstChat) state.hangs = false;
          return; // this request never answers, as the stuck server did
        }
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
    assert.equal(result.probe.cold_before, true);
    assert.equal('restart' in result, false);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a resident primary is replaced by an installed, unloaded standby in the probe', async () => {
  const { server, state, base } = await stand_in({ hangs: false, resident: ['small:latest'], installed: ['standby:latest'] });
  try {
    const settings = settingsAt(base, ['/usr/bin/false']);
    settings.server.health.standby_model = 'standby';
    const result = await checkTheServer({}, settings);
    assert.equal(result.healthy, true);
    assert.equal(result.probe.cold_before, true);
    assert.deepEqual(result.before.loaded, ['small:latest']);
    assert.deepEqual(state.asked, ['standby']);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a warm answer is inconclusive when the standby is warm or uninstalled', async () => {
  for (const resident of [['small:latest', 'standby:latest'], ['small:latest']]) {
    const { server, state, base } = await stand_in({ hangs: false, resident });
    try {
      const settings = settingsAt(base, ['/usr/bin/false']);
      settings.server.health.standby_model = 'standby';
      const result = await checkTheServer({}, settings);
      assert.equal(result.healthy, null);
      assert.equal(result.probe.cold_before, false);
      assert.equal(result.probe.loads, true);
      assert.equal('restart' in result, false);
      assert.deepEqual(state.asked, ['small']);
    } finally { server.closeAllConnections(); server.close(); }
  }
});

test('an answer with malformed residency data does not count as a fresh load', async () => {
  const { server, base } = await stand_in({ hangs: false, badResidency: true });
  try {
    const result = await checkTheServer({}, settingsAt(base, ['/usr/bin/false']));
    assert.equal(result.healthy, null);
    assert.equal(result.probe.cold_before, null);
    assert.equal(result.probe.loads, true);
    assert.equal('restart' in result, false);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a server that does not load in time is restarted with its declared argv and probed again', async () => {
  const { server, base } = await stand_in({ hangs: true, recoversAfterFirstChat: true });
  try {
    const result = await checkTheServer({ limit_seconds: 1 }, settingsAt(base, ['/usr/bin/true', '{uid}']), { uid: 501 });
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
    const settings = settingsAt(base, ['/usr/bin/false']);
    settings.server.health.limit_seconds = 0.05;
    const capped = await checkTheServer({ limit_seconds: 99, restart: false }, settings);
    assert.equal(capped.probe.limit_seconds, 0.05);
    assert.equal(capped.restart, null);
  } finally { server.closeAllConnections(); server.close(); }
});

test('an unavailable residency route never turns a model reply into a healthy load check', async () => {
  const { server, base } = await stand_in({ hangs: false, residencyStatus: 503 });
  try {
    const result = await checkTheServer({}, settingsAt(base, ['/usr/bin/false']));
    assert.equal(result.healthy, null);
    assert.equal(result.probe.cold_before, null);
    assert.equal(result.probe.loads, true);
    assert.equal(result.before.loaded, null);
    assert.equal('restart' in result, false);
  } finally { server.closeAllConnections(); server.close(); }
});

test('an unavailable installed-model route leaves a warm answer inconclusive', async () => {
  const { server, state, base } = await stand_in({ hangs: false, resident: ['small:latest'],
    installed: ['standby:latest'], installedStatus: 503 });
  try {
    const settings = settingsAt(base, ['/usr/bin/false']);
    settings.server.health.standby_model = 'standby';
    const result = await checkTheServer({}, settings);
    assert.equal(result.healthy, null);
    assert.equal(result.probe.cold_before, false);
    assert.equal('restart' in result, false);
    assert.deepEqual(state.asked, ['small']);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a refused restart is kept separate from a successful follow-up reply', async () => {
  const { server, base } = await stand_in({ hangs: true, recoversAfterFirstChat: true });
  try {
    const result = await checkTheServer({ limit_seconds: 0.05 }, settingsAt(base, ['/usr/bin/false']));
    assert.equal(result.healthy, false);
    assert.equal(result.probe.loads, false);
    assert.match(result.probe.why, /no answer in 0.05 s/);
    assert.equal(result.restart.exit, 1);
    assert.equal(result.after.probe.loads, true);
  } finally { server.closeAllConnections(); server.close(); }
});

test('an unavailable server is not healthy and report-only never attempts a restart', async () => {
  const { server, base } = await stand_in({ hangs: false });
  await new Promise(resolve => server.close(resolve));
  const result = await checkTheServer({ restart: false }, settingsAt(base, ['/usr/bin/false']));
  assert.equal(result.healthy, false);
  assert.equal(result.probe.loads, false);
  assert.equal(result.probe.cold_before, null);
  assert.equal(result.before.loaded, null);
  assert.equal(result.restart, null);
});

test('a missing local door is an error, never a healthy report', async () => {
  await assert.rejects(check({ input: { restart: false }, local_ports: {} }), /does not report a port named local-model-server/);
});

test('settings with no health block are refused in words', async () => {
  await assert.rejects(checkTheServer({}, { server: { door: 'd', models: 'http://127.0.0.1:1/api/tags' } }), /server.health needs probe_model and restart.argv/);
});

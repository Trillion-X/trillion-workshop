// Moved from Trillion-X/trillion test/mcp-registration-loopback.test.mjs with harness/mcp-registration.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcp } from '../do-work/mcp-registration.mjs';

const DEFAULT_URL = 'https://app.gettrillion.ai/mcp';
const rules = JSON.parse(readFileSync(new URL('../read-data/mcp-registration.json', import.meta.url), 'utf8'));
const remoteRules = structuredClone(rules);
for (const row of remoteRules.mcp_registration.clients.filter(item => ['claude-code', 'codex'].includes(item.id))) {
  delete row.transport;
  row.entry = row.id === 'claude-code' ? { type: 'http', url: '{mcp}' } : { url: '{mcp}' };
  row.same_when = 'url';
}
const tempHome = (t, client = 'codex') => {
  const root = mkdtempSync(join(tmpdir(), 'trillion-mcp-registration-loopback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const configHome = join(home, client === 'claude-code' ? '.claude' : '.codex');
  mkdirSync(configHome, { recursive: true });
  const path = client === 'claude-code'
    ? join(configHome, '.claude.json')
    : join(configHome, 'config.toml');
  const before = client === 'claude-code'
    ? JSON.stringify({ numStartups: 3, mcpServers: { other: { url: 'https://keep.example/mcp' } } }, null, 2)
    : 'model = "fixture-model"\n\n[profiles.local]\nvalue = "preserve"\n';
  writeFileSync(path, before);
  return { client, home, configHome, path, before };
};
const localAppRules = (fixture, port) => {
  const next = structuredClone(rules);
  const appPath = join(fixture.home, 'Applications/Trillion.app');
  const resources = join(appPath, 'Contents/Resources');
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, 'computer-reader.json'), JSON.stringify({ local_runtime: { adoption_file: 'Trillion/local-runtime.json' } }));
  const support = join(fixture.home, 'Library/Application Support/Trillion');
  mkdirSync(support, { recursive: true });
  writeFileSync(join(support, 'local-runtime.json'), JSON.stringify({ port }));
  next.mac_app.path = appPath;
  return next;
};
const call = (fixture, action, url, extra = {}) => registerMcp({
  action,
  clients: fixture.client,
  url,
  home: fixture.home,
  env: fixture.client === 'claude-code'
    ? { CLAUDE_CONFIG_DIR: fixture.configHome }
    : { CODEX_HOME: fixture.configHome },
  rules: extra.rules ?? remoteRules,
  ...extra,
});
const assertReadback = (fixture, url) => {
  const actual = readFileSync(fixture.path, 'utf8');
  if (fixture.client === 'claude-code') {
    assert.deepEqual(JSON.parse(actual), {
      numStartups: 3,
      mcpServers: {
        other: { url: 'https://keep.example/mcp' },
        trillion: { type: 'http', url },
      },
    });
  } else {
    assert.ok(actual.includes(`url = "${url}"`), 'the selected URL is stored without rewriting');
    assert.ok(actual.includes('model = "fixture-model"'));
    assert.ok(actual.includes('value = "preserve"'));
  }
};

for (const client of ['codex', 'claude-code']) {
  for (const url of ['http://127.0.0.1:7189/mcp', 'http://[::1]:7189/mcp']) {
    test(`${client} preview and reviewed register preserve ${url} and read it back`, t => {
    const fixture = tempHome(t, client);
    const preview = call(fixture, 'mcp-preview', url);
    assert.equal(preview.url, url);
    assert.equal(preview.boundary, 'This local MCP entry configures transport only; it does not authenticate the client or provide client proof.');
    assert.match(preview.review_hash, /^[a-f0-9]{64}$/);
    assert.equal(preview.results[0].now, 'absent');
    assert.equal(preview.results[0].sign_in, 'This action configures the local MCP transport only; it does not provide authentication or client proof.');
    assert.equal(readFileSync(fixture.path, 'utf8'), fixture.before, 'preview does not write');

    const registered = call(fixture, 'mcp-register', url, { reviewed: preview.review_hash });
    assert.equal(registered.refused, undefined);
    assert.equal(registered.url, url);
    assert.equal(registered.results[0].result, 'registered');
    assert.match(registered.results[0].after_blake3, /^[a-f0-9]{64}$/);
    assert.ok(registered.results[0].backup && existsSync(registered.results[0].backup));
    assert.equal(readFileSync(registered.results[0].backup, 'utf8'), fixture.before);
    assertReadback(fixture, url);
    assert.match(registered.results[0].sign_in, /does not provide authentication or client proof/);
    assert.doesNotMatch(registered.results[0].sign_in, /\/docs/);
    });
  }
}

for (const client of ['codex', 'claude-code']) {
  test(`${client} adopts only the loopback address matching the app's current port, then stays stable after a port change`, t => {
    const fixture = tempHome(t, client);
    const port = 8788;
    const configured = localAppRules(fixture, port);
    const bridge = join(configured.mac_app.path, configured.mac_app.payload, 'keychain-mcp-bridge.mjs');
    const runtime = join(configured.mac_app.path, configured.mac_app.runtime);
    const oldAddress = `http://127.0.0.1:${port}/mcp`;
    if (client === 'claude-code') {
      const before = JSON.parse(fixture.before);
      before.mcpServers.trillion = { type: 'http', url: oldAddress };
      writeFileSync(fixture.path, JSON.stringify(before, null, 2));
    } else {
      writeFileSync(fixture.path, `${fixture.before}\n[mcp_servers.trillion]\ncommand = ${JSON.stringify(runtime)}\nargs = ${JSON.stringify([bridge, oldAddress])}\n`);
    }
    const preview = call(fixture, 'mcp-preview', undefined, { rules: configured });
    assert.equal(preview.results[0].now, 'outdated');
    assert.equal(preview.transport, 'installed-local-bridge');
    assert.equal(preview.url, undefined);
    assert.doesNotMatch(JSON.stringify(preview), /https:\/\/app\.gettrillion\.ai\/mcp/);
    assert.doesNotMatch(JSON.stringify(preview), /keep\.example|numStartups/,
      'the preview reports only the named MCP entry, not unrelated config contents');
    const registered = call(fixture, 'mcp-register', undefined, { rules: configured, reviewed: preview.review_hash });
    assert.equal(registered.results[0].result, 'updated');
    const after = call(fixture, 'mcp-inspect', undefined, { rules: configured });
    assert.equal(after.results[0].now, 'registered');

    writeFileSync(join(fixture.home, 'Library/Application Support/Trillion/local-runtime.json'), JSON.stringify({ port: 9001 }));
    const restarted = call(fixture, 'mcp-inspect', undefined, { rules: configured });
    assert.equal(restarted.results[0].now, 'registered', 'the host config contains a bridge path, not the retired port');
  });
}

test('remote HTTP, userinfo, spoofed loopback suffix and other schemes refuse before the writer', t => {
  const fixture = tempHome(t);
  const before = readFileSync(fixture.path, 'utf8');
  for (const url of [
    'http://remote.example/mcp',
    'http://user@127.0.0.1:7189/mcp',
    'http://127.0.0.1.evil.example/mcp',
    'http://localhost:7189/mcp',
    'ftp://127.0.0.1:7189/mcp',
    'https://user:password@example.test/mcp',
  ]) {
    let writes = 0;
    assert.throws(() => call(fixture, 'mcp-register', url, {
      write() {
        writes += 1;
        throw new Error('must not reach writer');
      },
    }), /literal loopback|sign-in/);
    assert.equal(writes, 0, url);
    assert.equal(readFileSync(fixture.path, 'utf8'), before, url);
  }
});

test('a loopback address for a different app-owned port is still custom and a fixed URL is refused', t => {
  const fixture = tempHome(t, 'claude-code');
  const configured = localAppRules(fixture, 9001);
  const before = JSON.parse(fixture.before);
  before.mcpServers.trillion = { type: 'http', url: 'http://127.0.0.1:8788/mcp' };
  writeFileSync(fixture.path, JSON.stringify(before, null, 2));
  const preview = call(fixture, 'mcp-preview', undefined, { rules: configured });
  assert.equal(preview.results[0].now, 'custom');
  assert.equal(preview.results[0].diff, undefined);
  const unchanged = readFileSync(fixture.path, 'utf8');
  assert.throws(() => call(fixture, 'mcp-register', 'http://127.0.0.1:8788/mcp', { rules: configured }), /fixed --mcp-url/);
  assert.equal(readFileSync(fixture.path, 'utf8'), unchanged);
});

test('the current HTTPS register flow and shared sign-in guide stay unchanged', t => {
  const fixture = tempHome(t);
  const preview = call(fixture, 'mcp-preview', DEFAULT_URL);
  assert.equal(preview.url, DEFAULT_URL);
  assert.ok(preview.results[0].sign_in.includes('https://app.gettrillion.ai/docs'));
  assert.equal(readFileSync(fixture.path, 'utf8'), fixture.before);
  const registered = call(fixture, 'mcp-register', DEFAULT_URL, { reviewed: preview.review_hash });
  assert.equal(registered.results[0].result, 'registered');
  assert.ok(readFileSync(fixture.path, 'utf8').includes(`url = "${DEFAULT_URL}"`));
});

test('a custom same-named entry and unrelated config bytes remain owned by the person', t => {
  const fixture = tempHome(t);
  const custom = '[mcp_servers.trillion]\nurl = "https://my-proxy.example/mcp"\nheader = "keep"\n';
  const before = `${fixture.before}\n${custom}`;
  writeFileSync(fixture.path, before);
  const preview = call(fixture, 'mcp-preview', 'http://127.0.0.1:7189/mcp');
  assert.equal(preview.results[0].now, 'custom');
  assert.equal(preview.results[0].would_change, undefined);
  const result = call(fixture, 'mcp-register', 'http://127.0.0.1:7189/mcp', { reviewed: preview.review_hash });
  assert.equal(result.results[0].result, 'custom');
  assert.equal(readFileSync(fixture.path, 'utf8'), before);
});

for (const client of ['codex', 'claude-code']) {
  test(`${client} reviewed registration replaces its owned hosted entry with the dynamic local bridge`, t => {
    const fixture = tempHome(t, client);
    if (client === 'claude-code') {
      const before = JSON.parse(fixture.before);
      before.mcpServers.trillion = { type: 'http', url: DEFAULT_URL, timeout: 20 };
      writeFileSync(fixture.path, JSON.stringify(before, null, 2));
    } else {
      writeFileSync(fixture.path, `${fixture.before}\n[mcp_servers.trillion]\nurl = "${DEFAULT_URL}"\nstartup_timeout_sec = 20\n`);
    }
    const existing = readFileSync(fixture.path, 'utf8');
    const preview = call(fixture, 'mcp-preview', undefined, { rules });
    assert.equal(preview.transport, 'installed-local-bridge');
    assert.equal(preview.results[0].now, 'outdated');
    assert.match(preview.boundary, /current local door address for each call/);
    assert.match(preview.results[0].diff.added.join('\n'), /keychain-mcp-bridge\.mjs/);
    assert.doesNotMatch(preview.results[0].diff.added.join('\n'), /8788|9001|app\.gettrillion\.ai\/mcp/);
    assert.equal(readFileSync(fixture.path, 'utf8'), existing, 'preview does not write');

    const registered = call(fixture, 'mcp-register', undefined, { rules, reviewed: preview.review_hash });
    assert.equal(registered.results[0].result, 'updated');
    assert.ok(registered.results[0].backup && existsSync(registered.results[0].backup));
    const command = '/Applications/Trillion.app/Contents/MacOS/node';
    const bridge = '/Applications/Trillion.app/Contents/Resources/harness/keychain-mcp-bridge.mjs';
    if (client === 'claude-code') {
      const actual = JSON.parse(readFileSync(fixture.path, 'utf8'));
      assert.deepEqual(actual.mcpServers.trillion, { timeout: 20, command, args: [bridge] });
      assert.equal(actual.numStartups, 3);
    } else {
      const actual = readFileSync(fixture.path, 'utf8');
      assert.match(actual, /command = "\/Applications\/Trillion\.app\/Contents\/MacOS\/node"/);
      assert.match(actual, /args = \["\/Applications\/Trillion\.app\/Contents\/Resources\/harness\/keychain-mcp-bridge\.mjs"\]/);
      assert.doesNotMatch(actual, /url = "https:\/\/app\.gettrillion\.ai\/mcp"/);
      assert.match(actual, /model = "fixture-model"/);
      assert.match(actual, /value = "preserve"/);
    }
  });
}

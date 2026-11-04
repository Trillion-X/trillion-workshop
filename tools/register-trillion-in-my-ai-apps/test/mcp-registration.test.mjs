// The MCP registration cases of Trillion-X/trillion test/harness-guidance-mcp-and-runs.test.mjs, moved with
// harness/mcp-registration.mjs. Its first case also checked the old repository's connect catalogue (src/ai-clients.json)
// and setup answer (src/setup-installs.mjs), which stay there; that case keeps the row checks this folder owns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_ACTIONS, lineDiff, registerMcp, tomlTable } from '../do-work/mcp-registration.mjs';
import { settings as setupRules } from '../do-work/register-in-ai-apps.mjs';

const tempHome = t => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trillion-harness-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const URL_ = 'https://app.gettrillion.ai/mcp';
test('every registration row has its own id, a known format and a sign-in, and the setup command offers the four actions', () => {
  const ids = setupRules.mcp_registration.clients.map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const row of setupRules.mcp_registration.clients) {
    assert.ok(['json', 'toml-table'].includes(row.format), `${row.id} has a known format`);
    assert.ok(row.sign_in, `${row.id} names its sign-in`);
  }
  assert.deepEqual(MCP_ACTIONS, ['mcp-inspect', 'mcp-preview', 'mcp-register', 'mcp-unregister']);
});

test('preview writes nothing; register writes each named app once with per-app results; unregister takes it out', t => {
  const home = tempHome(t);
  for (const folder of ['.claude', '.codex', '.cursor']) mkdirSync(join(home, folder));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { other: { url: 'https://x.test' } } }, null, 2));
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const call = (action, extra = {}) => registerMcp({ action, clients: 'claude-code,codex,cursor,gemini-cli', home, env: {}, rules: setupRules, ...extra });
  const before = ['.claude.json', '.codex/config.toml'].map(file => readFileSync(join(home, file), 'utf8'));
  const preview = call('mcp-preview');
  assert.deepEqual(preview.results.map(row => [row.client, row.now]), [['claude-code', 'absent'], ['codex', 'absent'], ['cursor', 'absent'], ['gemini-cli', 'not_installed']]);
  assert.deepEqual(preview.results[1].diff.added, [
    '[mcp_servers.trillion]',
    'command = "/Applications/Trillion.app/Contents/MacOS/node"',
    'args = ["/Applications/Trillion.app/Contents/Resources/harness/keychain-mcp-bridge.mjs"]',
    '',
  ]);
  assert.deepEqual(['.claude.json', '.codex/config.toml'].map(file => readFileSync(join(home, file), 'utf8')), before, 'preview wrote nothing');
  assert.equal(existsSync(join(home, '.cursor', 'mcp.json')), false);
  // A plan reviewed earlier no longer matches once a file changed: nothing is written.
  writeFileSync(join(home, '.codex', 'config.toml'), before[1] + '# edited\n');
  const refused = call('mcp-register', { reviewed: preview.review_hash });
  assert.match(refused.refused, /changed since the reviewed preview/);
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before[0]);
  const fresh = call('mcp-preview');
  const done = call('mcp-register', { reviewed: fresh.review_hash });
  assert.deepEqual(done.results.map(row => [row.client, row.result]), [['claude-code', 'registered'], ['codex', 'registered'], ['cursor', 'registered'], ['gemini-cli', 'not_installed']]);
  const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(claude, { numStartups: 3, mcpServers: { other: { url: 'https://x.test' }, trillion: {
    command: '/Applications/Trillion.app/Contents/MacOS/node',
    args: ['/Applications/Trillion.app/Contents/Resources/harness/keychain-mcp-bridge.mjs'],
  } } });
  assert.ok(done.results[0].backup && existsSync(done.results[0].backup), 'the earlier bytes are kept');
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), `${before[1]}# edited\n\n[mcp_servers.trillion]\ncommand = "/Applications/Trillion.app/Contents/MacOS/node"\nargs = ["/Applications/Trillion.app/Contents/Resources/harness/keychain-mcp-bridge.mjs"]\n`);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')), { mcpServers: { trillion: { url: URL_ } } });
  assert.ok(done.results.every(row => row.sign_in), 'every result names the sign-in still to do');
  assert.deepEqual(call('mcp-register').results.map(row => row.result), ['already_registered', 'already_registered', 'already_registered', 'not_installed']);
  assert.deepEqual(call('mcp-inspect').results.map(row => row.now), ['registered', 'registered', 'registered', 'not_installed']);
  const gone = call('mcp-unregister');
  assert.deepEqual(gone.results.map(row => row.result), ['removed', 'removed', 'removed', 'not_installed']);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')), { numStartups: 3, mcpServers: { other: { url: 'https://x.test' } } });
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), `${before[1]}# edited\n`);
  assert.deepEqual(call('mcp-unregister').results.map(row => row.result), ['already_absent', 'already_absent', 'already_absent', 'not_installed']);
});

test("a same-named entry pointing elsewhere is the person's own and is never changed or removed; odd TOML is blocked", t => {
  const home = tempHome(t);
  mkdirSync(join(home, '.cursor')); mkdirSync(join(home, '.codex'));
  const mine = { mcpServers: { trillion: { url: 'https://my-proxy.test/mcp', headers: { a: 'b' } } } };
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify(mine));
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers]\ntrillion = { url = "x" }\n');
  const done = registerMcp({ action: 'mcp-register', clients: 'cursor,codex', home, env: {}, rules: setupRules });
  assert.deepEqual(done.results.map(row => [row.client, row.result]), [['cursor', 'custom'], ['codex', 'blocked']]);
  assert.deepEqual(registerMcp({ action: 'mcp-unregister', clients: 'cursor', home, env: {}, rules: setupRules }).results[0].result, 'custom');
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')), mine);
  // Trillion's own entry keeps every extra field the person added when it is updated.
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { trillion: { url: URL_, headers: { a: 'b' }, type: 'old' } } }));
  assert.equal(registerMcp({ action: 'mcp-register', clients: 'cursor', home, env: {}, rules: setupRules }).results[0].result, 'already_registered');
  assert.throws(() => registerMcp({ action: 'mcp-register', clients: 'nobody', home, env: {}, rules: setupRules }), /No MCP registration row/);
  assert.throws(() => registerMcp({ action: 'mcp-register', clients: 'cursor', url: 'http://plain.test/mcp', home, env: {}, rules: setupRules }), /https/);
  const table = tomlTable('[mcp_servers.trillion]\nurl = "u"\n\n[mcp_servers.trillion.env]\nA = "1"\n[other]\nb = 2\n', ['mcp_servers'], 'trillion');
  assert.deepEqual([table.state, table.from, table.mainTo, table.to, table.fields], ['found', 0, 3, 5, { url: 'u' }]);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nX\nc'), { at_line: 2, removed: ['b'], added: ['X'] });
});

test('the setup command runs the explicit action end to end on a pretend home', t => {
  const home = tempHome(t); mkdirSync(join(home, '.cursor'));
  const setupPath = fileURLToPath(new URL('../do-work/register-in-ai-apps.mjs', import.meta.url));
  const run = action => JSON.parse(execFileSync(process.execPath, [setupPath, '--action', action, '--client', 'cursor'], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  assert.equal(run('mcp-preview').results[0].now, 'absent');
  assert.equal(run('mcp-register').results[0].result, 'registered');
  assert.equal(run('mcp-unregister').results[0].result, 'removed');
});

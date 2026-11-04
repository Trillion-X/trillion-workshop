// tool:open-in-ai (read-data/open-in-ai.mjs): a prompt opened in an allowlisted local AI app, through argv lists only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { openInAi, launchOf } from '../read-data/open-in-ai.mjs';

const home = mkdtempSync(join(tmpdir(), 'open-in-ai-'));
mkdirSync(join(home, 'Applications/Claude.app'), { recursive: true });
const spawned = [];
const pretend = (command, args, options) => {
  spawned.push({ command, args, options });
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => (command === '/missing' ? child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })) : child.emit('spawn')));
  return child;
};
const PROMPT = 'Fix "the bug" & $(rm -rf ~) `x`; then stop';

test('a URL launch passes the prompt as one percent-encoded argument to the opener, never through a shell', async () => {
  const done = await openInAi({ app: 'claude-code', prompt: PROMPT }, { spawnImpl: pretend, home });
  assert.equal(done.outcome, 'launched');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, '/usr/bin/open');
  assert.deepEqual(spawned[0].args, [`claude://code/new?q=${encodeURIComponent(PROMPT)}`]);
  assert.equal(JSON.stringify(done).includes('rm -rf'), false, 'the prompt is not echoed');
  assert.equal(done.prompt_chars, PROMPT.length);
});

test('an app that is not installed, not in the rows, or given a bad prompt or folder is typed, and nothing runs', async () => {
  spawned.length = 0;
  assert.equal((await openInAi({ app: 'codex', prompt: 'hi' }, { spawnImpl: pretend, home })).outcome, 'app_missing');
  const unknown = await openInAi({ app: 'bash', prompt: 'hi' }, { spawnImpl: pretend, home });
  assert.equal(unknown.outcome, 'refused'); assert.match(unknown.said, /opens: claude-code, codex/);
  assert.equal((await openInAi({ app: 'claude-code', prompt: '  ' }, { spawnImpl: pretend, home })).outcome, 'refused');
  assert.equal((await openInAi({ app: 'claude-code', prompt: 'x'.repeat(20001) }, { spawnImpl: pretend, home })).outcome, 'refused');
  assert.match((await openInAi({ app: 'claude-code', prompt: 'hi', folder: join(home, 'nope') }, { spawnImpl: pretend, home })).said, /not a folder that exists/);
  assert.equal(spawned.length, 0);
});

test('an argv row runs its list as it is in the folder the person named, the prompt standing for one argument', async () => {
  spawned.length = 0;
  const rules = { opener: '/usr/bin/open', max_prompt_chars: 100, words: JSON.parse(JSON.stringify((await import('../read-data/open-in-ai.json', { with: { type: 'json' } })).default.words)),
    apps: [{ id: 'tool', label: 'Tool', installed: [home], needs_folder: true, launch: { kind: 'argv', argv: ['/usr/local/bin/tool', '--prompt', '{prompt}'] } }] };
  const folder = join(home, 'work'); mkdirSync(folder);
  assert.equal((await openInAi({ app: 'tool', prompt: 'go' }, { spawnImpl: pretend, home, rules })).outcome, 'refused', 'a required folder must be named');
  const done = await openInAi({ app: 'tool', prompt: PROMPT.slice(0, 40), folder }, { spawnImpl: pretend, home, rules });
  assert.equal(done.outcome, 'launched');
  assert.deepEqual(spawned[0].args, ['--prompt', PROMPT.slice(0, 40)]);
  assert.equal(spawned[0].options.cwd, realpathSync(folder));
  const failing = { ...rules, apps: [{ ...rules.apps[0], launch: { kind: 'argv', argv: ['/missing', '{prompt}'] } }] };
  const lost = await openInAi({ app: 'tool', prompt: 'go', folder }, { spawnImpl: pretend, home, rules: failing });
  assert.equal(lost.outcome, 'refused'); assert.match(lost.said, /ENOENT/);
});

test('dry_run shows the argv without running it', async () => {
  spawned.length = 0;
  const shown = await openInAi({ app: 'claude-code', prompt: 'hello', dry_run: true }, { spawnImpl: pretend, home });
  assert.equal(spawned.length, 0);
  assert.deepEqual(shown.argv, ['/usr/bin/open', 'claude://code/new?q=<prompt>']);
  assert.equal(launchOf({ launch: { kind: 'url', url: 'codex://new?prompt={prompt}' } }, { prompt: 'a b' }).args[0], 'codex://new?prompt=a%20b');
});

test('the Workshop row runs openInAi through the records-door command, on the person\'s computer', async () => {
  const rows = (await import('../tool-rows.json', { with: { type: 'json' } })).default.records.map(row => row.payload);
  const row = rows.find(each => each.id === 'tool:open-in-ai');
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.argv.slice(-2), ['/opt/open-a-prompt-in-a-local-ai-app/read-data/open-in-ai.mjs', 'openInAi']);
  assert.deepEqual(row.input_schema.required, ['app', 'prompt']);
});

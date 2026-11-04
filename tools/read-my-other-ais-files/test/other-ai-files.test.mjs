// Reading the instructions and skills kept for other AIs, in place and labelled (read-data/other-ai-files.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { otherAiFiles } from '../read-data/other-ai-files.mjs';
import rules from '../read-data/other-ai-files.json' with { type: 'json' };
import toolRows from '../tool-rows.json' with { type: 'json' };

const home = realpathSync(mkdtempSync(join(tmpdir(), 'other-ai-')));
mkdirSync(join(home, '.claude/skills/jab-hook'), { recursive: true });
mkdirSync(join(home, '.claude/commands'), { recursive: true });
mkdirSync(join(home, '.cursor/rules'), { recursive: true });
mkdirSync(join(home, '.codex/skills/other'), { recursive: true });
writeFileSync(join(home, '.claude/CLAUDE.md'), 'Be brief.');
writeFileSync(join(home, '.claude/skills/jab-hook/SKILL.md'), 'x'.repeat(rules.most_chars + 50));
writeFileSync(join(home, '.claude/commands/ship.md'), 'ship it');
writeFileSync(join(home, '.claude/commands/notes.txt'), 'not a command');
writeFileSync(join(home, '.cursor/rules/style.mdc'), 'tabs');
writeFileSync(join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { search: { command: 'npx', args: ['-y', 'search-mcp'], env: { API_KEY: 'sk-live-123' } }, remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' } } } }));
symlinkSync(join(home, '.claude/skills/jab-hook'), join(home, '.codex/skills/linked'));

test('the listing names each entry by app, kind and name, with no contents, and narrows by source and kind', () => {
  const all = otherAiFiles({}, { home });
  assert.deepEqual(all.entries.map(entry => entry.name).sort(), ['claude-code/commands/ship.md', 'claude-code/instructions/CLAUDE.md', 'claude-code/skills/jab-hook', 'cursor/mcp_servers/remote', 'cursor/mcp_servers/search', 'cursor/rules/style.mdc']);
  assert.ok(all.entries.every(entry => entry.label && !('text' in entry) && !('path' in entry)));
  assert.deepEqual(otherAiFiles({ source: 'cursor', kind: 'rules' }, { home }).entries.map(entry => entry.kind), ['rules']);
  assert.deepEqual(otherAiFiles({ kind: 'skills' }, { home }).entries.map(entry => entry.name), ['claude-code/skills/jab-hook']);
});

test('read returns the named files labelled by app, cuts long ones saying so, and a link in a folder is never followed', () => {
  const got = otherAiFiles({ read: ['claude-code/instructions/CLAUDE.md', 'claude-code/skills/jab-hook', 'codex/skills/linked', 'nope'] }, { home });
  assert.deepEqual(got.files[0], { name: 'claude-code/instructions/CLAUDE.md', source: 'claude-code', label: 'Claude Code', kind: 'instructions', text: 'Be brief.' });
  assert.equal(got.files[1].text.length, rules.most_chars);
  assert.match(got.files[1].said, /Cut after 20000 characters of 20050/);
  assert.match(got.files[2].error, /not one of the files listed/);
  assert.match(got.files[3].error, /not one of the files listed/);
});

test('an unknown app or kind is said, and the tool is a Workshop row on the person\'s computer', () => {
  assert.match(otherAiFiles({ source: 'vim' }, { home }).error, /vim is not one of the AI apps this Mac reads: claude-code, codex, cursor, claude-desktop, gemini-cli, windsurf/);
  assert.match(otherAiFiles({ kind: 'dreams' }, { home }).error, /dreams is not a kind/);
  const row = toolRows.records.map(each => each.payload).find(each => each.id === 'tool:other-ai-files');
  assert.deepEqual([row.invoke.kind, row.invoke.capabilities], ['computer', ['read-a-folder']]);
});

test('another app\'s MCP servers are described with their variable names only, never their values, and are never switched on', () => {
  const got = otherAiFiles({ read: ['cursor/mcp_servers/search', 'cursor/mcp_servers/remote'] }, { home });
  assert.deepEqual(JSON.parse(got.files[0].text), { command: 'npx', args: ['-y', 'search-mcp'], env: { API_KEY: '[hidden]' } });
  assert.deepEqual(JSON.parse(got.files[1].text), { url: 'https://example.com/mcp', headers: { Authorization: '[hidden]' } });
  assert.equal(JSON.stringify(got).includes('sk-live-123') || JSON.stringify(got).includes('Bearer abc'), false);
  assert.equal(got.files[0].kind, 'mcp_servers');
});

test('the row\'s command reads under the granted folder and prints { result } as its last line', async () => {
  const { execFileSync } = await import('node:child_process');
  const command = new URL('../../records-door/do-work/run-an-export.mjs', import.meta.url).pathname;
  const module = new URL('../read-data/other-ai-files.mjs', import.meta.url).pathname;
  const out = execFileSync(process.execPath, [command, module, 'otherAiFilesInGrantedFolder', home], { input: JSON.stringify({ source: 'claude-code', kind: 'instructions', read: ['claude-code/instructions/CLAUDE.md'] }) }).toString().trim().split('\n').at(-1);
  assert.equal(JSON.parse(out).result.files[0].text, 'Be brief.');
});

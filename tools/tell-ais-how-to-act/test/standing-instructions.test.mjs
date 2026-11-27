// do-work/standing-instructions.mjs (moved from Trillion-X/trillion harness/standing-instructions.mjs, which had no
// test of its own there) and its entry, on a pretend home.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockOf, change, findBlock, harnessIds, instructionPath, harnessRow, keepInstructions, standing } from '../do-work/standing-instructions.mjs';
import { keep } from '../do-work/keep-standing-instructions.mjs';
import { runOnAgent } from 'trillion-workshop/tools/hand-off-jobs-between-agents/src/agent-tool-runs.mjs';
import { selectDeclaredValue } from 'trillion-workshop/tools/ui/read-data/declared-selector.ts';
import macTools from 'trillion-workshop/tools/run-on-a-persons-computer/mac-tools.json' with { type: 'json' };

const tempHome = t => { const dir = realpathSync(tempFolder(join(tmpdir(), 'standing-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const env = {};

test('apply writes one block after the person\'s own text, twice changes nothing, remove gives the file back byte for byte', t => {
  const home = tempHome(t);
  const path = join(home, '.codex', 'AGENTS.md');
  mkdirSync(join(home, '.codex'));
  const mine = '# My rules\r\nBe brief.\n';
  writeFileSync(path, mine);
  assert.equal(keepInstructions({ action: 'inspect', harness: 'codex', home, env }).status, 'absent');
  const applied = keepInstructions({ action: 'apply', harness: 'codex', home, env });
  assert.deepEqual([applied.status, applied.previous, applied.changed, applied.path], ['present', 'absent', true, path]);
  assert.equal(readFileSync(path, 'utf8'), `${mine}\n${blockOf()}\n`);
  assert.equal(keepInstructions({ action: 'apply', harness: 'codex', home, env }).changed, false);
  assert.equal(keepInstructions({ action: 'inspect', harness: 'codex', home, env, text: 'Newer words.' }).status, 'outdated');
  keepInstructions({ action: 'apply', harness: 'codex', home, env, text: 'Newer words.' });
  assert.equal(readFileSync(path, 'utf8'), `${mine}\n${blockOf('Newer words.')}\n`);
  assert.equal(keepInstructions({ action: 'remove', harness: 'codex', home, env }).changed, true);
  assert.equal(readFileSync(path, 'utf8'), mine);
  assert.equal(keepInstructions({ action: 'remove', harness: 'codex', home, env }).changed, false);
});

test('a broken pair of markers is blocked and nothing is written', t => {
  const home = tempHome(t);
  const path = join(home, '.gemini', 'GEMINI.md');
  mkdirSync(join(home, '.gemini'));
  const broken = `${standing.markers.start}\nhalf\n`;
  writeFileSync(path, broken);
  const report = keepInstructions({ action: 'apply', harness: 'gemini-cli', home, env });
  assert.deepEqual([report.status, report.changed], ['blocked', false]);
  assert.equal(readFileSync(path, 'utf8'), broken);
  assert.equal(findBlock(`${standing.markers.end}\n${standing.markers.start}`).state, 'broken');
});

test('the home variable moves the file; a symbolic link is written through to its target; a new file starts with only the block', t => {
  const home = tempHome(t);
  const moved = join(home, 'elsewhere');
  assert.equal(instructionPath(harnessRow('claude-code'), { home, env: { CLAUDE_CONFIG_DIR: moved } }), join(moved, 'CLAUDE.md'));
  keepInstructions({ action: 'apply', harness: 'claude-code', home, env: { CLAUDE_CONFIG_DIR: moved } });
  assert.equal(readFileSync(join(moved, 'CLAUDE.md'), 'utf8'), `${blockOf()}\n`);
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, 'real.md'), 'mine\n');
  symlinkSync(join(home, 'real.md'), join(home, '.codex', 'AGENTS.md'));
  keepInstructions({ action: 'apply', harness: 'codex', home, env });
  assert.equal(readFileSync(join(home, 'real.md'), 'utf8'), `mine\n\n${blockOf()}\n`);
});

test('a hosted app with no file is answered with its own control and never written', () => {
  const report = keepInstructions({ action: 'apply', harness: 'chatgpt', home: '/nowhere', env });
  assert.deepEqual([report.kind, report.status, report.changed], ['host-control', 'use-host-control', false]);
  assert.match(report.reason, /Custom instructions/);
  assert.throws(() => keepInstructions({ action: 'apply', harness: 'nobody' }), /No harness/);
  assert.throws(() => keepInstructions({ action: 'wipe', harness: 'codex' }), /inspect, apply or remove/);
});

test('change is pure: every byte outside the block is kept', () => {
  const block = blockOf('x');
  const text = `a\n\n${block}\nb\n`;
  assert.equal(change(text, 'remove', block).next, 'a\n\nb\n');
  assert.equal(change('', 'apply', block).next, `${block}\n`);
  assert.equal(change('a\n\n', 'apply', block).next, `a\n\n${block}\n`);
});

test('the entry checks its input the way the Mac tool did and says where the text came from', t => {
  assert.ok(harnessIds().includes('codex'));
  const seen = [];
  const run = args => { seen.push(args); return { status: 'present' }; };
  assert.equal(keep({ harness: 'codex', action: 'apply' }, { run }).text_from, 'this tool');
  assert.equal(keep({ harness: 'codex', action: 'apply', text: 'Words.' }, { run }).text_from, 'caller');
  assert.deepEqual(seen.at(-1), { action: 'apply', harness: 'codex', text: 'Words.' });
  assert.throws(() => keep({ harness: 'codex', action: 'apply', home: '/x' }, { run }), /Name one supported harness/);
  const script = fileURLToPath(new URL('../do-work/keep-standing-instructions.mjs', import.meta.url));
  const home = tempHome(t);
  const out = JSON.parse(execFileSync('node', [script], { input: JSON.stringify({ harness: 'codex', action: 'inspect' }), env: { ...process.env, HOME: home, CODEX_HOME: '' }, encoding: 'utf8' }));
  assert.deepEqual([out.schema, out.report.status, out.report.file_exists], ['trillion.standing-instructions-result/v1', 'absent', false]);
  assert.equal(Object.hasOwn(out, 'result'), false, 'the direct CLI still emits its report without the Mac host envelope');
});

test('the native placement selects the report from the Mac host envelope', async () => {
  const tool = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records
    .map(record => record.payload).find(row => row.id === 'tool:keep-my-account-in-your-instructions');
  const binding = macTools.tools[tool.id];
  assert.equal(binding.workshop, 'tools/tell-ais-how-to-act/do-work/keep-standing-instructions.mjs');
  assert.equal(binding.function, 'keep');
  assert.equal(tool.invoke.kind, 'on-your-computer');
  const report = keep({ harness: 'chatgpt', action: 'inspect' });
  const raw = await runOnAgent({
    agents: {
      reach: () => ({ live: true }),
      handOff: () => ({ handoff: { handoff_id: 'fixture:standing-instructions' } }),
      read: () => ({ handoff: { state: 'finished', result: { result: report } } }),
    },
    placement: { settings: { agent_id: 'fixture:computer' } },
    tool, input: { harness: 'chatgpt', action: 'inspect' }, task: { task_id: 'fixture:inspect' },
  });
  assert.equal(tool.result_selector, '$.result');
  assert.deepEqual(selectDeclaredValue(raw, tool.result_selector), report);
  assert.equal(report.report.kind, 'host-control', 'this check changes no instruction file');
});

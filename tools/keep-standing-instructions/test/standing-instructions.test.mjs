// The block contract of tool:keep-trillion-in-your-instructions over a pretend harness folder: apply adds one marked
// block and touches nothing else, apply twice changes nothing, remove takes out only the block, damaged markers are
// left alone, a hosted app is answered with its control, and the row runs the export it names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockOf, change, findBlock, keep, keepInstructions, standing } from '../read-data/standing-instructions.mjs';
import * as tool from '../read-data/standing-instructions.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'standing-'));
const now = () => '2026-11-03T00:00:00.000Z';

test('apply writes one block into a missing file, inspect then says present, apply again changes nothing', () => {
  const dir = folder();
  const first = keep({ input: { harness: 'claude-code', action: 'apply' }, folder: dir }, { now });
  assert.equal(first.schema, 'trillion.standing-instructions-result/v1');
  assert.equal(first.text_from, 'this workshop');
  assert.equal(first.report.changed, true);
  assert.equal(first.report.previous, 'absent');
  assert.equal(first.report.path, join(dir, 'CLAUDE.md'));
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), `${blockOf()}\n`);
  assert.equal(keep({ input: { harness: 'claude-code', action: 'inspect' }, folder: dir }).report.status, 'present');
  const again = keep({ input: { harness: 'claude-code', action: 'apply' }, folder: dir });
  assert.equal(again.report.changed, false);
});

test('every byte outside the block stays as it was, through apply, update and remove', () => {
  const dir = folder();
  const path = join(dir, 'AGENTS.md');
  const mine = '# My rules\r\n\r\nKeep tabs.\tAlways.\n';
  writeFileSync(path, mine);
  keepInstructions({ action: 'apply', harness: 'codex', folder: dir });
  const applied = readFileSync(path, 'utf8');
  assert.ok(applied.startsWith(mine));
  assert.equal(keepInstructions({ action: 'inspect', harness: 'codex', folder: dir, text: 'Newer words.' }).status, 'outdated');
  keepInstructions({ action: 'apply', harness: 'codex', folder: dir, text: 'Newer words.' });
  assert.ok(readFileSync(path, 'utf8').includes('Newer words.'));
  assert.equal(findBlock(readFileSync(path, 'utf8')).state, 'found');
  const removed = keepInstructions({ action: 'remove', harness: 'codex', folder: dir });
  assert.equal(removed.changed, true);
  assert.equal(readFileSync(path, 'utf8'), mine);
});

test('remove on a file with no block changes nothing and never creates the file', () => {
  const dir = folder();
  const report = keepInstructions({ action: 'remove', harness: 'gemini-cli', folder: dir });
  assert.equal(report.changed, false);
  assert.equal(report.status, 'absent');
  assert.equal(existsSync(join(dir, 'GEMINI.md')), false);
});

test('damaged markers are reported and nothing is written', () => {
  const dir = folder();
  const path = join(dir, 'CLAUDE.md');
  const broken = `${standing.markers.start}\nhalf a block\n`;
  writeFileSync(path, broken);
  const report = keepInstructions({ action: 'apply', harness: 'claude-code', folder: dir });
  assert.equal(report.status, 'blocked');
  assert.equal(report.changed, false);
  assert.equal(readFileSync(path, 'utf8'), broken);
  assert.equal(change(`${standing.markers.end}\n${standing.markers.start}\n`, 'apply').state, 'broken');
});

test('a hosted app is answered with its own control and nothing is written; it needs no folder', () => {
  const report = keep({ input: { harness: 'chatgpt', action: 'apply' } }).report;
  assert.equal(report.status, 'use-host-control');
  assert.equal(report.kind, 'host-control');
  assert.match(report.reason, /ChatGPT/);
  assert.equal(report.text, standing.text);
});

test('the input names only a supported harness and an action; a file harness needs the granted folder', () => {
  assert.throws(() => keep({ input: { harness: 'claude-code', action: 'apply', path: '/etc' }, folder: folder() }), /supported harness/);
  assert.throws(() => keep({ input: { harness: 'someone-else', action: 'apply' }, folder: folder() }), /supported harness/);
  assert.throws(() => keep({ input: { harness: 'codex', action: 'erase' }, folder: folder() }), /supported harness/);
  assert.throws(() => keep({ input: { harness: 'codex', action: 'apply' } }), /Grant this tool Codex's own folder/);
  assert.throws(() => keep({ input: { harness: 'codex', action: 'apply' }, folder: 'relative/folder' }), /Grant/);
});

test('the row runs keep with the input and the granted folder, and offers every harness the settings name', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
  const payload = rows.records[0].payload;
  assert.equal(payload.id, 'tool:keep-trillion-in-your-instructions');
  assert.equal(payload.invoke.kind, 'computer');
  assert.deepEqual(payload.invoke.capabilities, ['change-a-folder']);
  assert.equal(typeof tool[payload.invoke.argv.at(-1)], 'function');
  assert.deepEqual(payload.invoke.stdin.folder, { fill: { from: 'task', field: 'grants.change-a-folder.folder' } });
  assert.deepEqual(payload.input_schema.properties.harness.enum, standing.harnesses.map(row => row.id));
});

// Every program a look or a read starts on this computer is a row of computer/computer-sources.json `programs`, by the
// job it does; the code names none. Stand-in programs (small shell scripts in a temporary folder) answer the rows here,
// so what runs is exactly what the rows say, on any computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openAddress, programIsHere, programRun, factsOf} from '../computer/computer-sources.mjs';
import {makeCopy, makePreview} from '../computer/read-new-items.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.join(HERE, '..', 'computer');
const rows = JSON.parse(fs.readFileSync(path.join(CODE, 'computer-sources.json'), 'utf8'));

const standIn = (folder, name, script) => {
  const file = path.join(folder, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, {mode: 0o755});
  return file;
};

test('no code file of the reader or the finder names a program; every job the code asks for is a row', () => {
  for (const name of ['computer-sources.mjs', 'read-new-items.mjs', 'own-writes.mjs']) {
    const code = fs.readFileSync(path.join(CODE, name), 'utf8');
    assert.doesNotMatch(code, /['"`]\/(?:usr\/)?s?bin\//, `${name} names a program by its path`);
    // A program is started only from a row's run (or this runtime itself, for a reader's child): never a name in code.
    assert.doesNotMatch(code, /\b(?:execFile|execFileSync|spawn|spawnSync|execSync|exec)\(\s*['"`]/, `${name} starts a program it names`);
    for (const [, job] of code.matchAll(/(?:programRun|run)\('([a-z_]+)'/g)) assert.ok(Array.isArray(rows.programs[job]), `${name} asks for ${job}, which programs has no row for`);
  }
});

test('the first try whose program is here runs, with its holes filled; no try here is null; a job with no row throws', () => {
  const programs = {picture_preview: [{run: ['/no/such/program', '{picture}']}, {run: ['/bin/sh', '-c', 'x', '{px}', '{picture}', '{out}', '{left}']}]};
  assert.deepEqual(programRun('picture_preview', {px: '64', picture: 'a.png', out: 'b.jpg'}, {programs}), {argv: ['/bin/sh', '-c', 'x', '64', 'a.png', 'b.jpg', '{left}'], reads: null});
  assert.equal(programRun('picture_preview', {}, {programs, here: () => false}), null);
  assert.throws(() => programRun('picture_rotate', {}, {programs}), /programs names no picture_rotate/);
  assert.equal(programIsHere('sh', {env: {PATH: '/bin:/usr/bin'}}), true);
  assert.equal(programIsHere('no-such-program-anywhere', {env: {PATH: '/bin:/usr/bin'}}), false);
});

test('a preview and a copy are made by the programs their rows name, the copy shrunk only when a side is longer than its edge', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'programs-are-rows-'));
  try {
    const asked = [];
    const write = standIn(folder, 'write-out', 'for last; do :; done; printf jpg > "$last"');
    const sides = standIn(folder, 'sides', 'printf "pixelWidth: 1200\\npixelHeight: 800\\n"');
    const programs = {
      picture_preview: [{run: [write, '{px}', '{picture}', '{out}']}],
      picture_sides: [{run: [sides, '{picture}'], reads: rows.programs.picture_sides[0].reads}],
      picture_copy: [{run: [write, 'whole', '{picture}', '{out}']}],
      picture_copy_shrunk: [{run: [write, '{edge}', '{picture}', '{out}']}],
    };
    const run = (job, values) => { asked.push(job); return programRun(job, values, {programs}); };
    const preview = await makePreview('/pictures/shot.png', 256, path.join(folder, 'work'), {run});
    assert.equal(path.basename(preview), 'shot preview.jpg');
    assert.equal(fs.readFileSync(preview, 'utf8'), 'jpg');
    assert.ok(await makeCopy('/pictures/big.png', 1000, path.join(folder, 'work'), {run}));
    assert.ok(await makeCopy('/pictures/small.png', 2000, path.join(folder, 'work'), {run}));
    assert.deepEqual(asked, ['picture_preview', 'picture_sides', 'picture_copy_shrunk', 'picture_sides', 'picture_copy']);
    // No program here: no preview, no copy, nothing started.
    const none = () => null;
    assert.equal(await makePreview('/pictures/shot.png', 256, path.join(folder, 'work'), {run: none}), null);
    assert.equal(await makeCopy('/pictures/shot.png', 256, path.join(folder, 'work'), {run: none}), null);
  } finally { fs.rmSync(folder, {recursive: true, force: true}); }
});

test('a pane is opened by the open_address row; with no such program here nothing is started', () => {
  const started = [];
  const start = (program, argv) => started.push([program, ...argv]);
  assert.equal(openAddress('x-settings:pane', {run: (job, values) => programRun(job, values, {programs: {open_address: [{run: ['/bin/sh', '{target}']}]}}), start}), true);
  assert.deepEqual(started, [['/bin/sh', 'x-settings:pane']]);
  assert.equal(openAddress('x-settings:pane', {run: () => null, start}), false);
  assert.equal(started.length, 1);
  assert.deepEqual(rows.programs.open_address[0].run.slice(-1), ['{target}']);
});

test('what an app says about itself is read by the app_facts row, and an app is still found when no such program is here', () => {
  assert.deepEqual(factsOf('/Applications/Some.app', {file: 'Contents/Info.plist', keys: {version: 'V'}}, () => ({V: '2.1'})), {path: '/Applications/Some.app', version: '2.1'});
  assert.deepEqual(factsOf('/Applications/Some.app', {file: 'Contents/Info.plist', keys: {version: 'V'}}, () => { throw new Error('no program'); }), {path: '/Applications/Some.app', version: null});
  assert.ok(rows.programs.app_facts[0].run.includes('{file}'));
});

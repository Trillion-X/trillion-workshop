// tools/start-a-computer/test/place-a-prebuilt-program.test.mjs
//
// A unit whose source names `prebuilt` (the BLAKE3 of a program built elsewhere) is placed, never built: the bytes come from the
// store of the computer running the apply, are checked against the row's BLAKE3 there and against their sha256 on the computer,
// and `current` moves to them. Bytes already placed are not sent again; a store without the file, or with other bytes under
// that name, is refused before anything reaches the computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { buildOnTheComputer, sourceOf } from '../do-work/start-a-computer.mjs';

const store = mkdtempSync(join(tmpdir(), 'prebuilt-store-'));
const program = Buffer.from('a program built elsewhere\n');
const name = Buffer.from(blake3(program)).toString('hex');
writeFileSync(join(store, name), program);
const sha256 = createHash('sha256').update(program).digest('hex');
const commit = 'c'.repeat(40);
const unit = { unit: 'engine-b.service', user: 'engine', builds: '/srv/engine/builds', program: 'engine', current: 'current-b', source: { commit, prebuilt: { blake3: name } } };

// A made-up computer: it holds files by path and answers the three commands placing uses.
function computer(files = new Map()) {
  const said = [];
  const run = async (_machine, command, input) => {
    said.push({ command, input });
    const path = `${unit.builds}/${commit}/${unit.program}`;
    if (command.includes('|| exit 3')) {
      const held = files.get(path);
      if (held && createHash('sha256').update(held).digest('hex') === sha256) return '';
      throw Object.assign(new Error('absent'), { code: 3 });
    }
    if (command.includes('cat >')) { files.set(path, Buffer.from(input)); return ''; }
    if (command.includes('ln -sfn')) { files.set(`${unit.builds}/${unit.current}`, commit); return ''; }
    throw new Error(`unexpected ${command}`);
  };
  return { run, said, files };
}

test('a prebuilt program needs no repository, build or output, and is read with its BLAKE3', () => {
  assert.deepEqual(sourceOf(unit), { user: 'engine', builds: '/srv/engine/builds', commit, program: 'engine', current: 'current-b', prebuilt: name });
  assert.throws(() => sourceOf({ ...unit, source: { commit, prebuilt: { blake3: 'abc' } } }), /64 hex digits/);
});

test('its bytes are sent once, checked, and current moves to them; a second apply sends nothing', async () => {
  const machine = computer();
  assert.equal(await buildOnTheComputer({}, unit, {}, machine.run, store), commit);
  const sent = machine.said.find(({ command }) => command.includes('cat >'));
  assert.ok(sent && Buffer.compare(Buffer.from(sent.input), program) === 0, 'the program travels on standard input');
  assert.match(sent.command, new RegExp(sha256), 'and is kept only when its sha256 there is the sent bytes\'');
  assert.equal(machine.files.get(`${unit.builds}/${unit.current}`), commit);
  const again = computer(machine.files);
  await buildOnTheComputer({}, unit, {}, again.run, store);
  assert.equal(again.said.some(({ command }) => command.includes('cat >')), false, 'already placed: nothing sent');
  assert.equal(again.said.some(({ command }) => command.includes('ln -sfn')), true, 'only made current');
});

test('a store without the file, or with other bytes under its name, is refused before anything reaches the computer', async () => {
  const machine = computer();
  const other = '0'.repeat(64);
  await assert.rejects(buildOnTheComputer({}, { ...unit, source: { commit, prebuilt: { blake3: other } } }, {}, machine.run, store), /has no such file/);
  writeFileSync(join(store, other), 'not those bytes');
  await assert.rejects(buildOnTheComputer({}, { ...unit, source: { commit, prebuilt: { blake3: other } } }, {}, machine.run, store), /not the row's/);
  assert.equal(machine.said.length, 0);
});

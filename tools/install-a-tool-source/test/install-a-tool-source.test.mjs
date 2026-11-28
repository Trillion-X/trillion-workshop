// tools/install-a-tool-source/test/install-a-tool-source.test.mjs
//
// A tool source the person's row names is installed at the run's door through tools:update at the Workshop's address,
// under a request key made from its label and pin; a removed row takes it away; a call that names no label, no https
// archive or no 64-hex pin is refused before the door is called. The records door sends an operation to the address it
// names (`at`), else to its own. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installToolSource, problemOf } from '../do-work/install-a-tool-source.mjs';
import { recordsDoorFromCall } from '../../records-door/read-data/records-door.mjs';

const PIN = 'b'.repeat(64);

function fakeDoor(answer = { changed: true, files_blake3: PIN, previous: null }) {
  const sent = [];
  const door = recordsDoorFromCall(async (method, input, key, address) => {
    sent.push({ method, input, key, address });
    return answer;
  }, { resource: '@own-records' });
  return { door, sent };
}

test('a source a row names is installed at the Workshop address, keyed by its label and pin', async () => {
  const { door, sent } = fakeDoor();
  const answer = await installToolSource({ computer: 'computer-zero', source: 'team-tools', address: 'https://archive.example.test/team/tools.tar.gz', files_blake3: PIN }, { door });
  assert.deepEqual(answer, { computer: 'computer-zero', source: 'team-tools', changed: true, files_blake3: PIN, previous: null });
  assert.deepEqual(sent, [{ method: 'tools:update', address: '@tools', key: `install-a-tool-source:computer-zero:team-tools:${PIN}`,
    input: { source: 'team-tools', address: 'https://archive.example.test/team/tools.tar.gz', files_blake3: PIN } }]);
});

test('a removed row takes the source away', async () => {
  const { door, sent } = fakeDoor({ removed: true, changed: true, previous: PIN });
  const answer = await installToolSource({ computer: 'computer-zero', source: 'team-tools', removed: true }, { door });
  assert.equal(answer.removed, true);
  assert.deepEqual(sent[0].input, { source: 'team-tools', removed: true });
  assert.equal(sent[0].key, 'install-a-tool-source:computer-zero:team-tools:removed');
  // As a removed row's change gives it: the archive's fields are null.
  await installToolSource({ computer: 'computer-zero', source: 'team-tools', address: null, files_blake3: null, removed: true }, { door });
  assert.deepEqual(sent[1].input, { source: 'team-tools', removed: true });
  // An added or changed row says removed false or null: an install.
  await installToolSource({ computer: 'computer-zero', source: 'team-tools', address: 'https://archive.example.test/t.tar.gz', files_blake3: PIN, removed: null }, { door });
  assert.equal(sent[2].input.files_blake3, PIN);
});

test('a call that is not one source is refused before the door is called', async () => {
  const { door, sent } = fakeDoor();
  for (const input of [null, {}, { source: 'Team/Tools', address: 'https://a.example.test/t.tar.gz', files_blake3: PIN },
    { source: 'team', address: 'http://a.example.test/t.tar.gz', files_blake3: PIN }, { source: 'team', address: 'https://a.example.test/t.tar.gz', files_blake3: 'main' },
    { source: 'team', removed: true, address: 'https://a.example.test/t.tar.gz' }]) {
    assert.ok(problemOf(input), JSON.stringify(input));
    await assert.rejects(installToolSource(input, { door }));
  }
  assert.equal(sent.length, 0, 'nothing was sent');
});

test('while the engine is installing already, the same call is asked again after a wait, a bounded number of times', async () => {
  const sent = [], waits = [];
  let busy = 2;
  const door = recordsDoorFromCall(async (method, input, key) => {
    sent.push(key);
    if (busy-- > 0) throw Object.assign(new Error('busy'), { code: 'tools_run_in_progress' });
    return { changed: false, files_blake3: PIN };
  }, { resource: '@own-records' });
  const tries = { busy_code: 'tools_run_in_progress', first_wait_ms: 5, factor: 2, most_tries: 4 };
  const input = { computer: 'computer-zero', source: 'workshop', address: 'https://archive.example.test/w.tar.gz', files_blake3: PIN };
  const answer = await installToolSource(input, { door, wait: async ms => waits.push(ms), tries });
  assert.equal(answer.changed, false);
  assert.deepEqual(waits, [5, 10], 'each wait grows');
  assert.equal(new Set(sent).size, 1, 'every ask is the same call under the same key');
  busy = 10;
  await assert.rejects(installToolSource(input, { door, wait: async () => {}, tries }), /busy/, 'after most_tries the refusal is the answer');
  const other = recordsDoorFromCall(async () => { throw Object.assign(new Error('refused'), { code: 'tools_update_refused' }); }, { resource: '@own-records' });
  await assert.rejects(installToolSource(input, { door: other, wait: async () => assert.fail('no wait for another refusal'), tries }), /refused/);
});

test('a records door operation goes to the address it names, else to its own', async () => {
  const { door, sent } = fakeDoor({});
  await door.operation('wake:arrive', { kind: 'k' });
  await door.operation('tools:update', { source: 's', removed: true }, { at: door.toolsAddress });
  assert.deepEqual(sent.map(call => call.address), ['@own-records', '@tools']);
});

test('a call or a row that names no computer installs nowhere: it is refused before the door is called', async () => {
  // Nov 28 2026: the keeper ran on one computer for a default tool_sources row (computer null) meant for another, and
  // moved a computer that had to stay put. A call must name the one computer it is for, and that name is part of its request key.
  const { door, sent } = fakeDoor();
  const archive = { source: 'workshop', address: 'https://archive.example.test/w.tar.gz', files_blake3: PIN };
  for (const computer of [undefined, null, '', 'Two Words', 'a/b', 7]) {
    const input = computer === undefined ? archive : { ...archive, computer };
    assert.match(problemOf(input), /computer/, JSON.stringify(input));
    await assert.rejects(installToolSource(input, { door }), /computer/);
  }
  assert.equal(sent.length, 0, 'nothing was sent');
  await installToolSource({ ...archive, computer: 'computer-one' }, { door });
  await installToolSource({ ...archive, computer: 'computer-two' }, { door });
  assert.deepEqual(sent.map(call => call.key), [`install-a-tool-source:computer-one:workshop:${PIN}`,
    `install-a-tool-source:computer-two:workshop:${PIN}`], 'one row told for two computers is two installs');
});

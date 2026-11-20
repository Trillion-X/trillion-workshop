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
  const answer = await installToolSource({ source: 'team-tools', address: 'https://archive.example.test/team/tools.tar.gz', files_blake3: PIN }, { door });
  assert.deepEqual(answer, { source: 'team-tools', changed: true, files_blake3: PIN, previous: null });
  assert.deepEqual(sent, [{ method: 'tools:update', address: '@tools', key: `install-a-tool-source:team-tools:${PIN}`,
    input: { source: 'team-tools', address: 'https://archive.example.test/team/tools.tar.gz', files_blake3: PIN } }]);
});

test('a removed row takes the source away', async () => {
  const { door, sent } = fakeDoor({ removed: true, changed: true, previous: PIN });
  const answer = await installToolSource({ source: 'team-tools', removed: true }, { door });
  assert.equal(answer.removed, true);
  assert.deepEqual(sent[0].input, { source: 'team-tools', removed: true });
  assert.equal(sent[0].key, 'install-a-tool-source:team-tools:removed');
  // As a removed row's change gives it: the archive's fields are null.
  await installToolSource({ source: 'team-tools', address: null, files_blake3: null, removed: true }, { door });
  assert.deepEqual(sent[1].input, { source: 'team-tools', removed: true });
  // An added or changed row says removed false or null: an install.
  await installToolSource({ source: 'team-tools', address: 'https://archive.example.test/t.tar.gz', files_blake3: PIN, removed: null }, { door });
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

test('a records door operation goes to the address it names, else to its own', async () => {
  const { door, sent } = fakeDoor({});
  await door.operation('wake:arrive', { kind: 'k' });
  await door.operation('tools:update', { source: 's', removed: true }, { at: door.toolsAddress });
  assert.deepEqual(sent.map(call => call.address), ['@own-records', '@tools']);
});

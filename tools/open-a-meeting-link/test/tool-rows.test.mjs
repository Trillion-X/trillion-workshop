import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as links from '../read-data/meeting-links.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

test('reading a link needs no capability; opening one names the one it needs, and each row runs an export that exists', () => {
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.deepEqual(byId['tool:read-meeting-link'].invoke.capabilities, []);
  assert.deepEqual(byId['tool:open-meeting-link'].invoke.capabilities, ['open-links-in-their-apps']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.equal(row.invoke.internet, false);
    assert.equal(typeof links[row.invoke.argv.at(-1)], 'function', row.id);
  }
});

test('the read export never answers a secret parameter value', async () => {
  const answer = await links.read({ link: 'zoommtg://zoom.us/join?confno=123456789&pwd=sample-secret' });
  assert.equal(JSON.stringify(answer).includes('sample-secret'), false);
});

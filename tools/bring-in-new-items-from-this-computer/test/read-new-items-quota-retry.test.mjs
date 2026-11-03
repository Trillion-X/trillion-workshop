// test/read-new-items-quota-retry.test.mjs
//
// A 409 naming the account's own quota is the account's trouble of the moment: the item waits on the short doubling wait of
// item_trouble and is sent again, while a final refusal still waits its hour (read-new-items.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readNewItems} from '../computer/read-new-items.mjs';

test('an item answered with a quota 409 is asked again after the short wait and then lands once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-retry-'));
  const stateFile = path.join(dir, 'state.json');
  const item = {source_id: 'photo', title: 'Photo', text: 'a photo', at: '2026-10-21T10:00:00.000Z'};
  let clock = '2026-10-21T11:00:00Z';
  const answers = [{status: 409, body: {error: 'Resource quota: measurement_or_receipt_uncertain'}}, {status: 200, body: {message_id: 'm', arrival_id: 'arrival:photo'}}];
  const asked = [];
  const carrier = readNewItems({carriers: [{route: 'Photos', reader: 'photos-stand-in', store: dir, settle_seconds: 0}], stateFile, keep: async () => {},
    readers: {'photos-stand-in': async () => [{...item}]}, now: () => new Date(clock),
    account: async (route, {body}) => { asked.push(body.source_id); return answers.shift() ?? assert.fail('asked more than twice'); }});
  await carrier.tick();
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.Photos.since = '2026-10-21T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await carrier.tick();
  assert.deepEqual(asked, ['photo'], 'inside its short wait it is not asked again');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).Photos.refused ?? {}), [], 'it is not recorded as turned away');
  clock = '2026-10-21T11:30:00Z';
  await carrier.tick();
  assert.deepEqual(asked, ['photo', 'photo'], 'long before an hour, it is asked again');
  assert.equal(carrier.status()[0].last_sent.arrival_id, 'arrival:photo');
  clock = '2026-10-21T13:00:00Z';
  await carrier.tick();
  assert.deepEqual(asked, ['photo', 'photo'], 'once sent it is not sent again');
});

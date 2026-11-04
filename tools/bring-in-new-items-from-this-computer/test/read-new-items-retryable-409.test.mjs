// test/read-new-items-retryable-409.test.mjs
//
// A 409 the account calls retryable waits on item_trouble's short doubling wait, and a 409 that is a final refusal waits the hour
// (turned_away.ask_again_minutes), so a retryable answer is not parked behind a refusal's hour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readNewItems} from '../computer/read-new-items.mjs';

const run = async body => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retryable-409-'));
  const stateFile = path.join(dir, 'state.json');
  let clock = '2026-10-21T11:00:00Z';
  const asked = [];
  const carrier = readNewItems({carriers: [{route: 'Photos', reader: 'photos-stand-in', store: dir, settle_seconds: 0}], stateFile, keep: async () => {},
    readers: {'photos-stand-in': async () => [{source_id: 'photo', title: 'Photo', text: 'a photo', at: '2026-10-21T10:00:00.000Z'}]}, now: () => new Date(clock),
    account: async () => { asked.push(clock); return asked.length === 1 ? {status: 409, body} : {status: 200, body: {message_id: 'm', arrival_id: 'arrival:photo'}}; }});
  await carrier.tick();
  const rewind = () => { const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); state.Photos.since = '2026-10-21T00:00:00.000Z'; fs.writeFileSync(stateFile, JSON.stringify(state)); };
  rewind();
  clock = '2026-10-21T11:30:00Z';
  await carrier.tick();
  return {asked, carrier};
};

test('a 409 the account marks retryable is asked again long before an hour', async () => {
  const {asked, carrier} = await run({error: 'The book is busy settling earlier work', retryable: true});
  assert.equal(asked.length, 2);
  assert.equal(carrier.status()[0].last_sent.arrival_id, 'arrival:photo');
});

test('a 409 that is a final refusal waits the hour', async () => {
  const {asked} = await run({error: 'This item cannot be taken', retryable: false});
  assert.equal(asked.length, 1, 'a final refusal is not asked again after half an hour');
});

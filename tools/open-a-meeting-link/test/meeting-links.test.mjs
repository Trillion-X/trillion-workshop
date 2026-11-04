// Meeting links through declared routes (read-data/meeting-links.mjs, DATA in read-data/meeting-links.json).
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRoster, linkTools, linkSettings, readLink } from '../read-data/meeting-links.mjs';

const settings = linkSettings();

test('a join link is read through its route: host first, only the action parameters, secrets marked and hidden in the log form', () => {
  const read = readLink('zoommtg://us02web.zoom.us/join?confno=123456789&pwd=abc123&uname=Ana&utm=x&unknown=1', settings);
  assert.deepEqual(read.params, { confno: '123456789', pwd: 'abc123', uname: 'Ana' });
  assert.deepEqual(read.secret_params, ['pwd']);
  assert.equal(read.redacted, 'zoommtg://us02web.zoom.us/join?confno=123456789&pwd=***&uname=Ana');
  assert.equal(readLink('https://zoom.us/start?confno=987654321', settings).action, 'start');
  assert.equal(readLink('zoomus://zoom.us/schedule?topic=Review', settings).params.topic, 'Review');
});

test('an unlisted host, an unknown action, a missing needed parameter and a malformed one are each refused with their own reason', () => {
  assert.throws(() => readLink('https://zoom.us.evil.example/join?confno=123456789', settings), /host zoom\.us\.evil\.example is not one/);
  assert.throws(() => readLink('zoommtg://evil.example/join?confno=123456789', settings), /not one this meeting app reads/);
  assert.throws(() => readLink('https://zoom.us/delete?confno=123456789', settings), /no action this meeting app knows \(delete\)/);
  assert.throws(() => readLink('https://zoom.us/join', settings), /missing confno/);
  assert.throws(() => readLink('https://zoom.us/join?confno=12ab', settings), /confno in the link is not in the form/);
  assert.throws(() => readLink('ftp://zoom.us/join?confno=123456789', settings), /reads a ftp link/);
  assert.throws(() => readLink('not a link', settings), /not a link/);
});

test('another meeting app is one more row, and the tool never returns a secret parameter value', async () => {
  const other = { ...settings, routes: [...settings.routes, { id: 'other', schemes: ['https'], hosts: ['^meet\\.example\\.org$'], action_from: 'query', actions: { join: { params: ['room'], needs: ['room'] } }, params: { room: { match: '^[a-z-]+$' } } }] };
  assert.deepEqual(readLink('https://meet.example.org/?action=join&room=daily-sync', other).params, { room: 'daily-sync' });
  const answer = await linkTools.read({ link: 'zoommtg://zoom.us/join?confno=123456789&pwd=hunter2' });
  assert.equal(JSON.stringify(answer).includes('hunter2'), false);
  assert.deepEqual(answer.secret_params, ['pwd']);
  console.log('REAL readback of the tool answer:', JSON.stringify(answer));
});

test('a roster is replaced by a full update and adjusted by an incremental one', () => {
  let roster = applyRoster({}, { mode: 'full', attendees: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Ben' }] });
  roster = applyRoster(roster, { mode: 'incremental', attendees: [{ id: 'b', muted: true }, { id: 'c', name: 'Cho' }], removed: ['a'] });
  assert.deepEqual(roster, { b: { id: 'b', name: 'Ben', muted: true }, c: { id: 'c', name: 'Cho' } });
  assert.deepEqual(applyRoster(roster, { mode: 'full', attendees: [] }), {});
});

test('opening a link reads it first: a refused link is never handed to the system, an allowed one is, and the answer hides secrets', async () => {
  const opened = [];
  await assert.rejects(linkTools.open({ link: 'https://zoom.us.evil.example/join?confno=123456789' }, { open: async link => opened.push(link) }), /not one this meeting app reads/);
  assert.deepEqual(opened, []);
  const answer = await linkTools.open({ link: 'zoommtg://zoom.us/join?confno=123456789&pwd=hunter2' }, { open: async link => opened.push(link) });
  assert.equal(opened.length, 1);
  assert.equal(JSON.stringify(answer).includes('hunter2'), false);
});

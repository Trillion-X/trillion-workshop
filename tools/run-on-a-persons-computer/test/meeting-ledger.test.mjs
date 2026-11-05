// What the listener says about a listening (computer/meeting-ledger.mjs), read through the listen tool of computer/listen.mjs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listeningTools, rowOf } from '../listen.mjs';
import { isFalseText, jobState, livenessOf } from '../meeting-ledger.mjs';

const rows = JSON.parse(readFileSync(new URL(import.meta.resolve('../../bring-in-new-items-from-this-computer/computer/computer-sources.json')), 'utf8'));
const shipped = rowOf(rows).listen;
const withHome = async work => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const before = process.env.HOME;
  process.env.HOME = home;
  try { return await work(home, { ...shipped, state: path.join(home, '.trillion', 'listening') }); } finally { process.env.HOME = before; }
};

test('a line that is only text a hearing model makes up out of silence is told apart from real words', () => {
  assert.equal(isFalseText('Thank you for watching!'), true);
  assert.equal(isFalseText('We thank you for watching the demo carefully, Ben said.'), false);
});

test('a listening whose heartbeat is old reads as finished without anything being rewritten, and the notes job tells its state in words', () => withHome(async (_, listen) => {
  assert.deepEqual(livenessOf({ listening: true, heartbeat_ms: 1000 }, 300_000), { live: false, why: 'stale', age_ms: 299_000 });
  assert.equal(livenessOf({ listening: true, heartbeat_ms: 99_000 }, 100_000).live, true);
  assert.equal(livenessOf({ listening: false, heartbeat_ms: 99_000 }, 100_000).live, false);
  const state = listen.state;
  mkdirSync(state, { recursive: true });
  const status = path.join(state, 'status.json');
  const old = JSON.stringify({ listening: true, heartbeat_ms: Date.now() - 600_000, notes: jobState('failed', 'no model answered') });
  writeFileSync(status, old);
  const answer = await listeningTools.listen({});
  assert.deepEqual([answer.live.live, answer.status.listening, answer.notes.says], [false, true, 'The notes could not be made: no model answered']);
  assert.equal(readFileSync(status, 'utf8'), old);
  assert.deepEqual(jobState('noted').controls, ['ask_again', 'propose_tasks']);
}));

test('the notes job tells its state while it works, proposes the action items it found as tasks to review, and says why when it fails', async () => {
  const { notesMaker } = await import('../listen.mjs');
  const states = [];
  const status = {};
  const proposed = [];
  const answer = { choices: [{ message: { content: JSON.stringify({ summary: [{ text: 'Shipping Friday.', from: [1] }], decisions: [], actions: [{ text: 'Send the deck', owner: 'Ana', due: '2026-10-23', from: [1] }] }) } }], model: 'm' };
  const lines = [{ text: 'We should ship the new listening build on Friday if the tests pass and Ana will send the deck before the demo to everyone who joined, and then we will all meet again on Monday morning to look at how the demo went and what the customers said.', speaker: 'Ana', source_id: 'moment-9#1' }];
  const make = (ask, call) => notesMaker({ settings: shipped, status, report: () => states.push(status.notes.state), log: () => {}, ask, call });
  const made = await make(async () => answer, async (tool, input) => { proposed.push([tool, input]); return {}; })(lines);
  assert.equal(made.kind, 'notes');
  assert.deepEqual(states, ['noting', 'noted']);
  assert.deepEqual(proposed, [['propose_tasks', { source_id: 'moment-9', proposed_by: 'Listening notes', items: [{ title: 'Send the deck', due: '2026-10-23', evidence: 'Ana: Send the deck' }] }]]);
  // A proposal that the account refuses never loses the notes.
  assert.equal((await make(async () => answer, async () => { throw new Error('no such tool'); })(lines)).kind, 'notes');
  await assert.rejects(make(async () => { throw new Error('model gone'); }, async () => ({}))(lines), /model gone/);
  assert.equal(status.notes.says, 'The notes could not be made: model gone');
});

test('a cut whose file went up but whose words did not is not uploaded again: its identity is saved the moment the upload is confirmed', async () => {
  const { sendCuts, soundKeeper } = await import('../listen.mjs');
  const state = mkdtempSync(path.join(os.tmpdir(), 'cuts-'));
  const folder = path.join(state, 'sound');
  const keeper = soundKeeper({ keep: { ...shipped.keep_sound, margin_seconds: 0 }, route: 'Listening', join: 2, state, device: 'Mac', encoder: null, words: shipped.words, send: async () => {}, sendMany: cuts => sendCuts(cuts, { upload, keepResults, save: cut => writeFileSync(`${cut.file}.json`, JSON.stringify(cut)) }) });
  const file = path.join(folder, 'm1.opus');
  writeFileSync(file, 'sound');
  writeFileSync(`${file}.json`, JSON.stringify({ file, name: 'Listening/day/m1', transcript: { words: 1 } }));
  const uploaded = [];
  let wordsFail = true;
  const upload = async cuts => { uploaded.push(...cuts.map(cut => cut.name)); return cuts.map(() => '1f:abc'); };
  const keepResults = async cuts => { if (wordsFail) throw new Error('the transcripts could not be kept (503)'); return cuts.map(cut => ({ kept: true, identity: cut.identity })); };
  assert.equal(await keeper.drain(), 1, 'the cut waits');
  assert.equal(JSON.parse(readFileSync(`${file}.json`, 'utf8')).identity, '1f:abc');
  wordsFail = false;
  assert.equal(await keeper.drain(), 0, 'the cut is kept');
  assert.deepEqual(uploaded, ['Listening/day/m1'], 'uploaded once, not twice');
  assert.equal(existsSync(file), false);
});

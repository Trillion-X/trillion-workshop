// test/decisions-since-held-line.test.mjs
//
// The hold is on the person, never on an AI (Jibran 2026-10-07: a Codex chat doing his Meta app review stopped, "I
// cannot record the permission demos, make the API calls, finish the connections, or submit while the hold is on",
// because the held line said "other work waits until it is done"). Every text that tells an AI about the hold tells
// the AI to keep doing all of its own work; none of it tells an AI to stop, wait or pause. And no hook tells a chat to
// paste the held thing (h_390a): Trillion itself reaches the person with it on every surface, a chat included, as a
// notice (src/waiting-on-you.json hold.devices).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settings, unseenDecisions } from '../harness/decisions-since.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// Words that would tell an AI its own work stops while a thing is held.
const STOPS = /other work waits|waits? until (it is|it's) done|(stop|pause|halt)\b[^.]*\b(work|working|your)|do not (work|continue|proceed)|work around it/i;
const KEEPS = /keep doing all of (your|its) own work/i;

// Every place the hold is told to an AI: the MCP instructions, the hold tool and the counter.
const told = () => {
  const instructions = read('src/server-instructions.json');
  const tool = JSON.parse(read('records/workshop-account-tool-records.json'));
  const description = JSON.stringify(tool).match(/"description":"op read \(the default\)[^"]*"/)?.[0] ?? '';
  const counter = JSON.parse(read('src/escape-chain.json')).rows.find(row => row.id === 'ask-an-ai-instead').counter;
  const sentence = instructions.match(/One thing at a time for the person:[^"]*/)?.[0] ?? '';
  return { instructions: sentence, tool: description, counter };
};

test('the prompt hook never prints a line telling the chat to paste the held thing; it arrives as a notice', async () => {
  assert.equal('held_line' in settings, false);
  const held = { key: 'asks:meta', title: 'Sign in to Facebook once and allow Trillion' };
  const notice = { said: 'Your AI opened something for you to do: Sign in to Facebook once and allow Trillion' };
  const answer = notices => async () => ({ ok: true, json: async () => ({ notices, held }) });
  const person = { session_id: 's1', prompt: 'fix the build' };
  assert.equal(await unseenDecisions(person, { key: async () => 'k', fetchImpl: answer([]) }), '', 'a held thing alone prints nothing');
  const said = await unseenDecisions(person, { key: async () => 'k', fetchImpl: answer([notice]) });
  assert.match(said, /Sign in to Facebook once and allow Trillion/);
  assert.doesNotMatch(said, /tool:take-me-there|Open your reply|Held for the person/);
});

test('nothing that tells an AI about the hold tells it to stop, wait or pause its own work', () => {
  for (const [where, words] of Object.entries(told())) {
    assert.ok(words, `${where} says something about the hold`);
    assert.doesNotMatch(words, STOPS, `${where} never tells an AI to stop: ${words}`);
  }
  for (const where of ['instructions', 'tool']) assert.match(told()[where], /own work/, `${where} says the AI keeps doing its own work`);
});

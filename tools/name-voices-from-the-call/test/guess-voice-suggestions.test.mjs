// test/guess-voice-suggestions.test.mjs
// The producer behind the Waiting on you voice card (do-work/guess-voice-suggestions.mjs): the same DATA rules as
// test/voice-guesses.test.mjs, run through the command the container runs, with the evidence handed in as data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import waiting from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };
import { guessVoiceSuggestions } from '../do-work/guess-voice-suggestions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const section = waiting.sources.voices;
const people = [
  { id: 'sofus-hansen', list_id: 'friends', row_type: 'contact', title: 'Sofus Hansen' },
  { id: 'dana-wu', list_id: 'friends', row_type: 'contact', title: 'Dana Wu' },
];
const at = minutes => new Date(Date.parse('2026-10-09T10:00:00Z') + minutes * 60_000).toISOString();
const voice = (n, extra = {}) => ({ id: `listen:Someone (voice-${n})@${at(n)}`, app: 'listen', speaker: `Someone (voice-${n})`, turns: 2,
  since: at(n * 10), until: at(n * 10 + 4), last_at: at(n * 10 + 4), last_words: 'Could you send the notes tonight please', conversation_id: 'c-1', ...extra });
const base = { rules: section.guess, pattern: section.guess_pattern, people, owner: 'Riley Stone', owner_words: ['Thanks, I will send the notes tonight.'] };

test('a calendar event that names a person at that time ranks that person first, with the reason', async () => {
  const answer = await guessVoiceSuggestions({ ...base, voices: [voice(1)], calendar_items: [{ title: 'Call with Sofus', starts_at: at(5), ends_at: at(35), all_day: false }] });
  const [first] = answer.voices;
  assert.equal(first.suggestions[0].id, 'sofus-hansen');
  assert.equal(first.suggestions[0].list_id, 'friends');
  assert.match(first.suggestions[0].why, /Call with Sofus/);
});

test('a listener guess that matches a row is offered as that row; no match is kept as plain words', async () => {
  const answer = await guessVoiceSuggestions({ ...base, voices: [voice(1, { speaker: 'Unsure (Dana?)' }), voice(2, { speaker: 'Unsure (Mx Zed?)' })] });
  const byLabel = new Map(answer.voices.map(row => [row.speaker, row]));
  assert.equal(byLabel.get('Unsure (Dana?)').suggestions[0].id, 'dana-wu');
  assert.equal(byLabel.get('Unsure (Mx Zed?)').suggestions[0].id, undefined);
  assert.equal(byLabel.get('Unsure (Mx Zed?)').suggestions[0].title, 'Mx Zed');
});

test('a voice whose best evidence is the owner\'s own row is left out as the owner\'s own voice, and never offered', async () => {
  const withOwner = [...people, { id: 'riley-stone', list_id: 'friends', row_type: 'contact', title: 'Riley Stone' }];
  const answer = await guessVoiceSuggestions({ ...base, people: withOwner, voices: [voice(1, { speaker: 'Unsure (Riley?)' })] });
  assert.equal(answer.left_out.own, 1);
  assert.equal(answer.voices.length, 0);
});

test('a bad input is refused by the command, not guessed at', async () => {
  await assert.rejects(guessVoiceSuggestions({ ...base, voices: 'nope' }), /voices must be a list/);
  await assert.rejects(guessVoiceSuggestions({ ...base, rules: undefined, voices: [] }), /rules must be the DATA/);
  await assert.rejects(guessVoiceSuggestions({ ...base, pattern: '', voices: [] }), /pattern must be/);
});

test('the command runs the way the container runs it: one JSON line on stdout', () => {
  const input = { ...base, voices: [voice(1)], calendar_items: [{ title: 'Call with Sofus', starts_at: at(5), ends_at: at(35), all_day: false }] };
  const out = JSON.parse(execFileSync('node', [resolve(here, '..', 'do-work', 'guess-voice-suggestions.mjs'), JSON.stringify(input)], { encoding: 'utf8' }));
  assert.equal(out.voices[0].suggestions[0].id, 'sofus-hansen');
});

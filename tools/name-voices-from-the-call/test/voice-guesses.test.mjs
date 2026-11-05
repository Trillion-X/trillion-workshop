// test/voice-guesses.test.mjs
//
// The guess of who each unnamed voice is (src/voice-guesses.mjs), with the rules of the real DATA
// (src/waiting-on-you.json sources.voices.guess) and made-up people, calendar and recordings.

import test from 'node:test';
import assert from 'node:assert/strict';
import waiting from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };
import { guessVoices } from '../from-old-trillion/src/voice-guesses.mjs';

const section = waiting.sources.voices;
const people = [
  { id: 'sofus-hansen', list_id: 'friends', row_type: 'contact', title: 'Sofus Hansen' },
  { id: 'dana-wu', list_id: 'friends', row_type: 'contact', title: 'Dana Wu' },
  { id: 'ana-jose', list_id: 'clients', row_type: 'crm', title: 'José Ana Silva' },
  { id: 'owner', list_id: 'friends', row_type: 'contact', title: 'Riley Stone' },
];
const at = minutes => new Date(Date.parse('2026-10-09T10:00:00Z') + minutes * 60_000).toISOString();
const voice = (n, extra = {}) => ({ id: `listen:Someone (voice-${n})@${at(n)}`, app: 'listen', speaker: `Someone (voice-${n})`, turns: 2, since: at(n * 10), until: at(n * 10 + 4), last_at: at(n * 10 + 4), last_words: 'good morning everyone', clip: `1f:${String(n).repeat(64).slice(0, 64)}`, ...extra });
const reads = (extra = {}) => ({ owner: 'Riley Stone', ownerWords: () => ['Thanks, I will send the notes tonight.'], calendar: async () => ({ items: [] }), title: () => null, names: () => [], earlier: () => null, ...extra });
const guess = (voices, read) => guessVoices({ voices, rules: section.guess, pattern: section.guess_pattern, people, read: reads(read) });

test('a calendar event naming a person at that time ranks that person first, with the row and the reason', async () => {
  const answer = await guess([voice(1)], { calendar: async () => ({ items: [{ title: 'Call with Sofus', starts_at: at(5), ends_at: at(35), all_day: false }] }) });
  const [first] = answer.voices;
  assert.equal(first.suggestions[0].id, 'sofus-hansen');
  assert.equal(first.suggestions[0].list_id, 'friends');
  assert.equal(first.suggestions[0].title, 'Sofus Hansen');
  assert.match(first.suggestions[0].why, /Call with Sofus/);
  assert.equal(first.why, first.suggestions[0].why);
});

test('the listener guess is matched to a row, and kept as plain words when no row matches', async () => {
  const answer = await guess([voice(1, { speaker: 'Unsure (Dana?)' }), voice(2, { speaker: 'Unsure (Mx Zed?)' })]);
  const byId = new Map(answer.voices.map(row => [row.speaker, row]));
  assert.equal(byId.get('Unsure (Dana?)').suggestions[0].id, 'dana-wu');
  assert.equal(byId.get('Unsure (Mx Zed?)').suggestions[0].id, undefined);
  assert.equal(byId.get('Unsure (Mx Zed?)').suggestions[0].title, 'Mx Zed');
});

test('a guess of several people offers each one, and matching ignores case, accents and part of a word', async () => {
  const answer = await guess([voice(1, { speaker: 'Unsure (dana or JOSE?)' }), voice(2, { speaker: 'Unsure (Sofusson?)' })]);
  const byLabel = new Map(answer.voices.map(row => [row.speaker, row]));
  assert.deepEqual(byLabel.get('Unsure (dana or JOSE?)').suggestions.map(item => item.id).sort(), ['ana-jose', 'dana-wu']);
  assert.equal(byLabel.get('Unsure (Sofusson?)').suggestions[0].id, undefined);
});

test('the title and the file name of the recording are evidence', async () => {
  const answer = await guess([voice(1, { speaker: 'Unsure (Dana?)' }), voice(2)], { title: id => (id.startsWith('1f:2') ? 'Lunch with Sofus' : null), names: id => (id.startsWith('1f:2') ? ['sofus-2026-10-09.m4a'] : []) });
  const second = answer.voices.find(row => row.id === voice(2).id);
  assert.equal(second.suggestions[0].id, 'sofus-hansen');
  assert.match(second.suggestions[0].why, /titled "Lunch with Sofus"/);
  assert.match(second.suggestions[0].why, /named "sofus-2026-10-09"/);
  assert.equal(answer.voices.find(row => row.speaker === 'Unsure (Dana?)').suggestions[0].id, 'dana-wu');
});

test('a row already chosen for the same guess in another session is evidence', async () => {
  const answer = await guess([voice(1, { speaker: 'Unsure (Sofus?)' })], { earlier: () => 'record:contact:dana-wu' });
  assert.equal(answer.voices[0].suggestions[0].id, 'dana-wu');
  assert.match(answer.voices[0].suggestions[0].why, /another session/);
  assert.ok(answer.voices[0].suggestions.some(item => item.id === 'sofus-hansen'));
});

test('the person is in every calendar event and recording title, so those never make a voice theirs', async () => {
  const answer = await guess([voice(1)], { calendar: async () => ({ items: [{ title: 'Riley Stone and Dana Wu', starts_at: at(5), ends_at: at(35) }] }) });
  assert.equal(answer.left_out.own, 0);
  assert.equal(answer.voices[0].suggestions[0].id, 'dana-wu');
  assert.ok(!answer.voices[0].suggestions.some(item => item.id === 'owner'));
});

test('the person\'s own voice, guessed by the listener, is left out and counted', async () => {
  const answer = await guess([voice(1, { speaker: 'Unsure (Riley?)' }), voice(2, { speaker: 'Unsure (Dana?)' })]);
  assert.deepEqual(answer.left_out, { own: 1, playback: 0 });
  assert.deepEqual(answer.voices.map(row => row.speaker), ['Unsure (Dana?)']);
});

test('a voice with no suggestion speaking another script than the person writes is a recording playing, and is left out', async () => {
  const korean = voice(1, { last_words: '안녕하세요 여러분 오늘도 좋은 하루 되세요' });
  const answer = await guess([korean, voice(2)]);
  assert.deepEqual(answer.left_out, { own: 0, playback: 1 });
  assert.deepEqual(answer.voices.map(row => row.id), [voice(2).id]);
  const kept = await guess([{ ...korean, speaker: 'Unsure (Dana?)' }]);
  assert.equal(kept.left_out.playback, 0, 'a voice with a suggestion is kept');
  const unknown = await guess([korean], { ownerWords: () => [] });
  assert.equal(unknown.left_out.playback, 0, 'nothing is left out when the person\'s own words are not known');
});

test('voices guessed to be the same row are one row naming the others, and a voice with no evidence is never folded in and comes last', async () => {
  const answer = await guess(
    [voice(1, { speaker: 'Unsure (Sofus?)', clip: undefined }), voice(2), voice(3, { speaker: 'Unsure (Sofus?)' }), voice(4, { speaker: 'Unsure (Dana?)' })],
  );
  assert.equal(answer.voices.length, 3);
  const merged = answer.voices.find(row => row.also);
  assert.equal(merged.suggestions[0].id, 'sofus-hansen');
  assert.equal(merged.id, voice(3, { speaker: 'Unsure (Sofus?)' }).id, 'the one with a clip leads');
  assert.deepEqual(merged.also.map(item => item.id), [voice(1).id]);
  assert.deepEqual(Object.keys(merged.also[0]).sort(), ['app', 'id', 'since', 'speaker', 'turns', 'until']);
  assert.equal(merged.turns, 4);
  const last = answer.voices.at(-1);
  assert.equal(last.id, voice(2).id);
  assert.deepEqual(last.suggestions, []);
  assert.equal(last.also, undefined);
});

const talk = (speaker, text, app = 'listen') => ({ app, speaker, text, at: at(12) });

test('a name said in the same conversation ranks that person with the words said, and never outranks a listener guess', async () => {
  const asked = [];
  const said = async window => { asked.push(window); return [talk('person', 'Thanks Sofus Hansen, that helps'), talk('Someone (voice-9)', 'Dana will join later')]; };
  const bare = (await guess([voice(1, { conversation_id: 'room' })], { said })).voices[0];
  assert.equal(bare.suggestions[0].id, 'sofus-hansen');
  assert.match(bare.suggestions[0].why, /^Someone said "Thanks Sofus Hansen, that helps" in the same conversation$/);
  assert.equal(bare.why, bare.suggestions[0].why);
  assert.ok(bare.suggestions.some(item => item.id === 'dana-wu'), 'a name said by another voice counts too');
  assert.equal(asked[0].conversation_id, 'room');
  assert.equal(asked[0].limit, section.guess.said.reads);
  assert.equal(Date.parse(voice(1).since) - Date.parse(asked[0].since), section.guess.said.minutes * 60_000, 'the window is widened by the DATA minutes');
  assert.equal(Date.parse(asked[0].until) - Date.parse(voice(1).until), section.guess.said.minutes * 60_000);
  const listened = (await guess([voice(2, { conversation_id: 'room', speaker: 'Unsure (Dana?)' })], { said: async () => [talk('person', 'Sofus, Sofus Hansen, can you hear me?')] })).voices[0];
  assert.deepEqual(listened.suggestions.map(item => item.id), ['dana-wu', 'sofus-hansen'], 'the listener guess outranks a name said, even a whole title');
  assert.ok(section.guess.sources.said.weight < Math.min(...Object.entries(section.guess.sources).filter(([name]) => name !== 'said').map(([, source]) => source.weight)), 'said is the lowest weight');
});

test('a name said by the voice itself, by someone in another app, by the person themselves as a match, or by one already speaking in it is no evidence', async () => {
  const said = async () => [
    talk('Someone (voice-1)', 'Sofus is my friend'),
    talk('person', 'Dana, are you there?', 'chat'),
    talk('Dana Wu', 'I am here'),
    talk('person', 'Dana, good to see you. And Riley Stone is my name'),
  ];
  const answer = await guess([voice(1, { conversation_id: 'room' })], { said });
  assert.deepEqual(answer.voices[0].suggestions, [], 'the voice itself, another app, a person speaking under their own name, and the owner are all left out');
  assert.equal(answer.left_out.own, 0);
});

test('a guess at the voice\'s own label is not a person speaking in the conversation', async () => {
  const answer = await guess([voice(1, { conversation_id: 'room', speaker: 'Unsure (Sofus?)' })], { said: async () => [talk('Unsure (Dana?)', 'Dana is here too'), talk('person', 'hello Dana')] });
  assert.ok(answer.voices[0].suggestions.some(item => item.id === 'dana-wu'), 'only a named speaker, not a guessed label, keeps a person out');
  assert.equal(answer.voices[0].suggestions[0].id, 'sofus-hansen');
});

test('two voices that only heard the same name are not folded into one row, and a voice without a conversation reads nothing', async () => {
  let reads = 0;
  const said = async () => { reads += 1; return [talk('person', 'Thanks Sofus')]; };
  const answer = await guess([voice(1, { conversation_id: 'room' }), voice(2, { conversation_id: 'room' }), voice(3)], { said });
  assert.equal(reads, 2, 'a voice with no conversation_id is not read for');
  assert.equal(answer.voices.length, 3);
  assert.ok(answer.voices.every(row => row.also === undefined));
});

test('more messages than the DATA cap are never used, and a failed read leaves the other evidence standing', async () => {
  const flood = Array.from({ length: 500 }, (_, n) => talk('person', n < section.guess.said.reads ? 'nobody here' : 'Thanks Sofus'));
  const capped = await guess([voice(1, { conversation_id: 'room' })], { said: async () => flood });
  assert.deepEqual(capped.voices[0].suggestions, [], 'only the first `said.reads` messages are looked through');
  const broken = await guess([voice(1, { conversation_id: 'room', speaker: 'Unsure (Dana?)' })], { said: async () => { throw new Error('down'); } });
  assert.equal(broken.voices[0].suggestions[0].id, 'dana-wu');
});

test('a source that cannot be read leaves its evidence out and the others stand', async () => {
  const answer = await guess([voice(1, { speaker: 'Unsure (Dana?)' })], { calendar: async () => { throw new Error('down'); }, title: () => { throw new Error('down'); }, earlier: () => { throw new Error('down'); } });
  assert.equal(answer.voices[0].suggestions[0].id, 'dana-wu');
});

// Evidence about the moment (title, file name, calendar, a name said) is the same for every voice heard in it.
const titled = title => ({ title: () => title });
const together = (n, extra = {}) => voice(n, { since: at(10), until: at(14), last_at: at(14 + n), clip: '1f:' + 'c'.repeat(64), ...extra });

test('two voices in one recording titled with a name are not merged, and neither is chosen for the person', async () => {
  const answer = await guess([together(1), together(2)], titled('Call with Sofus'));
  assert.equal(answer.voices.length, 2);
  for (const row of answer.voices) {
    assert.equal(row.also, undefined);
    assert.equal(row.suggestions[0].id, 'sofus-hansen');
    assert.equal(row.suggestions[0].sure, false);
  }
});

test('one voice alone in its moment with that title is chosen for the person', async () => {
  const answer = await guess([voice(1)], titled('Call with Sofus'));
  assert.equal(answer.voices[0].suggestions[0].id, 'sofus-hansen');
  assert.equal(answer.voices[0].suggestions[0].sure, true);
});

test('the listener guess is about the voice itself: sure, and voices sharing it are one row', async () => {
  const answer = await guess([together(1, { speaker: 'Unsure (Dana?)' }), voice(5, { speaker: 'Unsure (Dana?)', clip: undefined })], titled('Call with Sofus'));
  const dana = answer.voices.find(row => row.suggestions[0].id === 'dana-wu');
  assert.equal(dana.suggestions[0].sure, true);
  assert.equal(dana.also?.length, 1);
});

test("a person's first word in a folder of the file's path is no evidence", async () => {
  const answer = await guess([voice(1)], { names: () => ['/Recordings/Sofus/proof-17/moment-1.m4a'] });
  assert.ok(!answer.voices[0]?.suggestions?.some(item => item.id === 'sofus-hansen'));
});

test('a voice in another script with only moment evidence is a recording playing and is left out', async () => {
  const answer = await guess([together(1, { last_words: '다음 영상에서 만나요 다음 영상에서', clear_words: '' }), together(2)], titled('Call with Sofus'));
  assert.equal(answer.left_out.playback, 1);
  assert.equal(answer.voices.length, 1);
});

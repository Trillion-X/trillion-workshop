// The person's writing voice (read-data/voice.mjs): the shapers that turn what an AI learned and what the person changed
// into the rows the person's own store keeps, and the word changes the edits repeat. The store itself is not touched
// here; its steps are the recipe workflow:keep-how-someone-does-their-thing. Every subject, word and name is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { VoiceError, keepAVoiceEdit, repeatedVoiceEdits, saveVoice } from '../read-data/voice.mjs';

const folder = join(import.meta.dirname, '..');
const now = () => new Date('2030-01-01T10:00:00.000Z');
const newId = () => '0123456789abcdef0123456789abcdef';

const run = (script, input) => new Promise((resolve) => {
  const child = execFile(process.execPath, [join(folder, 'do-work', script)], { cwd: folder }, (error, stdout) => {
    const line = String(stdout).trim().split('\n').at(-1);
    resolve({ code: error ? error.code : 0, out: JSON.parse(line) });
  });
  child.stdin.end(JSON.stringify(input));
});

test('a first save keeps one profile row for the kind, a later save merges its fields and an empty one removes a field', () => {
  const first = saveVoice({ kind: 'post', name: 'Posts', fields: { how_they_write: 'Short, plain, no slogans.', words_they_avoid: 'synergy' }, now });
  assert.equal(first.profile.profile_id, 'voice-profile:post');
  assert.equal(first.profile.set_by, 'ai');
  assert.equal(first.said, 'Saved the post voice profile.');
  assert.deepEqual(first.keep, [{ id: 'voice-profile:post', type: 'voice-profile', value: first.profile }]);
  const second = saveVoice({ kind: 'post', fields: { examples: 'We launched today.', words_they_avoid: '' }, earlier: first.profile, expected_set_at: first.profile.set_at, now, by: 'person' });
  assert.equal(second.profile.name, 'Posts', 'the name is kept when none is given');
  assert.deepEqual(second.profile.fields, { how_they_write: 'Short, plain, no slogans.', examples: 'We launched today.' });
  assert.equal(second.profile.set_by, 'person');
});

test('a save is refused for a field voice.json does not name, a bad kind, a stale read, or a new profile past the account limit', () => {
  assert.throws(() => saveVoice({ kind: 'post', fields: { tone: 'warm' } }), /tone is not a field of a voice profile\. The fields are: how_they_write/);
  assert.throws(() => saveVoice({ kind: 'Post!', fields: { how_they_write: 'x' } }), /short lower-case name/);
  assert.throws(() => saveVoice({ fields: {} }), VoiceError);
  const saved = saveVoice({ kind: 'post', fields: { how_they_write: 'Brief.' }, now });
  assert.throws(() => saveVoice({ kind: 'post', fields: { examples: 'older' }, earlier: saved.profile, expected_set_at: null, now }), /Read it again from the store/);
  assert.throws(() => saveVoice({ kind: 'email', fields: { how_they_write: 'x' }, profiles_kept: 40 }), /at most 40 voice profiles/);
  assert.equal(saveVoice({ kind: 'post', fields: { how_they_write: 'x' }, earlier: saved.profile, profiles_kept: 40, now }).profile.fields.how_they_write, 'x', 'an existing profile is saved over at the limit');
});

test('the person changing an AI draft’s words is kept as an edit; words that did not change are not', () => {
  assert.deepEqual(keepAVoiceEdit({ kind: 'post', subject_id: 'post:p1', before: 'Excited to announce our synergistic launch!', after: '  Excited to announce our synergistic launch! ', now, newId }), { edit: null, keep: [] });
  const kept = keepAVoiceEdit({ kind: 'post', subject_id: 'post:p1', before: 'Excited to announce our synergistic launch! Version 2', after: 'We launched today.', before_by: 'Sample AI', now, newId });
  assert.equal(kept.edit.before, 'Excited to announce our synergistic launch! Version 2');
  assert.equal(kept.edit.after, 'We launched today.');
  assert.equal(kept.edit.before_by, 'Sample AI');
  assert.equal(kept.edit.kind, 'post');
  assert.deepEqual(kept.keep, [{ id: kept.edit.edit_id, type: 'voice-edit', value: kept.edit }]);
  assert.match(kept.edit.edit_id, /^voice-edit:2030-01-01T10:00:00\.000Z:0123456789/);
  const long = keepAVoiceEdit({ before: 'a'.repeat(5000), after: 'b', now, newId });
  assert.equal(long.edit.before.length, 4000, 'an edit is cut to max_edit_chars');
  assert.equal(long.edit.kind, 'all', 'with no kind the edit is for every kind');
  assert.throws(() => keepAVoiceEdit({ kind: 'Bad Kind', before: 'a', after: 'b' }), /short lower-case name/);
});

test('a word change counts once per draft, and only one in enough different drafts is shown, from the edits in the request', () => {
  const pairs = [['post:a', 'Our synergy is strong.', 'Our team is strong.'], ['post:a', 'The synergy helps.', 'The team helps.'],
    ['post:b', 'Real synergy here.', 'Real team here!'], ['post:c', 'Some synergy, sadly.', 'Some team, sadly.'], ['post:c', 'Hello there', 'Hi there']];
  const edits = pairs.map(([subject_id, before, after], index) => ({ edit_id: `voice-edit:${index}`, kind: 'post', subject_id, before, after }));
  const found = repeatedVoiceEdits({ edits });
  assert.equal(found.edits, 5);
  assert.deepEqual(found.repeated.map(({ from, to, drafts }) => ({ from, to, drafts })), [{ from: 'synergy', to: 'team', drafts: 3 }], 'two edits of one draft count once; one draft never makes a pattern');
  assert.equal(repeatedVoiceEdits({ edits, min_distinct_drafts: 4 }).repeated.length, 0);
  assert.throws(() => repeatedVoiceEdits({ edits, min_distinct_drafts: 1 }), /at least 2/);
  assert.equal(repeatedVoiceEdits({ edits, kind: 'email' }).edits, 0);
  assert.throws(() => repeatedVoiceEdits({}), /Send the edits to count/);
});

test('each shaper runs as the container runs it: the sample gives the text it promises', async () => {
  const rows = JSON.parse(await readFile(join(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.map(record => record.payload);
  const voice = rows.filter(row => /voice|repeated/.test(row.id));
  assert.deepEqual(voice.map(row => row.id).sort(), ['tool:find-repeated-voice-edits', 'tool:keep-a-voice-edit', 'tool:save-voice']);
  for (const row of voice) {
    const [sample] = row.verify;
    const { code, out } = await run(row.invoke.run[1].replace('do-work/', ''), sample.input);
    assert.equal(code, 0, row.id);
    const value = sample.output_selector.replace('$.', '').split('.').reduce((from, key) => from[key], out.result);
    assert.ok(JSON.stringify(value).includes(sample.contains), row.id);
  }
});

test('the voice rows reach no records door and name no store operation: the store is the recipe’s', async () => {
  const body = await readFile(join(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8');
  assert.doesNotMatch(body, /records-door|records:(read|list|write)/);
  assert.doesNotMatch(body, /"tool:read-voice"|"tool:forget-voice"/);
  const voice = await readFile(join(folder, 'read-data', 'voice.mjs'), 'utf8');
  assert.doesNotMatch(voice, /\bdoor\b|records:|records-door/, 'the shapers keep no record and read none');
});

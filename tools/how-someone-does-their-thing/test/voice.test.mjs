// The person's writing voice (read-data/voice.mjs, moved from Trillion-X/trillion src/voice.mjs), run row by row the way
// the container runs it against a stand-in records door: a change the person makes to a draft's words is kept as their
// edit, an AI saves what it learned as a profile, every drafting AI reads both, each can be forgotten, and the word
// changes the edits repeat are counted. Every subject, word and name here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const rows = JSON.parse(await readFile(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const run = async (id, input, records = [], row = rowOf(rows, `tool:${id}`)) => {
  const ran = await answerOf(row, input, { records });
  return { ...ran, records: ran.kept };
};
const edit = (records, input) => run('keep-a-voice-edit', { kind: 'post', ...input }, records);

test('the person changing an AI draft\'s words is kept as an edit; words that did not change are not', async () => {
  const same = await edit([], { subject_id: 'post:p1', before: 'Excited to announce our synergistic launch!', after: '  Excited to announce our synergistic launch! ' });
  assert.equal(same.result.edit, null, 'the same words are not an edit');
  assert.equal(same.records.length, 0);
  const kept = await edit([], { subject_id: 'post:p1', before: 'Excited to announce our synergistic launch! Version 2', after: 'We launched today.', before_by: 'Sample AI' });
  const read = (await run('read-voice', {}, kept.records)).result;
  console.log('VOICE READBACK edits:', JSON.stringify(read.edits.map(({ before, after, before_by }) => ({ before, after, before_by }))));
  assert.deepEqual(read.edits.map(({ before, after, before_by }) => ({ before, after, before_by })), [{ before: 'Excited to announce our synergistic launch! Version 2', after: 'We launched today.', before_by: 'Sample AI' }]);
});

test('an AI saves a profile by the DATA fields, a stale save is refused, and read gives profiles, edits and sent words together', async () => {
  const posted = [{ id: 'post:p2', type: 'post', value: { post_id: 'post:p2', status: 'posted', caption: 'Short and plain.', sent_at: '2030-01-01T10:00:00.000Z' } },
    { id: 'post:p3', type: 'post', value: { post_id: 'post:p3', status: 'draft', caption: 'Not sent yet.' } }];
  const { records: edited } = await edit(posted, { subject_id: 'post:p2', before: 'Stronger together', after: 'Short and plain.' });
  const saved = await run('save-voice', { kind: 'post', name: 'Posts', fields: { how_they_write: 'Short, plain, no slogans.', words_they_avoid: 'synergy' } }, edited);
  assert.match((await run('save-voice', { kind: 'post', fields: { tone: 'warm' } }, saved.records)).error, /tone is not a field of a voice profile\. The fields are: how_they_write/);
  assert.match((await run('save-voice', { kind: 'Post!', fields: { how_they_write: 'x' } }, saved.records)).error, /short lower-case name/);
  const again = await run('save-voice', { kind: 'post', fields: { examples: 'We launched today.' }, expected_set_at: saved.result.profile.set_at }, saved.records);
  const stale = await run('save-voice', { kind: 'post', fields: { examples: 'older' }, expected_set_at: saved.result.profile.set_at }, again.records);
  assert.match(stale.error, /Read it again with tool:read-voice/);
  assert.equal(stale.status, 1);
  const read = (await run('read-voice', { kind: 'post' }, again.records)).result;
  console.log('VOICE READBACK profile:', JSON.stringify(read.profiles[0].fields));
  assert.deepEqual(read.profiles[0].fields, { how_they_write: 'Short, plain, no slogans.', words_they_avoid: 'synergy', examples: 'We launched today.' });
  assert.equal(read.profiles[0].name, 'Posts');
  assert.equal(read.profiles[0].set_by, 'ai');
  assert.equal(read.edits.length, 1);
  assert.deepEqual(read.sent.map(({ id, text }) => ({ id, text })), [{ id: 'post:p2', text: 'Short and plain.' }], 'only what was posted is sent words');
  assert.deepEqual(read.fields.map(field => field.id), ['how_they_write', 'words_they_use', 'words_they_avoid', 'examples', 'builds_on']);
});

test('a profile builds on others by the builds_on field, and the person\'s own save says so', async () => {
  const base = await run('save-voice', { kind: 'base', fields: { words_they_avoid: 'revolutionary' } });
  const theirs = await run('save-voice', { kind: 'email', fields: { how_they_write: 'Warm, two lines.', builds_on: 'base' }, by: 'person' }, base.records);
  const read = (await run('read-voice', {}, theirs.records)).result;
  assert.deepEqual(read.profiles.map(({ kind, fields, set_by }) => ({ kind, builds_on: fields.builds_on ?? null, set_by })),
    [{ kind: 'email', builds_on: 'base', set_by: 'person' }, { kind: 'base', builds_on: null, set_by: 'ai' }]);
});

test('forget removes a profile, one edit or every edit, and says how many', async () => {
  let records = (await edit([], { subject_id: 'post:p4', before: 'a', after: 'b' })).records;
  records = (await edit(records, { subject_id: 'post:p4', before: 'b', after: 'c' })).records;
  records = (await run('save-voice', { fields: { how_they_write: 'brief' } }, records)).records;
  const { edits, profiles } = (await run('read-voice', {}, records)).result;
  assert.equal(edits.length, 2);
  const one = await run('forget-voice', { edit_id: edits[0].edit_id }, records);
  assert.equal(one.result.forgot, 1);
  const profile = await run('forget-voice', { profile_id: profiles[0].profile_id }, one.records);
  assert.equal(profile.result.forgot, 1);
  const all = await run('forget-voice', { all_edits: true }, profile.records);
  assert.equal(all.result.forgot, 1);
  const after = (await run('read-voice', {}, all.records)).result;
  console.log('VOICE READBACK after forgetting:', JSON.stringify({ edits: after.edits.length, profiles: after.profiles.length }));
  assert.deepEqual([after.edits.length, after.profiles.length], [0, 0]);
  assert.match((await run('forget-voice', {}, all.records)).error, /Name what to forget/);
});

test('a word change counts once per draft, and only one in enough different drafts is shown', async () => {
  let records = [];
  for (const [draft, before, after] of [['post:a', 'Our synergy is strong.', 'Our team is strong.'], ['post:a', 'The synergy helps.', 'The team helps.'],
    ['post:b', 'Real synergy here.', 'Real team here!'], ['post:c', 'Some synergy, sadly.', 'Some team, sadly.'], ['post:c', 'Hello there', 'Hi there']]) {
    records = (await edit(records, { subject_id: draft, before, after })).records;
  }
  const found = (await run('find-repeated-voice-edits', {}, records)).result;
  assert.equal(found.edits, 5);
  assert.deepEqual(found.repeated.map(({ from, to, drafts }) => ({ from, to, drafts })), [{ from: 'synergy', to: 'team', drafts: 3 }], 'two edits of one draft count once; one draft never makes a pattern');
  assert.equal((await run('find-repeated-voice-edits', { min_distinct_drafts: 4 }, records)).result.repeated.length, 0);
  assert.match((await run('find-repeated-voice-edits', { min_distinct_drafts: 1 }, records)).error, /at least 2/);
  assert.equal((await run('find-repeated-voice-edits', { kind: 'email' }, records)).result.edits, 0);
});

test('a run reaches only the record kinds its row names', async () => {
  const row = rowOf(rows, 'tool:find-repeated-voice-edits');
  const ungranted = { ...row, invoke: { ...row.invoke, records: { fd: 3, rights: [] } } };
  assert.match((await run(null, {}, [], ungranted)).error, /may not reach those records/);
});

test('each voice row\'s sample gives the text it promises against its sample account', async () => {
  for (const { payload } of rows.records.filter(({ payload }) => payload.invoke.records)) {
    const [sample] = payload.verify;
    const ran = await answerOf(payload, sample.input, { records: sample.records ?? [] });
    const value = sample.output_selector === '$' ? ran : sample.output_selector.replace('$.', '').split('.').reduce((at, key) => at?.[key], ran.result);
    assert.ok(JSON.stringify(value).includes(sample.contains), `${payload.id}: ${JSON.stringify(value)}`);
  }
});

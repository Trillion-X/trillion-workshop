import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awarenessPrompt, mergePicture, reviewTraitHistory, shapePicture } from '../src/picture.mjs';
import { settings, mapSettings } from './made-up-settings.mjs';

const keepAreas = (ids, areas) => (Array.isArray(ids) ? ids.filter(id => areas.some(area => area.id === id)) : []);
const areas = [{ id: 'body', label: 'Body' }, { id: 'mind', label: 'Mind' }];

test('the prompt is built from the settings rows: the instructions, every trait id and the judgement choices', () => {
  const prompt = awarenessPrompt(settings);
  assert.ok(prompt.startsWith('Read what the person did and wrote.'));
  assert.match(prompt, /"values"/);
  assert.match(prompt, /"skills"/);
  assert.ok(prompt.includes('\\"yes\\" | \\"no\\"'), 'the judgement choices are listed in the JSON shape');
  assert.match(prompt, /Ask at most 2 new questions/);
  assert.match(prompt, /Keep at most 5 pursuits, 3 items per trait, 4 observations and 3 evidence items each/);
  assert.doesNotMatch(prompt, /map area id/);
});

test('the prompt with the map adds the map areas and the map reading words, and refuses to build without the map settings', () => {
  const prompt = awarenessPrompt(settings, { map: true, mapSettings });
  assert.match(prompt, /Look across every area, first the untouched ones\./);
  assert.match(prompt, /map area id/);
  assert.throws(() => awarenessPrompt(settings, { map: true }), TypeError);
});

test('a merge into the picture so far keeps earlier traits a reply does not refresh and replaces refreshed ones', () => {
  const before = {
    trajectory: 'old', traits: { values: [{ name: 'Honesty', evidence: ['old quote'] }], skills: [{ name: 'Cooking', evidence: ['c'] }] },
    pursuits: [{ title: 'Write a book', recorded: 'pursuit:write-a-book', now: 'draft', after: 'published', evidence: ['wrote a chapter'], judgements: { worth: { choice: 'yes', why: 'a' } } }],
    observations: [], right_now: { doing: 'x' },
  };
  const update = {
    trajectory: 'new', traits: { values: [{ name: 'Honesty', evidence: ['new quote'] }], skills: [] },
    pursuits: [{ title: 'write a BOOK', recorded: '', now: '', after: '', evidence: [], trajectory: 't', judgements: { worth: { choice: 'no', why: 'b' } }, areas: [] }],
    observations: [], right_now: null, questions: [],
  };
  const merged = mergePicture(before, update, settings);
  assert.equal(merged.trajectory, 'new');
  assert.deepEqual(merged.traits.values, [{ name: 'Honesty', evidence: ['new quote'] }]);
  assert.deepEqual(merged.traits.skills, [{ name: 'Cooking', evidence: ['c'] }]);
  assert.equal(merged.pursuits.length, 1);
  assert.equal(merged.pursuits[0].recorded, 'pursuit:write-a-book');
  assert.equal(merged.pursuits[0].now, 'draft');
  assert.deepEqual(merged.pursuits[0].evidence, ['wrote a chapter']);
  assert.deepEqual(merged.pursuits[0].judgements, { worth: { choice: 'no', why: 'b' } });
  assert.deepEqual(merged.right_now, { doing: 'x' });
});

test('a merge without an earlier picture, or with incremental off, is the update itself', () => {
  const update = { trajectory: 'only', traits: {}, pursuits: [], observations: [], right_now: null };
  assert.equal(mergePicture(null, update, settings), update);
  assert.equal(mergePicture({ trajectory: 'old' }, update, { ...settings, incremental: false }), update);
});

test('a trait whose quotes are not in its evidence sources is moved to the unverified list, not shown as a fact', () => {
  const before = { trajectory: 't', traits: {
    values: [
      { name: 'Verified', evidence: ['I keep promises'], evidence_sources: [{ source_id: 's1', speaker: 'person', quote: 'I keep promises' }] },
      { name: 'Unbacked', evidence: ['I never lie'], evidence_sources: [{ source_id: 's2', speaker: 'ai', quote: 'I never lie' }] },
    ],
    skills: [],
  } };
  const { picture, unverified_traits } = reviewTraitHistory(before, settings);
  assert.deepEqual(picture.traits.values.map(item => item.name), ['Verified']);
  assert.deepEqual(unverified_traits.values.map(item => item.name), ['Unbacked']);
  assert.deepEqual(reviewTraitHistory(null, settings), { picture: null, unverified_traits: {} });
});

test('a reply with no trajectory is refused, and unlisted judgements, stages and question owners are dropped or made other', () => {
  assert.equal(shapePicture({ trajectory: '  ' }, settings), null);
  assert.equal(shapePicture('not an object', settings), null);
  const reply = {
    trajectory: 'Moving toward a book.',
    pursuits: [{ title: 'Write a book', judgements: { worth: { choice: 'MAYBE', why: 'x' } }, evidence: ['a', 'b', 'c', 'd'] }],
    observations: [{ about: 'Keeps a diary', stages: { aware: 'notices', unknown: 'dropped' } }, { about: 'Empty', stages: {} }],
    right_now: { doing: 'Writing', judgement: { choice: 'on', why: 'daily' }, nudge: '' },
    questions: [
      { question: 'Is the book for money?', about: 'pursuits', guess: 'no', why: 'why' },
      { question: 'is the BOOK for money?', about: 'pursuits' },
      { question: 'What else?', about: 'nowhere' },
    ],
  };
  const shaped = shapePicture(reply, settings);
  assert.equal(shaped.pursuits[0].judgements.worth, undefined);
  assert.deepEqual(shaped.pursuits[0].evidence, ['a', 'b', 'c']);
  assert.deepEqual(shaped.observations, [{ about: 'Keeps a diary', stages: { aware: 'notices' } }]);
  assert.deepEqual(shaped.right_now, { doing: 'Writing', judgement: { choice: 'on', why: 'daily' }, nudge: '' });
  assert.deepEqual(shaped.questions.map(item => item.about), ['pursuits', 'other']);
  assert.equal(shaped.questions.length, 2);
});

test('trait evidence is kept only when the quote is in a new input from an allowed speaker, cited by its source id', () => {
  const sources = [{ source_id: 'm1', kind: 'message', speaker: 'person', text: 'I always finish what I start.' }, { source_id: 'm2', kind: 'message', speaker: 'ai', text: 'You are patient.' }];
  const reply = { trajectory: 't', traits: { values: [
    { name: 'Finishes', evidence: [{ quote: 'I always finish', source_id: 'm1' }] },
    { name: 'Patient', evidence: [{ quote: 'You are patient', source_id: 'm2' }] },
    { name: 'No cite', evidence: [{ quote: 'I always finish', source_id: '' }] },
  ] } };
  const shaped = shapePicture(reply, settings, { sources });
  assert.deepEqual(shaped.traits.values.map(item => item.name), ['Finishes']);
  assert.deepEqual(shaped.traits.values[0].evidence_sources, [{ source_id: 'm1', speaker: 'person', at: null, quote: 'I always finish' }]);
});

test('with the map, each pursuit keeps only the area ids keepAreas finds on the map; with areas and no keepAreas it refuses', () => {
  const reply = { trajectory: 't', pursuits: [{ title: 'Run', areas: ['body', 'unknown'] }] };
  assert.deepEqual(shapePicture(reply, settings, { areas, keepAreas }).pursuits[0].areas, ['body']);
  assert.throws(() => shapePicture(reply, settings, { areas }), TypeError);
});

test('a pursuit recorded id is kept only when it is one of the recorded ids the caller names', () => {
  const reply = { trajectory: 't', pursuits: [{ title: 'Run', recorded: 'pursuit:run', now: 'a', after: 'b' }, { title: 'Swim', recorded: 'pursuit:made-up', now: 'a', after: 'b' }] };
  const shaped = shapePicture(reply, settings, { recorded: new Set(['pursuit:run']) });
  assert.deepEqual(shaped.pursuits.map(item => item.recorded), ['pursuit:run', '']);
});

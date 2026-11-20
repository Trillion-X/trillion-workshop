import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awarenessSections } from '../src/awareness-sections.mjs';
import { settings, mapSettings } from './made-up-settings.mjs';

const readNow = { label: 'Read now', busy_label: 'Reading', tone: 'quiet', icon: 'RefreshCw', send: { path: '/read' } };
const mapSection = { id: 'life-map', heading: 'Map', body: 'Start a map of your life.' };

const picture = {
  trajectory: 'Moving toward a book.',
  read_at: '2026-11-19T12:00:00.000Z',
  read_count: 12,
  traits: { values: [{ name: 'Honesty', evidence: ['I keep promises'] }], skills: [] },
  pursuits: [
    { title: 'Write a book', trajectory: 'draft to publish', evidence: ['wrote a chapter'], judgements: { worth: { choice: 'yes', why: 'it matters' } }, areas: ['mind'] },
    { title: 'Run', trajectory: 'steady', evidence: [], judgements: { worth: { choice: 'bad-choice', why: '' } }, areas: [] },
  ],
  observations: [{ about: 'Keeps a diary', stages: { aware: 'notices daily entries' } }],
  right_now: { doing: 'Writing a chapter', judgement: { choice: 'on', why: 'matches the book' }, nudge: '' },
};
const map = { areas: [{ id: 'mind', label: 'Mind' }, { id: 'body', label: 'Body' }] };

test('with nothing read yet, the section is the empty state with the read-now action, then the map sections', () => {
  const sections = awarenessSections({ picture: null }, { settings, readNow, mapSections: [mapSection] });
  assert.deepEqual(sections, [
    { id: 'awareness', heading: 'Awareness', body: 'What the reading sees.', empty: { icon: 'Sparkles', title: 'Nothing read yet', body: 'The reading starts with the first input.' }, actions: [readNow] },
    mapSection,
  ]);
});

test('the picture builds the banner, the traits table, the pursuits table with status pills and facts, and the right-now row', () => {
  const [head, right, pursuits, observations] = awarenessSections({ picture, reading: { history_done: true }, questions: null }, { settings, readNow, mapSections: [], mapWords: mapSettings.words });
  assert.equal(head.id, 'awareness');
  assert.equal(head.banner.title, 'Moving toward a book.');
  assert.equal(head.banner.detail, 'Read 12 inputs, last on Nov 19, 2026.');
  assert.equal(head.catalog.view, 'table');
  assert.deepEqual(head.rows, [{ id: 'trait-values-0', title: 'Honesty', detail: 'Evidence: I keep promises', status: { label: 'Value', tone: 'quiet' }, facts: { name: 'Honesty', kind: 'Value', evidence: 'I keep promises' } }]);
  assert.deepEqual(head.actions, [readNow]);
  assert.equal(pursuits.id, 'awareness-pursuits');
  assert.deepEqual(pursuits.catalog.fields.map(field => field.id), ['title', 'trajectory', 'worth', 'worth_why', 'evidence']);
  assert.deepEqual(pursuits.rows[0].status, { label: 'Worth it', tone: 'good' });
  assert.equal(pursuits.rows[0].detail, 'draft to publish\nEvidence: wrote a chapter');
  assert.equal(pursuits.rows[0].facts.worth, 'Worth it');
  assert.equal(pursuits.rows[0].facts.worth_why, 'it matters');
  assert.equal(pursuits.rows[0].facts.evidence, 'wrote a chapter');
  assert.equal('status' in pursuits.rows[1], false, 'a choice that names no judgement gives no pill');
  assert.equal(pursuits.rows[1].facts.worth, '');
  assert.equal(right.id, 'awareness-right-now');
  assert.deepEqual(right.rows, [{ id: 'right-now', title: 'Writing a chapter', detail: 'matches the book', status: { label: 'On the path', tone: 'good' } }]);
  assert.equal(observations.id, 'awareness-observations');
  assert.deepEqual(observations.rows[0].steps, [{ title: 'Awareness', body: 'notices daily entries' }]);
});

test('the pursuits table shows the areas column with the map labels only when the state has a map', () => {
  const pursuitsOf = sections => sections.find(section => section.id === 'awareness-pursuits');
  const withoutMap = pursuitsOf(awarenessSections({ picture }, { settings, readNow, mapWords: mapSettings.words }));
  assert.equal(withoutMap.catalog.fields.some(field => field.id === 'areas'), false);
  const pursuits = pursuitsOf(awarenessSections({ picture, map }, { settings, readNow, mapWords: mapSettings.words, mapSections: [mapSection] }));
  assert.equal(pursuits.catalog.fields.find(field => field.id === 'areas').label, 'Areas');
  assert.equal(pursuits.rows[0].facts.areas, 'Mind');
  assert.equal(pursuits.rows[1].facts.areas, '');
});

test('map sections come after the pursuits and before the observations', () => {
  const sections = awarenessSections({ picture, map }, { settings, readNow, mapWords: mapSettings.words, mapSections: [mapSection] });
  assert.deepEqual(sections.map(section => section.id), ['awareness', 'awareness-right-now', 'awareness-pursuits', 'life-map', 'awareness-observations']);
});

test('questions waiting show a row with the count, the first three questions and the Form view link; none waiting shows no row', () => {
  const waiting = { count: 4, list_id: 'questions', questions: ['Q1?', 'Q2?', 'Q3?', 'Q4?'] };
  const sections = awarenessSections({ picture, questions: waiting }, { settings, readNow });
  const asking = sections.find(section => section.id === 'awareness-questions');
  assert.equal(asking.rows[0].title, '4 questions wait for you');
  assert.equal(asking.rows[0].detail, 'Q1?\nQ2?\nQ3?');
  assert.deepEqual(asking.rows[0].actions, [{ label: 'Answer', icon: 'ClipboardList', tone: 'primary', open: '/lists/questions?view=form' }]);
  const none = awarenessSections({ picture, questions: { count: 0, list_id: 'questions', questions: [] } }, { settings, readNow });
  assert.equal(none.some(section => section.id === 'awareness-questions'), false);
});

test('sections without the picture parts are left out: no traits table, no pursuits, no observations, no right-now row', () => {
  const bare = { trajectory: 'Only a direction.', read_at: '2026-11-19T12:00:00.000Z', read_count: 0, traits: {}, pursuits: [], observations: [], right_now: null };
  const sections = awarenessSections({ picture: bare }, { settings, readNow });
  assert.deepEqual(sections.map(section => section.id), ['awareness']);
  assert.equal('catalog' in sections[0], false);
  assert.deepEqual(sections[0].banner.detail, 'Read 0 inputs, last on Nov 19, 2026. Older history is still being read.');
});

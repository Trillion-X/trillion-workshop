// tools/photograph-each-whats-new-tour-live-on-a-fresh-account/do-work/pick-and-name-pictures.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICTURE_HEIGHT, PICTURE_WIDTH, pictureEntryOf, pictureFileOf, picturesWith, shownStepOf, tourPicturesWanted } from './pick-and-name-pictures.mjs';

const tour = (id, extra = {}) => ({ id, summary: `${id} summary`, steps: [{ id: 's1', content: { payload: { title: 'One', body: 'First.' } } }], ...extra });
const entry = (file, t) => ({ file, tour: t });

test('picks only what-new tour files, in file-name order', () => {
  const entries = [
    entry('whats-new-2026-10-05-b.json', tour('whats-new-2026-10-05-b')),
    entry('notes.json', tour('notes')),
    entry('whats-new-2026-10-01-a.json', tour('whats-new-2026-10-01-a')),
    entry('whats-new-2026-10-03-c.txt', tour('whats-new-2026-10-03-c')),
  ];
  const got = tourPicturesWanted(entries).map(item => item.file);
  assert.deepEqual(got, ['whats-new-2026-10-01-a.json', 'whats-new-2026-10-05-b.json']);
});

test('default mode skips a tour that has its own picture or a pictures.json entry', () => {
  const entries = [
    entry('whats-new-2026-10-01-own.json', tour('whats-new-2026-10-01-own', { picture: { src: 'x.webp' } })),
    entry('whats-new-2026-10-02-listed.json', tour('whats-new-2026-10-02-listed')),
    entry('whats-new-2026-10-03-new.json', tour('whats-new-2026-10-03-new')),
  ];
  const pictures = { 'whats-new-2026-10-02-listed': { src: 'whats-new-2026-10-02-listed.webp' } };
  assert.deepEqual(tourPicturesWanted(entries, { pictures }).map(item => item.tour.id), ['whats-new-2026-10-03-new']);
});

test('named mode takes the named ids again even when they already have a picture, and ignores the rest', () => {
  const entries = [
    entry('whats-new-2026-10-01-a.json', tour('whats-new-2026-10-01-a')),
    entry('whats-new-2026-10-02-b.json', tour('whats-new-2026-10-02-b', { picture: { src: 'b.webp' } })),
    entry('whats-new-2026-10-03-c.json', tour('whats-new-2026-10-03-c')),
  ];
  const pictures = { 'whats-new-2026-10-02-b': { src: 'b.webp' } };
  const named = ['whats-new-2026-10-02-b', 'not-a-tour'];
  assert.deepEqual(tourPicturesWanted(entries, { pictures, named }).map(item => item.tour.id), ['whats-new-2026-10-02-b']);
});

test('a named tour whose file name is not a what-new name is still not taken', () => {
  const entries = [entry('other-2026-10-01.json', tour('whats-new-2026-10-01-a'))];
  assert.deepEqual(tourPicturesWanted(entries, { named: ['whats-new-2026-10-01-a'] }), []);
});

test('the input entries and pictures are not changed', () => {
  const entries = [entry('whats-new-2026-10-02-b.json', tour('whats-new-2026-10-02-b')), entry('whats-new-2026-10-01-a.json', tour('whats-new-2026-10-01-a'))];
  const pictures = { z: { src: 'z.webp' } };
  const before = JSON.stringify({ entries, pictures });
  tourPicturesWanted(entries, { pictures });
  picturesWith(pictures, 'a', { src: 'a.webp' });
  assert.equal(JSON.stringify({ entries, pictures }), before);
  assert.equal(entries[0].file, 'whats-new-2026-10-02-b.json');
});

test('the picture file is named by the tour id', () => {
  assert.equal(pictureFileOf({ id: 'whats-new-2026-10-02-live-work' }), 'whats-new-2026-10-02-live-work.webp');
});

test('shown step: the last step that points at something, else the last step', () => {
  const steps = [
    { id: 'a', target_ref: { query: '#x' } },
    { id: 'b' },
    { id: 'c', target_preparation: { surface: { id: 'files' } } },
    { id: 'd' },
  ];
  assert.equal(shownStepOf({ steps }).id, 'c');
  assert.equal(shownStepOf({ steps: [{ id: 'a' }, { id: 'b' }] }).id, 'b');
  assert.equal(shownStepOf({ steps: [{ id: 'a', target_ref: {} }, { id: 'b', target_ref: {} }] }).id, 'b');
  assert.equal(shownStepOf({ steps: [] }), null);
  assert.equal(shownStepOf({}), null);
});

test('shown step is the same step even when a step has a falsy target', () => {
  const steps = [{ id: 'a', target_ref: { query: '#x' } }, { id: 'b', target_ref: null, target_preparation: undefined }];
  assert.equal(shownStepOf({ steps }).id, 'a');
});

test('the pictures.json entry takes the step title and body as its alt, else the summary', () => {
  const t = tour('whats-new-2026-10-02-x', { summary: 'Sum.' });
  assert.deepEqual(pictureEntryOf(t, { content: { payload: { title: 'Head', body: 'Words.' } } }), {
    src: 'whats-new-2026-10-02-x.webp', alt: 'Head: Words.', width: PICTURE_WIDTH, height: PICTURE_HEIGHT,
  });
  assert.equal(pictureEntryOf(t, { content: { payload: { body: 'Only body.' } } }).alt, 'Only body.');
  assert.equal(pictureEntryOf(t, { content: {} }).alt, 'Sum.');
  assert.equal(pictureEntryOf(t, undefined).alt, 'Sum.');
  assert.deepEqual(pictureEntryOf(t, null, { width: 640, height: 400 }), { src: 'whats-new-2026-10-02-x.webp', alt: 'Sum.', width: 640, height: 400 });
});

test('picturesWith sets the entry and keeps keys in name order without changing the input', () => {
  const pictures = { 'whats-new-2026-10-05-b': { src: 'b.webp' }, 'whats-new-2026-10-01-a': { src: 'a.webp' } };
  const next = picturesWith(pictures, 'whats-new-2026-10-03-c', { src: 'c.webp' });
  assert.deepEqual(Object.keys(next), ['whats-new-2026-10-01-a', 'whats-new-2026-10-03-c', 'whats-new-2026-10-05-b']);
  assert.equal(next['whats-new-2026-10-03-c'].src, 'c.webp');
  assert.deepEqual(Object.keys(pictures), ['whats-new-2026-10-05-b', 'whats-new-2026-10-01-a']);
});

test('picturesWith replaces an existing entry for the same tour', () => {
  const next = picturesWith({ t: { src: 'old.webp' } }, 't', { src: 't.webp' });
  assert.deepEqual(next, { t: { src: 't.webp' } });
});

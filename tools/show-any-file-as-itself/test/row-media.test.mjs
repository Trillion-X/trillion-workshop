// Tests for a row's media source (web/row-media.mjs). The rows are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bodyOf, filesOf, mediaOf, sourceOf } from '../web/row-media.mjs';

test('a YouTube address with no type is the player\'s embed, and its address is the one the field holds', () => {
  const source = sourceOf({ playback_url: 'https://www.youtube-nocookie.com/embed/abc123' }, 'row:video');
  assert.equal(source.kind, 'media');
  assert.deepEqual(source.media, {
    id: 'row:video', label: '', mime_type: undefined, source_kind: 'youtube', embed_url: 'https://www.youtube-nocookie.com/embed/abc123', poster_url: undefined,
  });
});

test('a row\'s list of files is each of its sources in order, and an item with no address is left out', () => {
  const row = { resources: [{ url: 'https://files.example.test/a.pdf', mime_type: 'application/pdf', label: 'A' }, { label: 'no address' }, 'https://files.example.test/b.txt'] };
  assert.deepEqual(filesOf(row, 'resources').map(source => source.file.label), ['A', '']);
  assert.deepEqual(filesOf(row, 'resources')[1].file.url, 'https://files.example.test/b.txt');
  assert.deepEqual(filesOf(row, 'missing'), []);
  assert.deepEqual(filesOf({ resources: 'x' }, 'resources'), []);
});

test('a sound or video type is the player\'s, and a sound is a sound source', () => {
  assert.equal(sourceOf({ url: 'https://files.example.test/clip.mp4', mime_type: 'video/mp4' }, 'x').media.source_kind, 'video');
  assert.equal(sourceOf({ url: 'https://files.example.test/talk.m4a', mime_type: 'audio/mp4', label: 'Talk' }, 'x').media.label, 'Talk');
});

test('a PDF or any other type is the file viewer\'s, with its type and name', () => {
  assert.deepEqual(sourceOf({ url: 'https://files.example.test/book.pdf', mime_type: 'application/pdf', label: 'Book' }, 'x'), {
    kind: 'file', file: { url: 'https://files.example.test/book.pdf', contentType: 'application/pdf', label: 'Book' },
  });
  assert.deepEqual(sourceOf('https://files.example.test/notes.txt', 'x', 'notes.txt').file, { url: 'https://files.example.test/notes.txt', contentType: '', label: 'notes.txt' });
});

test('the address is the first of playback_url, url, embed_url, source_url; a value with none is no source', () => {
  assert.equal(sourceOf({ source_url: 'https://a.example.test/x.pdf', url: 'https://b.example.test/x.pdf' }, 'x').file.url, 'https://b.example.test/x.pdf');
  assert.equal(sourceOf({ mime_type: 'video/mp4' }, 'x'), null);
  assert.equal(sourceOf(42, 'x'), null);
  assert.equal(sourceOf(null, 'x'), null);
});

test('a row\'s media field is read by its name; a row without the field has no source', () => {
  const row = { title: 'Walk-through', clip: { url: 'https://files.example.test/clip.webm', mime_type: 'video/webm' } };
  assert.equal(mediaOf(row, 'clip', 'row:1').media.label, 'Walk-through');
  assert.equal(mediaOf(row, 'other', 'row:1'), null);
  assert.equal(mediaOf(row, undefined, 'row:1'), null);
  assert.equal(mediaOf(null, 'clip', 'row:1'), null);
});

test('the body is the text of the field it names, and empty when none is held', () => {
  assert.equal(bodyOf({ notes: 'Read first.' }, 'notes'), 'Read first.');
  assert.equal(bodyOf({ notes: 3 }, 'notes'), '');
  assert.equal(bodyOf({ notes: 'x' }, undefined), '');
});

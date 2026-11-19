// test/classify-ref.test.mjs
//
// How one ref is drawn (read-data/classify-ref.mjs): a picture, a video, a sound, or a web page by its text alone; any
// other scheme is unsupported, so the screen says so; an empty ref is an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRef } from '../read-data/classify-ref.mjs';

test('a picture, a video and a sound are drawn as themselves, whatever the case of the extension', () => {
  assert.deepEqual(classifyRef('shots/words-page.PNG'), { kind: 'image', src: 'shots/words-page.PNG' });
  assert.equal(classifyRef('https://cdn.example.com/a/b.jpeg?v=3').kind, 'image');
  assert.equal(classifyRef('clips/walk.mp4').kind, 'video');
  assert.equal(classifyRef('https://cdn.example.com/walk.webm#t=4').kind, 'video');
  assert.equal(classifyRef('audio/take-2.m4a').kind, 'audio');
});

test('an https address without a picture, video or sound extension is a web page in a frame', () => {
  assert.equal(classifyRef('https://example.com/articles/five-axioms').kind, 'page');
  assert.equal(classifyRef('https://example.com/report.pdf').kind, 'page');
  assert.equal(classifyRef('http://localhost:8777/index.html').kind, 'page');
  assert.equal(classifyRef('https://example.com/?file=movie.mp4').kind, 'page', 'a query string names no file');
});

test('a relative file the page is served beside is drawn by its extension', () => {
  assert.equal(classifyRef('files/notes.md').kind, 'page');
  assert.equal(classifyRef('files/school/cap.png').kind, 'image');
});

test('another scheme is unsupported and keeps its text as the source', () => {
  assert.deepEqual(classifyRef('files://task-things/cap.png'), { kind: 'unsupported', src: 'files://task-things/cap.png' });
  assert.equal(classifyRef('mailto:someone@example.com').kind, 'unsupported');
});

test('the ref is trimmed; an empty or non-text ref is an error, never a blank frame', () => {
  assert.equal(classifyRef('  https://example.com  ').src, 'https://example.com');
  assert.throws(() => classifyRef('   '), TypeError);
  assert.throws(() => classifyRef(undefined), TypeError);
});

// src/workspace/plain-preview.test.ts
//
// Run: node --test tools/messages-screen/web/src/workspace/plain-preview.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainPreview } from './plain-preview.ts';

test('quote markers come off, nested quotes too', () => {
  assert.equal(plainPreview('> > quoted line'), 'quoted line');
  assert.equal(plainPreview('> one\n> two'), 'one two');
});

test('heading and list markers come off', () => {
  assert.equal(plainPreview('## Title'), 'Title');
  assert.equal(plainPreview('- first\n* second\n+ third'), 'first second third');
  assert.equal(plainPreview('1. one\n2) two'), 'one two');
});

test('a link keeps its words and loses its address', () => {
  assert.equal(plainPreview('see [the doc](https://example.com/doc) now'), 'see the doc now');
  assert.equal(plainPreview('![a chart](https://example.com/c.png)'), 'a chart');
});

test('emphasis and code marks go, the words stay', () => {
  assert.equal(plainPreview('**bold** and *italic* and `code` and ~~gone~~'), 'bold and italic and code and gone');
});

test('underscores inside a word are kept, so a name is not cut', () => {
  assert.equal(plainPreview('snake_case_name stays_'), 'snake_case_name stays_');
});

test('blank lines are dropped and the lines join with a space', () => {
  assert.equal(plainPreview('first\n\n   \nsecond'), 'first second');
  assert.equal(plainPreview(''), '');
});

// tools/saved-examples/test/save-an-example.test.mjs
// save-an-example as a pure function (do-work/save-an-example.mjs). Ported from the old repository (commit b6ae0ebf815f):
// test/saved-examples.test.mjs (the first test's save assertions, and the output-contains-input check of the tool call),
// and test/native-account-action-mount.test.mjs (what the caller gives wins over what was kept). No store, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SaveAnExampleError,
  exampleIdOf,
  saveAnExampleOf,
  verifyOutputContainsInput,
} from '../do-work/save-an-example.mjs';

const card = url => ({
  url,
  final_url: url,
  host: 'instagram.com',
  site: 'Instagram',
  title: 'A reel that worked',
  description: 'The caption',
  images: ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg'],
});

const clock = () => {
  let time = Date.parse('2026-09-29T12:00:00Z');
  return () => new Date(time += 1000).toISOString();
};

test('a new example is filled from its card, with one id per post', () => {
  const { example, verified, differs } = saveAnExampleOf(
    { url: 'https://www.instagram.com/reel/abc/#top' },
    [],
    { card: card('https://www.instagram.com/reel/abc/'), now: clock() },
  );
  assert.equal(example.id, exampleIdOf('https://instagram.com/reel/abc'));
  assert.equal(example.url, 'https://www.instagram.com/reel/abc/');
  assert.equal(example.title, 'A reel that worked');
  assert.equal(example.words, 'The caption');
  assert.deepEqual(example.pictures, ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg']);
  assert.equal(example.why_it_worked, null);
  assert.equal(example.added_from, 'ai');
  assert.equal(verified, true);
  assert.deepEqual(differs, []);
});

test('saving the same post again fills in what was given and keeps what it had', () => {
  const now = clock();
  const first = saveAnExampleOf({ url: 'https://www.instagram.com/reel/abc/' }, [], {
    card: card('https://www.instagram.com/reel/abc/'),
    now,
  }).example;
  const rows = [{ type: 'saved-example', id: first.id, value: first }];
  const again = saveAnExampleOf(
    { url: 'https://instagram.com/reel/abc', why_it_worked: 'Opens on the result, then shows how.', added_from: 'person' },
    rows,
    { card: { title: 'Changed by the card', host: 'other.test' }, now },
  );
  assert.equal(again.example.id, first.id, 'the same post is the same example');
  assert.equal(again.example.why_it_worked, 'Opens on the result, then shows how.');
  assert.equal(again.example.title, 'A reel that worked', 'what was not given stays; a card is not read again');
  assert.equal(again.example.added_from, 'ai', 'where it first came from stays');
  assert.equal(again.example.added_at, first.added_at);
  assert.equal(again.example.url, first.url);
  assert.equal(again.verified, true);
});

test('what the caller gives wins over what was kept before, and the rest stays', () => {
  const earlier = { id: 'earlier', url: 'https://example.test/proof', title: 'Earlier title', added_at: '2026-10-14T00:00:00Z' };
  const { example, verified } = saveAnExampleOf(
    { url: 'https://example.test/proof', title: 'Actual title', words: 'Given source words', why_it_worked: 'Concrete detail', pictures: [] },
    [{ type: 'saved-example', id: 'earlier', value: earlier }],
    { now: clock() },
  );
  assert.equal(example.title, 'Actual title');
  assert.equal(example.id, 'earlier');
  assert.equal(example.added_at, '2026-10-14T00:00:00Z');
  assert.deepEqual(example.pictures, []);
  assert.equal(verified, true);
});

test('a removed example is not matched, so the same address is saved new', () => {
  const removed = { id: exampleIdOf('https://example.com/post'), url: 'https://example.com/post', removed_at: '2026-10-01T00:00:00Z' };
  const { example } = saveAnExampleOf({ url: 'https://example.com/post' }, [{ type: 'saved-example', id: removed.id, value: removed }], { now: clock() });
  assert.equal(example.id, exampleIdOf('https://example.com/post'));
  assert.equal(example.added_at, '2026-09-29T12:00:01.000Z');
});

test('an id held by another address gets a distinct id, never a shared one', () => {
  const addressId = exampleIdOf('https://example.com/a');
  const other = { id: addressId, url: 'https://example.com/b' };
  const { example, verified } = saveAnExampleOf({ url: 'https://example.com/a' }, [{ type: 'saved-example', id: addressId, value: other }], { now: clock() });
  assert.notEqual(example.id, addressId);
  assert.match(example.id, /^example:[0-9a-f]{32}$/);
  assert.equal(verified, true);
});

test('a refused input says why and makes no record', () => {
  assert.throws(() => saveAnExampleOf({ url: 'ftp://example.com/x' }), /http or https/);
  assert.throws(() => saveAnExampleOf({ url: 'not a link' }), SaveAnExampleError);
  assert.throws(() => saveAnExampleOf({ url: 'https://example.com/x', pictures: 'one' }), /pictures is a list/);
  assert.throws(() => saveAnExampleOf({ url: 'https://example.com/x', why_it_worked: 3 }), /why_it_worked is text/);
  assert.throws(() => saveAnExampleOf(null), /Give \{ url \}/);
  assert.throws(() => saveAnExampleOf({ url: 'https://example.com/x' }, 'not rows'), /list of saved-example records/);
});

test('the output must contain each input field that was given', () => {
  const input = { url: 'https://example.com/post', title: 'Mine', why_it_worked: 'Result first.' };
  const { example, verified } = saveAnExampleOf(input, [], { now: clock() });
  assert.equal(verified, true);
  assert.deepEqual(verifyOutputContainsInput(input, example), []);
  assert.deepEqual(verifyOutputContainsInput(input, { ...example, title: 'Changed' }), ['title']);
  const dropped = { ...example };
  delete dropped.why_it_worked;
  assert.deepEqual(verifyOutputContainsInput(input, dropped), ['why_it_worked']);
  assert.deepEqual(verifyOutputContainsInput(input, { ...example, url: 'https://example.com/other' }), ['url']);
  assert.deepEqual(verifyOutputContainsInput({ url: 'https://example.com/post', title: '   ' }, example), [], 'an empty field was not given');
});

test('the input and the caller rows are not changed', () => {
  const input = { url: 'https://example.com/post', pictures: ['https://cdn.test/p.png'], title: ' Mine ' };
  const rows = [{ type: 'saved-example', id: 'example:x', value: { id: 'example:x', url: 'https://example.com/other', title: 'Other' } }];
  const before = structuredClone({ input, rows });
  saveAnExampleOf(input, rows, { now: clock() });
  assert.deepEqual({ input, rows }, before);
});

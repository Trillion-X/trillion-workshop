// The Saved examples page's routes (tool:answer-the-saved-examples-page), ported with old trillion's tests at tag
// old-trillion-before-worker-retire: test/saved-examples.test.mjs (one example per post, filled from the link itself
// and from whatever the caller knows, removed on request) and test/native-saved-example-browser-routes.test.mjs (the
// page's routes and any AI reach the same examples, with their original identity). The owner runs over a memory store
// first, then the row runs as the container runs it, against the fake records door with exactly its rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { exampleId, handleSavedExamplesRequest, makeSavedExamples } from '../do-work/answer-the-saved-examples-page.mjs';

const card = url => ({ url, final_url: url, host: 'instagram.com', site: 'Instagram', title: 'A reel that worked', description: 'The caption', image: 'https://cdn.test/1.jpg', images: ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg'], videos: [], icon: null, data: [], text: 'Page words', unread: null });

function memory(values = new Map()) {
  let reads = 0;
  let time = Date.parse('2026-09-29T12:00:00Z');
  const examples = makeSavedExamples({
    store: { list: () => [...values.values()], put: (id, value) => values.set(id, value) },
    readLink: async url => { reads += 1; return card(url); },
    now: () => new Date(time += 1000).toISOString(),
  });
  return { examples, values, reads: () => reads };
}

test('an example is filled from its link, saved once per post, and filled in again without losing what it had', async () => {
  const { examples, reads } = memory();
  const first = await examples.save({ url: 'https://www.instagram.com/reel/abc/#top' });
  assert.equal(first.id, exampleId('https://instagram.com/reel/abc'));
  assert.equal(first.url, 'https://www.instagram.com/reel/abc/');
  assert.equal(first.title, 'A reel that worked');
  assert.equal(first.words, 'The caption');
  assert.deepEqual(first.pictures, ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg']);
  assert.equal(first.why_it_worked, null);
  assert.equal(first.added_from, 'ai');

  const again = await examples.save({ url: 'https://instagram.com/reel/abc', why_it_worked: 'Opens on the result, then shows how.', added_from: 'person' });
  assert.equal(again.id, first.id, 'the same post is the same example');
  assert.equal(again.why_it_worked, 'Opens on the result, then shows how.');
  assert.equal(again.title, 'A reel that worked', 'what was not given stays');
  assert.equal(again.added_from, 'ai', 'where it first came from stays');
  assert.equal(reads(), 1, 'the link is read only the first time');

  const second = await examples.save({ url: 'https://example.com/post', title: 'Mine', words: 'Given words', pictures: ['https://cdn.test/p.png'] });
  assert.equal(second.words, 'Given words');
  assert.deepEqual(second.pictures, ['https://cdn.test/p.png']);
  assert.deepEqual(examples.list().examples.map(example => example.id), [second.id, first.id], 'newest first');
  assert.equal(examples.list().count, 2);

  assert.deepEqual(examples.remove({ id: first.id }), { id: first.id, removed: true });
  assert.deepEqual(examples.list().examples.map(example => example.id), [second.id]);
  assert.throws(() => examples.remove({ id: first.id }), /no saved example/);
  await assert.rejects(examples.save({ url: 'ftp://example.com/x' }), /http or https/);
  await assert.rejects(examples.save({ url: 'https://example.com/x', pictures: 'one' }), /pictures is a list/);
  await assert.rejects(examples.save({ url: 'https://example.com/x', why_it_worked: 3 }), /why_it_worked is text/);
});

test('nondefault ports identify distinct posts while retained legacy examples keep their identity and provenance', async () => {
  assert.equal(exampleId('https://www.example.test:443/post/#top'), exampleId('https://example.test/post'));
  assert.equal(exampleId('http://example.test:80/post'), exampleId('http://example.test/post/'));
  assert.notEqual(exampleId('https://example.test:8443/post'), exampleId('https://example.test:9443/post'));
  const legacyId = exampleId('https://example.test/post');
  const legacy = { id: legacyId, url: 'https://example.test:8443/post', title: 'Original', words: 'Retained words', added_from: 'person', added_at: '2026-09-01T00:00:00Z' };
  const values = new Map([[legacyId, legacy]]);
  const { examples, reads } = memory(values);
  const other = await examples.save({ url: 'https://example.test:9443/post', title: 'Other port' });
  assert.notEqual(other.id, legacyId);
  assert.deepEqual(values.get(legacyId), legacy);
  const updated = await examples.save({ url: 'https://www.example.test:8443/post/#fragment', why_it_worked: 'Useful opening' });
  assert.equal(updated.id, legacyId);
  assert.equal(updated.url, legacy.url);
  assert.equal(updated.words, legacy.words);
  assert.equal(updated.added_from, 'person');
  assert.equal(updated.added_at, legacy.added_at);
  assert.equal(reads(), 1);
  const plain = await examples.save({ url: 'https://example.test/post', title: 'Default port' });
  assert.notEqual(plain.id, other.id);
  assert.equal(examples.list().count, 3);
});

// Saving and removing are each one write, committed with the answer they give (the command's receipt).
test('saving and removing an example write only inside their commit, answered by what they kept', async () => {
  const values = new Map(), committed = [];
  let open = false;
  const examples = makeSavedExamples({
    store: { list: () => [...values.values()], put: (id, value) => { assert.ok(open, 'a write happens inside its commit'); values.set(id, value); } },
    readLink: async () => null, now: () => '2026-10-17T00:00:00Z',
    commit: (change, { operation }) => { open = true; try { const answer = change(); committed.push([operation, answer]); return answer; } finally { open = false; } },
  });
  const saved = await examples.save({ url: 'https://example.com/post', title: 'A post' });
  const removed = examples.remove({ id: saved.id });
  assert.deepEqual(committed, [['saved-examples:save', saved], ['saved-examples:remove', removed]]);
});

test('the handler answers as the old route: unknown spellings are 404, a refused save is 400 and keeps nothing', async () => {
  const { examples, values } = memory();
  const call = async (path, init) => { const response = await handleSavedExamplesRequest(examples, new Request(`https://person${path}`, init)); return { status: response.status, body: await response.json() }; };
  assert.deepEqual(await call('/saved-examples/remove'), { status: 404, body: { error: 'Not found' } });
  const refused = await call('/saved-examples', { method: 'POST', body: JSON.stringify({ url: 'not a link' }) });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /url must be a web address/);
  assert.equal(values.size, 0);
  assert.deepEqual(await call('/saved-examples', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/x', words: 'x'.repeat(200_001) }) }), { status: 400, body: { error: 'Request too large' } });
});

const row = rowOf(rows, 'tool:answer-the-saved-examples-page');
const route = (path, method, body = {}) => ({ path, method, query: {}, body, browser: { user_agent: 'sample', origin: 'https://app.example', visitor: 'visitor-sample' } });

test('the page and any AI reach the same saved-example records, with the original identity kept and removal written', async () => {
  const saved = await answerOf(row, route('/saved-examples', 'POST', { url: 'https://example.test/post', words: 'Supplied source words', why_it_worked: 'One concrete detail', pictures: [], added_from: 'browser' }));
  assert.equal(saved.status, 0, saved.error);
  assert.equal(saved.result.status, 200, JSON.stringify(saved.result));
  const example = saved.result.body;
  assert.equal(example.words, 'Supplied source words');
  assert.equal(example.added_from, 'browser');
  assert.equal(example.id, exampleId('https://example.test/post'));
  assert.deepEqual(saved.kept, [{ id: example.id, type: 'saved-example', value: example }]);

  const kept = saved.kept;
  const updated = await answerOf(row, route('/saved-examples', 'POST', { url: 'https://www.example.test/post/', title: 'Current title' }), { records: kept });
  assert.equal(updated.result.body.id, example.id);
  assert.equal(updated.result.body.words, example.words);
  assert.equal(updated.result.body.added_at, example.added_at);
  assert.equal(updated.result.body.added_from, 'browser');
  assert.equal(updated.unanswered?.length ?? 0, 0, 'a kept example is not read from its link again');

  const listed = await answerOf(row, route('/saved-examples', 'GET'), { records: updated.kept });
  assert.equal(listed.result.status, 200);
  assert.equal(listed.result.body.count, 1);
  assert.equal(listed.result.body.examples[0].title, 'Current title');

  const invalid = await answerOf(row, route('/saved-examples', 'POST', { url: 'file:///private/file.txt', title: 'Must not overwrite' }), { records: updated.kept });
  assert.equal(invalid.result.status, 400);
  assert.deepEqual(invalid.kept, updated.kept);

  const removed = await answerOf(row, route('/saved-examples/remove', 'POST', { id: example.id }), { records: updated.kept });
  assert.deepEqual(removed.result, { status: 200, body: { id: example.id, removed: true } });
  assert.deepEqual(removed.kept, []);
  const again = await answerOf(row, route('/saved-examples/remove', 'POST', { id: example.id }));
  assert.equal(again.result.status, 400);
  assert.match(again.result.body.error, /There is no saved example/);
});

test('the route row reads and writes only saved examples, and reaches the internet only to read a link', () => {
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'saved-example', operations: ['records:list', 'records:write'] }]);
  assert.equal(row.invoke.internet, true);
  assert.equal(row.needs.network_egress, true);
});

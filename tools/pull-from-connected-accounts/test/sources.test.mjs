import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSource, problemsWith, sourceIds } from '../read-data/sources.mjs';

const folder = join(import.meta.dirname, '..', 'read-data', 'sources');

test('the sources shipped are the seven services and each can be pulled', () => {
  assert.deepEqual(sourceIds(), ['discord', 'instagram-messages', 'messenger-messages', 'pinterest-pins', 'slack', 'telegram', 'x-bookmarks']);
  for (const id of sourceIds()) assert.deepEqual(problemsWith(loadSource(id)), [], id);
});

test('every source reaches a public https address and no source holds a token, a person or a path on a computer', () => {
  for (const id of sourceIds()) {
    const text = readFileSync(join(folder, `${id}.json`), 'utf8');
    const source = loadSource(id);
    assert.match(source.base, /^https:\/\/[a-z.]+(\/|$)/, id);
    assert.doesNotMatch(text, /\/Users\/|\/home\//, id);
    assert.doesNotMatch(text, /@[a-z0-9-]+\.[a-z]{2,}|bearer [a-z0-9]{8,}|xox[bp]-|bitfield|trillion/i, id);
  }
});

test('Messenger extends the Instagram description and changes only what it says', () => {
  const instagram = loadSource('instagram-messages');
  const messenger = loadSource('messenger-messages');
  assert.deepEqual(messenger.walks, instagram.walks);
  assert.equal(messenger.vars.platform, 'messenger');
  assert.equal(instagram.vars.platform, 'instagram');
  assert.notEqual(messenger.base, instagram.base);
  assert.equal(messenger.id, 'messenger-messages');
});

test('a description that cannot be pulled says what is missing, and an unknown source names the ones there are', () => {
  assert.ok(problemsWith({ id: 'x', base: 'http://insecure.example/', identity: { path: '/me' }, walks: [] }).length >= 3);
  assert.deepEqual(problemsWith({ id: 'x', base: 'https://a.example', identity: { path: '/me', self_id: '/id' }, walks: [{ name: 'w', levels: [{ path: '/a' }], fold: { layout: 'items', into: 'things', key: ['/id'] } }] }), []);
  assert.throws(() => loadSource('nope'), /There is no source called nope; the sources are discord/);
  assert.throws(() => loadSource('../etc'), /There is no source called/);
});

// The member feed's parsers, on made-up posts. Carried from the original feed test (seven groups): parsing and newest-first
// order, operator versus member styling from the data, the records wrapper, dropping a non-post, relative time, the
// monogram, and empty input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostModels, monogram, recordList, relativeTime } from '../read-data/feed-selectors.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const posts = [
  { kind: 'community-post', id: 'welcome', title: 'Welcome', body: 'You are in.', author: 'Harbor Circle', created_at: '2026-08-01' },
  { kind: 'community-post', id: 'this-week', title: 'This week', body: 'Focus on foundations.', author: 'Harbor Circle', created_at: '2026-08-04' },
  { kind: 'community-post', id: 'm1', title: '', body: 'my first win', author: 'Maya Lindqvist', author_role: 'member', member_ref: 'member:maya', created_at: '2026-08-05' },
];

test('parses every post, newest first', () => {
  const models = buildPostModels(posts, NOW);
  assert.equal(models.length, 3);
  assert.equal(models[0].id, 'm1');
  assert.equal(models[2].id, 'welcome');
});

test('operator and member styling come from the data: no member_ref means the operator wrote it', () => {
  const models = buildPostModels(posts, NOW);
  assert.equal(models.find((x) => x.id === 'welcome').isOperator, true);
  assert.equal(models.find((x) => x.id === 'm1').isOperator, false);
});

test('reads the records wrapper and drops anything that is not a community post', () => {
  assert.equal(buildPostModels({ records: posts }, NOW).length, 3);
  assert.equal(buildPostModels([{ kind: 'offer', id: 'x' }, ...posts], NOW).length, 3);
});

test('relative time reads today, yesterday, days and weeks, and the date after that', () => {
  assert.equal(relativeTime('2026-08-05', NOW), 'today');
  assert.equal(relativeTime('2026-08-04', NOW), 'yesterday');
  assert.equal(relativeTime('2026-08-01', NOW), '4d ago');
  assert.equal(relativeTime('2026-07-01', NOW), '2026-07-01');
  assert.equal(relativeTime('2026-08-01'), '2026-08-01');
});

test('the monogram is the initials of the first two words, else the first two letters', () => {
  assert.equal(monogram('Harbor Circle'), 'HC');
  assert.equal(monogram('Maya'), 'MA');
  assert.equal(monogram(''), '?');
});

test('empty and malformed input gives no posts', () => {
  assert.equal(buildPostModels(undefined, NOW).length, 0);
  assert.equal(buildPostModels(null, NOW).length, 0);
  assert.equal(recordList('nonsense').length, 0);
});

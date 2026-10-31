// tools/what-is-waiting-on-me/test/waiting.test.mjs
//
// Every source, record and word here is made up; the tool knows none of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { whatIsWaitingOnMe } from '../read-data/waiting.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload).find(payload => payload.id === 'tool:what-is-waiting-on-me');
const sources = [
  { id: 'drafts', label: 'Drafts to approve', where: [{ field: 'state', equals: 'ready' }], title: '{headline}', detail: 'for {place}', opens: 'draft/{slug}', at: 'ready_at' },
  { id: 'asks', label: 'Questions', where: [{ field: 'answered', absent: true }, { field: 'kind', in: ['choose', 'confirm'] }], title: '{question.text}', at: 'asked_at', most: 2 },
  { id: 'sign-ins', label: 'Sign-ins', where: [{ field: 'needs_code', present: true }], title: 'Sign in to {site}' },
];
const found = {
  drafts: [
    { id: 'd1', value: { state: 'ready', headline: 'Fresh loaves', place: 'the shop page', slug: 'fresh-loaves', ready_at: '2026-01-02T09:00:00Z' } },
    { id: 'd2', value: { state: 'draft', headline: 'Not ready yet', ready_at: '2026-01-03T09:00:00Z' } },
    { id: 'd3', value: { state: 'ready', headline: '', ready_at: '2026-01-04T09:00:00Z' } },
  ],
  asks: [
    { id: 'a1', value: { kind: 'choose', question: { text: 'Which crust?' }, asked_at: '2026-01-05T09:00:00Z' } },
    { id: 'a2', value: { kind: 'confirm', question: { text: 'Go ahead?' }, asked_at: '2026-01-01T09:00:00Z' } },
    { id: 'a3', value: { kind: 'choose', question: { text: 'Third?' }, asked_at: '2025-12-01T09:00:00Z' } },
    { id: 'a4', value: { kind: 'choose', answered: 'yes', question: { text: 'Done' }, asked_at: '2026-01-06T09:00:00Z' } },
    { id: 'a5', value: { kind: 'other', question: { text: 'Other kind' } } },
  ],
};

test('records that wait become cards, newest first, with their own words, and a blank card is skipped and counted', () => {
  const answer = whatIsWaitingOnMe({ sources, found });
  assert.deepEqual(answer.cards.map(card => card.id), ['a1', 'd1', 'a2']);
  assert.deepEqual(answer.cards[1], { source: 'drafts', label: 'Drafts to approve', id: 'd1', title: 'Fresh loaves', detail: 'for the shop page', opens: 'draft/fresh-loaves', at: '2026-01-02T09:00:00Z' });
  assert.deepEqual(answer.sources.find(source => source.id === 'drafts'), { id: 'drafts', label: 'Drafts to approve', waiting: 1, skipped: 1, unread: false });
});

test('a source with no records handed in is unread, never nothing waiting, and the sentence says so', () => {
  const answer = whatIsWaitingOnMe({ sources, found });
  assert.equal(answer.sources.find(source => source.id === 'sign-ins').unread, true);
  assert.equal(answer.said, '3 things are waiting on you. Not read: Sign-ins.');
  const all = whatIsWaitingOnMe({ sources, found: { ...found, 'sign-ins': [] } });
  assert.equal(all.sources.find(source => source.id === 'sign-ins').unread, false);
  assert.equal(all.said, '3 things are waiting on you.');
});

test('most keeps a source to its newest few while its count still says how many wait', () => {
  const answer = whatIsWaitingOnMe({ sources: [sources[1]], found });
  assert.deepEqual(answer.cards.map(card => card.id), ['a1', 'a2']);
  assert.equal(answer.sources[0].waiting, 3);
});

test('a present test, one card and no cards each say their own sentence, and words can be overridden', () => {
  const one = whatIsWaitingOnMe({ sources: [sources[2]], found: { 'sign-ins': [{ id: 's1', value: { needs_code: '1', site: 'the shop' } }, { id: 's2', value: { site: 'other' } }] } });
  assert.deepEqual([one.count, one.cards[0].title, one.said], [1, 'Sign in to the shop', '1 thing is waiting on you.']);
  const none = whatIsWaitingOnMe({ sources: [sources[2]], found: { 'sign-ins': [] } });
  assert.equal(none.said, 'Nothing is waiting on you.');
  assert.equal(whatIsWaitingOnMe({ sources: [sources[2]], found: { 'sign-ins': [] }, words: { none: 'All clear.' } }).said, 'All clear.');
});

test('the same input gives the same answer in any record order', () => {
  const reversed = { ...found, drafts: [...found.drafts].reverse(), asks: [...found.asks].reverse() };
  assert.deepEqual(whatIsWaitingOnMe({ sources, found: reversed }), whatIsWaitingOnMe({ sources, found }));
});

test('a request that is not plainly shaped is refused', () => {
  assert.throws(() => whatIsWaitingOnMe(null), /Send an object/);
  assert.throws(() => whatIsWaitingOnMe({ sources: [], found }), /sources is a list/);
  assert.throws(() => whatIsWaitingOnMe({ sources: [{ label: 'x', title: 't' }], found }), /needs an id/);
  assert.throws(() => whatIsWaitingOnMe({ sources: [{ id: 'x' }], found }), /needs a title template/);
  assert.throws(() => whatIsWaitingOnMe({ sources: [{ id: 'x', title: 't', where: [{ field: 'a', equals: 1, absent: true }] }], found }), /one of equals, in, present or absent/);
  assert.throws(() => whatIsWaitingOnMe({ sources: [{ id: 'x', title: 't', most: 0 }], found }), /most is a whole number/);
  assert.throws(() => whatIsWaitingOnMe({ sources: [{ id: 'x', title: 't' }, { id: 'x', title: 'u' }], found }), /Two sources are called x/);
});

test('the row packs what the tool reads and runs its own sample', () => {
  assert.deepEqual(row.invoke.files.package_files.paths, ['do-work', 'read-data']);
  assert.equal(row.invoke.records, undefined, 'the caller reads the records; the tool holds no right');
  assert.equal(whatIsWaitingOnMe(row.verify[0].input).count, 1);
});

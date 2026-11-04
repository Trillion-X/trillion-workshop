// tools/review-what-a-list-says/test/rows-needing-review.test.mjs
// findRowsNeedingReview: the review views set_up saves on a list, read over rows handed in, answer each owner's rows
// with why (not verified, past the check-again date, empty), as rowsNeedingReview words them.
import test from 'node:test';
import assert from 'node:assert/strict';
import data from '../read-data/lists.json' with { type: 'json' };
import { findRowsNeedingReview } from '../do-work/review-a-list.mjs';
import { reviewRows } from '../read-data/list-review.mjs';

// The list as set_up leaves it: the moved reviewRows over one list record kept in memory.
async function setUpList() {
  let kept = { id: 'docs', title_field: 'title', fields: [{ id: 'title', label: 'Title', kind: 'text' }], views: [] };
  const lists = { find: async id => (id === kept.id ? kept : null), save: async list => { kept = { ...kept, ...list }; return kept; } };
  await reviewRows(lists, 'docs', { action: 'set_up' });
  return kept;
}

const rows = [
  { id: 'a', title: 'Onboarding', values: { title: 'Onboarding', owner: 'sam', review_state: 'Verified', review_due: '2027-01-01T00:00:00.000Z' } },
  { id: 'b', title: 'Pricing', values: { title: 'Pricing', owner: 'sam', review_state: 'Verified', review_due: '2026-10-01T00:00:00.000Z' } },
  { id: 'c', title: 'Refunds', values: { title: 'Refunds', owner: 'kim', review_state: 'Outdated' } },
  { id: 'd', title: '', values: { title: '', owner: 'kim' } },
];

test('each owner gets the rows that need review, with every reason a review view gives', async () => {
  const list = await setUpList();
  assert.deepEqual(list.views.map(view => view.id), data.review.views.map(view => view.id));
  const answer = await findRowsNeedingReview({ list, rows, now: '2026-11-04T00:00:00.000Z' });
  assert.equal(answer.complete, true);
  const byOwner = Object.fromEntries(answer.owners.map(({ owner, rows: found }) => [owner, found]));
  assert.deepEqual(byOwner.sam, [{ id: 'b', title: 'Pricing', reasons: ['expired'] }]);
  assert.deepEqual(byOwner.kim, [{ id: 'c', title: 'Refunds', reasons: ['not_verified'] }, { id: 'd', title: '', reasons: ['not_verified', 'empty'] }]);
});

test('owner narrows to one owner, and a later now makes a current review expire', async () => {
  const list = await setUpList();
  const sam = await findRowsNeedingReview({ list, rows, owner: 'sam', now: '2027-02-01T00:00:00.000Z' });
  assert.deepEqual(sam.owners, [{ owner: 'sam', rows: [{ id: 'a', title: 'Onboarding', reasons: ['expired'] }, { id: 'b', title: 'Pricing', reasons: ['expired'] }] }]);
});

test('a list that was never set up for review is refused in words', async () => {
  const list = { id: 'plain', title_field: 'title', fields: [{ id: 'title', kind: 'text' }] };
  await assert.rejects(findRowsNeedingReview({ list, rows: [] }), error => typeof error.message === 'string' && error.message.length > 0);
  await assert.rejects(findRowsNeedingReview({ list: { id: 'docs' }, rows: [] }), /Send list/);
});

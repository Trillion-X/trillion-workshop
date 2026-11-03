// tools/field-values: which offered value each field of made-up company rows keeps, and why the others lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleValues } from '../do-work/requests.mjs';

const offer = (row, field, value, kind, extra = {}) => ({ row, field, value, source: { kind, ...extra } });
const cellOf = (answer, row, field) => answer.cells.find(cell => cell.row === row && cell.field === field);

test('a person beats a rule, a rule beats a source, a source beats an AI, whatever their times and confidences', () => {
  const answer = settleValues({ offers: [
    offer('c1', 'size', '51-200', 'ai', { by: 'guesser', at: '2026-07-05T12:00:00Z', confidence: 0.99 }),
    offer('c1', 'size', '11-50', 'source', { by: 'directory-a', at: '2026-07-05T11:00:00Z' }),
    offer('c1', 'size', '1-10', 'person', { by: 'owner', at: '2026-07-01T09:00:00Z' }),
    offer('c1', 'size', '201-500', 'rule', { by: 'big-buyers', at: '2026-07-05T12:30:00Z' }),
  ] });
  const cell = cellOf(answer, 'c1', 'size');
  assert.equal(cell.value, '1-10');
  assert.deepEqual(cell.set_by, { kind: 'person', by: 'owner', at: '2026-07-01T09:00:00Z' });
  assert.deepEqual(cell.outranked.map(item => [item.value, item.why]), [
    ['201-500', 'a weaker kind of source than person'],
    ['11-50', 'a weaker kind of source than person'],
    ['51-200', 'a weaker kind of source than person'],
  ]);
});

test('inside one kind the newest offer wins, then the most confident; a true tie with different values is contested', () => {
  const answer = settleValues({ offers: [
    offer('c2', 'domain', 'old.example', 'source', { by: 'directory-a', at: '2026-06-01T00:00:00Z' }),
    offer('c2', 'domain', 'new.example', 'source', { by: 'directory-b', at: '2026-07-01T00:00:00Z' }),
    offer('c3', 'domain', 'low.example', 'source', { by: 'directory-a', at: '2026-07-01T00:00:00Z', confidence: 'low' }),
    offer('c3', 'domain', 'high.example', 'source', { by: 'directory-b', at: '2026-07-01T00:00:00Z', confidence: 'high' }),
    offer('c4', 'domain', 'one.example', 'source', { by: 'directory-a' }),
    offer('c4', 'domain', 'two.example', 'source', { by: 'directory-b' }),
  ] });
  assert.equal(cellOf(answer, 'c2', 'domain').value, 'new.example');
  assert.equal(cellOf(answer, 'c2', 'domain').outranked[0].why, 'older than the winning offer of the same kind');
  assert.equal(cellOf(answer, 'c3', 'domain').value, 'high.example');
  assert.equal(cellOf(answer, 'c3', 'domain').outranked[0].why, 'less confident than the winning offer of the same kind');
  assert.deepEqual([cellOf(answer, 'c4', 'domain').value, cellOf(answer, 'c4', 'domain').contested], ['one.example', true]);
  assert.equal(answer.counts.contested, 1);
});

test('an AI offer below its kind\'s confidence floor never wins; its reasoning and citations ride with the value that does', () => {
  const basis = { reasoning: 'the site lists three bakeries', citations: ['https://example.com/about'] };
  const answer = settleValues({ offers: [
    { ...offer('c5', 'industry', 'Retail', 'ai', { by: 'guesser', confidence: 0.3 }) },
    { ...offer('c5', 'industry', 'Food', 'ai', { by: 'reader', confidence: 'high' }), basis },
  ] });
  const cell = cellOf(answer, 'c5', 'industry');
  assert.deepEqual([cell.value, cell.set_by.basis], ['Food', basis]);
  assert.deepEqual(cell.set_aside.map(item => [item.value, item.why]), [['Retail', 'below the confidence of at least 0.5 that ai needs']]);
  const none = settleValues({ offers: [offer('c6', 'industry', 'Retail', 'ai', { confidence: 0.1 })] });
  assert.deepEqual([cellOf(none, 'c6', 'industry').value, cellOf(none, 'c6', 'industry').set_by, none.counts.settled], [null, null, 0]);
});

test('a person withdrawing their value lets the field fall back to the next source, and as_of answers what it held then', () => {
  const offers = [
    offer('c7', 'stage', 'Lead', 'rule', { by: 'new-rows', at: '2026-07-01T00:00:00Z' }),
    offer('c7', 'stage', 'Customer', 'person', { by: 'owner', at: '2026-07-03T00:00:00Z' }),
    { row: 'c7', field: 'stage', withdraws: true, source: { kind: 'person', by: 'owner', at: '2026-07-05T00:00:00Z' } },
  ];
  const now = cellOf(settleValues({ offers }), 'c7', 'stage');
  assert.equal(now.value, 'Lead');
  assert.deepEqual(now.set_aside.map(item => [item.value, item.why]), [['Customer', 'withdrawn by person owner']]);
  assert.equal(cellOf(settleValues({ offers, as_of: '2026-07-04T00:00:00Z' }), 'c7', 'stage').value, 'Customer');
  assert.equal(cellOf(settleValues({ offers, as_of: '2026-07-02T00:00:00Z' }), 'c7', 'stage').value, 'Lead');
});

test('the person\'s own precedence replaces the default, and an unknown kind holds or yields as it says', () => {
  const precedence = { kinds: [{ id: 'crm-sync' }, { id: 'person' }], same_kind_order: ['newest'], unknown_source: 'yields', confidence_words: {} };
  const answer = settleValues({ precedence, offers: [
    offer('c8', 'owner', 'Ann', 'person'), offer('c8', 'owner', 'Bea', 'crm-sync'), offer('c8', 'owner', 'Cy', 'mystery'),
  ] });
  assert.equal(cellOf(answer, 'c8', 'owner').value, 'Bea');
  assert.equal(cellOf(answer, 'c8', 'owner').outranked.at(-1).value, 'Cy');
  const holds = settleValues({ offers: [offer('c9', 'owner', 'Ann', 'person'), offer('c9', 'owner', 'Cy', 'mystery')] });
  assert.equal(cellOf(holds, 'c9', 'owner').value, 'Cy');
});

test('requests that cannot be settled are refused with a sentence saying what to send', () => {
  assert.throws(() => settleValues({}), /offers must be a list/);
  assert.throws(() => settleValues({ offers: [{ row: 'r', field: 'f', source: { kind: 'person' } }] }), /needs a value, or withdraws/);
  assert.throws(() => settleValues({ offers: [{ row: 'r', field: 'f', value: 1 }] }), /needs a source/);
  assert.throws(() => settleValues({ offers: [offer('r', 'f', 1, 'person', { at: 'yesterday' })] }), /source.at must be a date/);
  assert.throws(() => settleValues({ offers: [], as_of: 'soon' }), /as_of must be a date/);
  assert.throws(() => settleValues({ offers: [], precedence: { kinds: [] } }), /precedence must be/);
});

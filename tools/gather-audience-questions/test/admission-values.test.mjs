// The admission functions take the caller's store as values: { records, source }, where `records` reads and writes the
// account's typed records and `source` reads, lists and writes the account's source rows. Here both are in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admitCurrentAudienceQuestion, keepObservedAudienceQuestion, reviewObservedAudienceQuestion } from '../src/audience-question-admission.mjs';

function memoryStore() {
  const records = new Map(), sources = new Map();
  const store = {
    records: {
      read: types => [...records.values()].filter(row => types.includes(row.type)).map(row => structuredClone(row.value)),
      write: rows => { for (const row of rows) records.set(`${row.type}|${row.id}`, { type: row.type, id: row.id, value: structuredClone(row.value) }); },
    },
    source: {
      read: id => structuredClone(sources.get(id)?.value ?? null),
      ids: type => [...sources].filter(([, row]) => row.type === type).map(([id]) => id),
      write: rows => { for (const row of rows) sources.set(row.id, { type: row.type, value: structuredClone(row.value) }); },
    },
  };
  return { store, sources };
}
const observed = (id, role, extra) => ({ id, role, venture_ref: 'venture:shop', source_url: `https://shop.example/${role}`,
  observed_at: new Date().toISOString(), quote: extra.quote, ...(extra.offer_ref ? { offer_ref: extra.offer_ref } : {}) });

test('a question kept from an observed quote, an accepted review with its evidence, then one admitted work item', () => {
  const { store, sources } = memoryStore();
  store.source.write([
    { id: 'audience-source:q', type: 'audience-source', value: observed('audience-source:q', 'question', { quote: 'How much is it?', offer_ref: 'offer:shop' }) },
    { id: 'audience-source:a', type: 'audience-source', value: observed('audience-source:a', 'answer', { quote: 'It costs 49 a month.' }) },
    { id: 'audience-source:r', type: 'audience-source', value: observed('audience-source:r', 'rights', { quote: 'Quote allowed.' }) },
  ]);
  const kept = keepObservedAudienceQuestion(store, 'audience-source:q', {});
  assert.equal(kept.kept, true);
  const review = reviewObservedAudienceQuestion(store, { candidate_id: kept.candidate.id, verdict: 'accepted',
    answer_source_id: 'audience-source:a', rights_source_id: 'audience-source:r', answer_note: 'Price answer.', rights_note: 'Quoted with credit.' });
  assert.equal(review.reviewed, true);
  const admitted = admitCurrentAudienceQuestion(store, kept.candidate.id);
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.work.state, 'pending_draft');
  assert.equal(admitted.work.question, 'How much is it?');
  assert.equal(admitted.work.grounding.length, 1);
  assert.equal(admitted.work.grounding[0].excerpt, 'It costs 49 a month.');
  assert.equal(admitCurrentAudienceQuestion(store, kept.candidate.id).reason, 'work_already_exists');
  assert.ok(sources.has('audience-source:a'));
});

test('a rejected review admits nothing, and a candidate with no review is not admitted', () => {
  const { store } = memoryStore();
  store.source.write([{ id: 'audience-source:q', type: 'audience-source', value: observed('audience-source:q', 'question', { quote: 'Do you ship?', offer_ref: 'offer:shop' }) }]);
  const kept = keepObservedAudienceQuestion(store, 'audience-source:q', {});
  assert.equal(admitCurrentAudienceQuestion(store, kept.candidate.id).reason, 'current_review_missing_or_conflicting');
  reviewObservedAudienceQuestion(store, { candidate_id: kept.candidate.id, verdict: 'rejected', reason: 'Not our question.' });
  assert.equal(admitCurrentAudienceQuestion(store, kept.candidate.id).admitted, false);
});

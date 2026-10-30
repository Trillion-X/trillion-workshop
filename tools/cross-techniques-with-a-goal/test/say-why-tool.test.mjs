// tools/cross-techniques-with-a-goal: tool:say-why-a-technique-works end to end with a scripted writer and hand-made
// vectors: the writer is shown each row's words and nearest existing terms, its terms go through admission, and the
// answer carries the rows' fields, the writer's own proposal and the grown vocabulary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unit } from '../do-work/meaning.mjs';
import { sayWhyATechniqueWorks } from '../do-work/say-why-a-technique-works.mjs';

const meaning = { model: 'fixture-meaning', dims: 3, forms: { query: '{text}', document: '{text}' } };
const vectors = {
  'a figure the reader takes for themselves': unit([1, 0, 0]),
  'how much a person feels something is about them': unit([0, 1, 0]),
  'a reader who has the problem': unit([0, 0.9, 0.1]),
};
const embed = {
  meaning,
  texts: async texts => texts.map(text => vectors[text] ?? unit([0.2, 0.2, 1])),
};

test('rows get their crossing fields, the proposal is kept, and a new vocabulary grows from the measured lines', async () => {
  const shown = [];
  const write = async ({ name, user }) => {
    assert.equal(name, 'technique_why');
    shown.push(user);
    return { rows: user.rows.map(row => ({
      id: row.id,
      mechanism: [{ term: 'fixture-mirror', says: 'a figure the reader takes for themselves' }],
      operates_on: [{ term: 'fixture-self-relevance', says: 'how much a person feels something is about them' }],
      needs: ['a reader who has the problem'],
      produces: ['the reader feels addressed'],
      from_medium: 'fixture medium',
    })) };
  };
  const vocabulary = { kind: 'technique-vocabulary', meaning, vocabularies: { mechanism: { says: 'why', reuse_at: 0.9, new_below: 0.5, terms: [] }, property: { says: 'what', reuse_at: 0.9, new_below: 0.5, terms: [] } } };
  const answer = await sayWhyATechniqueWorks({ rows: [{ id: 'fixture-row', name: 'Mirror figure', description: 'A figure the viewer reads as themselves.' }], vocabulary, models: { write, embed } });
  assert.match(shown[0].rows[0].text, /^name: Mirror figure \| description: /);
  assert.deepEqual(shown[0].rows[0].existing, { mechanism: [], property: [] });
  const [row] = answer.rows;
  assert.deepEqual([row.mechanism, row.operates_on, row.from_medium], [['fixture-mirror'], ['fixture-self-relevance'], 'fixture medium']);
  assert.deepEqual(row.needs, [{ says: 'a reader who has the problem', property: 'fixture-self-relevance' }]);
  assert.equal(row.proposed.mechanism[0].term, 'fixture-mirror');
  assert.deepEqual(answer.vocabulary.vocabularies.mechanism.terms.map(entry => entry.term), ['fixture-mirror']);
  assert.deepEqual(answer.unread, []);
});

test('a request without rows or ids is refused with what to send', async () => {
  await assert.rejects(sayWhyATechniqueWorks({ rows: [{ name: 'no id' }], models: {} }), /each with an id/);
});

test('the row shape comes with the request: its own fields first, its own fields skipped, unknown reading keys refused', async () => {
  const shown = [];
  const write = async ({ user }) => {
    shown.push(user);
    return { rows: user.rows.map(row => ({ id: row.id, mechanism: [], operates_on: [], needs: [], produces: [], from_medium: 'fixture medium' })) };
  };
  const vocabulary = { kind: 'technique-vocabulary', meaning, vocabularies: { mechanism: { says: 'why', reuse_at: 0.9, new_below: 0.5, terms: [] }, property: { says: 'what', reuse_at: 0.9, new_below: 0.5, terms: [] } } };
  const row = { id: 'fixture-row', title: 'Fixture title', summary: 'Fixture summary.', private_note: 'not for the writer' };
  await sayWhyATechniqueWorks({ rows: [row], vocabulary, reading: { first: ['summary'], skip: ['id', 'private_note'] }, models: { write, embed } });
  assert.equal(shown[0].rows[0].text, 'summary: Fixture summary. | title: Fixture title');
  await assert.rejects(sayWhyATechniqueWorks({ rows: [row], vocabulary, reading: { firsts: ['summary'] }, models: { write, embed } }), /reading takes only .*not firsts/);
});

// tools/cross-techniques-with-a-goal: the vocabulary's admission rule and the settling fold, with hand-made vectors so
// every closeness is known: do-work/vocabulary.mjs admit, do-work/say-why.mjs makeSettler, recordedJudge and rowText.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unit } from '../do-work/meaning.mjs';
import { admit, emptyLexicon, findTerm, withoutProvisional } from '../do-work/vocabulary.mjs';
import { makeSettler, recordedJudge, rowText } from '../do-work/say-why.mjs';

const conventions = JSON.parse(readFileSync(new URL('../do-work/technique-conventions.json', import.meta.url), 'utf8'));
const meaning = { model: 'fixture-meaning', dims: 3, forms: { query: '{text}', document: '{text}' } };
const lines = { reuse_at: 0.9, new_below: 0.5 };
const at = degrees => unit([Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180), 0]);
const away = unit([0, 0, 1]);

// An embedder over a table of known texts; a text it was not given is a test failure, never a guess.
const tableEmbed = table => ({
  meaning,
  texts: async texts => texts.map(text => {
    assert.ok(table[text], `the fixture has a vector for "${text}"`);
    return table[text];
  }),
});

const fresh = () => {
  const lexicon = emptyLexicon(meaning, conventions.vocabularies, lines);
  lexicon.vocabularies.mechanism.terms.push({ term: 'fixture-loop', says: 'a question left open holds attention', aliases: [], from: 'seed', vector: at(0) });
  return lexicon;
};
const never = async () => assert.fail('the judge is not asked outside the uncertain band');

test('the same words, or an alias, are the same term without a vector', async () => {
  const vocabulary = fresh().vocabularies.mechanism;
  assert.deepEqual(await admit(vocabulary, { term: 'Fixture Loop' }, null, never), { term: 'fixture-loop', how: 'same-words' });
});

test('a proposal at least reuse_at close joins the term and becomes its alias', async () => {
  const vocabulary = fresh().vocabularies.mechanism;
  const outcome = await admit(vocabulary, { term: 'fixture-gap', says: 'x' }, at(20), never);
  assert.deepEqual([outcome.term, outcome.how], ['fixture-loop', 'same-meaning']);
  assert.equal(findTerm(vocabulary, 'fixture gap').term, 'fixture-loop');
  assert.equal(vocabulary.terms.length, 1);
});

test('in the band the judge decides; with no answer yet the proposal is a provisional term', async () => {
  const band = at(50); // cos 50 degrees = 0.643, between new_below and reuse_at
  const same = fresh().vocabularies.mechanism;
  const judged = await admit(same, { term: 'fixture-near', says: 'x' }, band, async ({ candidates }) => candidates[0].term);
  assert.deepEqual([judged.term, judged.how], ['fixture-loop', 'judged-same']);
  const other = fresh().vocabularies.mechanism;
  const coined = await admit(other, { term: 'fixture-near', says: 'x', from: 'r1' }, band, async () => '');
  assert.deepEqual([coined.term, coined.how, other.terms.length], ['fixture-near', 'judged-new', 2]);
  const waiting = fresh().vocabularies.mechanism;
  const held = await admit(waiting, { term: 'fixture-near' }, band, async () => undefined);
  assert.deepEqual([held.how, held.provisional], ['waiting', true]);
  assert.deepEqual([waiting.terms.length, waiting.terms[1].provisional, withoutProvisional(waiting).terms.length], [2, true, 1]);
  const later = await admit(waiting, { term: 'Fixture Near' }, null, never);
  assert.deepEqual([later.how, later.provisional], ['same-words', true]);
});

test('below new_below a proposal is a new term without asking', async () => {
  const vocabulary = fresh().vocabularies.mechanism;
  const outcome = await admit(vocabulary, { term: 'fixture-far', says: 'x', from: 'r2' }, away, never);
  assert.deepEqual([outcome.term, outcome.how], ['fixture-far', 'new']);
  assert.equal(vocabulary.terms[1].from, 'r2');
});

test('a fold gives two rows coining one idea one term, tags needs, and holds a row waiting on a judgment', async () => {
  const lexicon = fresh();
  lexicon.vocabularies.property.terms.push({ term: 'fixture-attention', says: 'how long a person keeps looking', aliases: [], from: 'seed', vector: at(90) });
  const table = {
    'withheld answer': at(5), 'unanswered question': at(10), 'two sides compared': at(50),
    'how long they look': at(92), 'a viewer who has stopped': at(95), 'fixture-mirror-row': away,
  };
  const proposal = (mechanism, need) => ({
    mechanism: [{ term: mechanism[0], says: mechanism[1] }],
    operates_on: [{ term: 'fixture-attention', says: '' }],
    needs: [need],
    produces: ['keeps reading '],
    from_medium: 'fixture medium',
  });
  const recorded = recordedJudge([]);
  const settle = makeSettler({ lexicon, conventions, embed: tableEmbed(table), judge: recorded.judge });
  const result = await settle([
    { id: 'a', proposed: proposal(['fixture-curiosity', 'withheld answer'], 'a viewer who has stopped') },
    { id: 'b', proposed: proposal(['fixture-open-question', 'unanswered question'], 'fixture-mirror-row') },
    { id: 'c', proposed: proposal(['fixture-contrast', 'two sides compared'], 'a viewer who has stopped') },
  ]);
  assert.deepEqual(result.rows.map(row => [row.id, row.mechanism]), [['a', ['fixture-loop']], ['b', ['fixture-loop']]]);
  assert.deepEqual(result.rows[0].needs, [{ says: 'a viewer who has stopped', property: 'fixture-attention' }]);
  assert.deepEqual(result.rows[1].needs, [{ says: 'fixture-mirror-row', property: null }]);
  assert.deepEqual(result.rows[0].produces, ['keeps reading']);
  assert.deepEqual(result.waiting, ['c']);
  assert.deepEqual(recorded.waiting.map(item => [item.vocabulary, item.term, item.candidates[0].term]), [['mechanism', 'fixture-contrast', 'fixture-loop']]);
  assert.deepEqual(findTerm(lexicon.vocabularies.mechanism, 'fixture-curiosity').aliases, ['fixture-curiosity', 'fixture-open-question']);
});

test('a recorded judgment settles the waiting row the next time the fold runs', async () => {
  const lexicon = fresh();
  const embed = tableEmbed({ 'two sides compared': at(50) });
  const { judge } = recordedJudge([{ vocabulary: 'mechanism', term: 'fixture-contrast', chosen: '', among: ['fixture-loop'] }]);
  const result = await makeSettler({ lexicon, conventions, embed, judge })([{ id: 'c', proposed: { mechanism: [{ term: 'fixture-contrast', says: 'two sides compared' }], operates_on: [], needs: [], produces: [], from_medium: 'fixture' } }]);
  assert.deepEqual(result.rows[0].mechanism, ['fixture-contrast']);
  assert.equal(lexicon.vocabularies.mechanism.terms.length, 2);
});

test('"none of them" stops holding once a term it was not judged against becomes a candidate', async () => {
  const lexicon = fresh();
  lexicon.vocabularies.mechanism.terms.push({ term: 'fixture-pace', says: 'a steady beat', aliases: [], from: 'r0', vector: at(100) });
  const recorded = recordedJudge([{ vocabulary: 'mechanism', term: 'fixture-rhythm', chosen: '', among: ['fixture-loop'] }]);
  const embed = tableEmbed({ 'a regular beat': at(55) });
  const result = await makeSettler({ lexicon, conventions, embed, judge: recorded.judge })([{ id: 'r', proposed: { mechanism: [{ term: 'fixture-rhythm', says: 'a regular beat' }], operates_on: [], needs: [], produces: [], from_medium: 'fixture' } }]);
  assert.deepEqual(result.waiting, ['r']);
  assert.deepEqual(recorded.waiting[0].candidates.map(item => item.term), ['fixture-pace', 'fixture-loop']);
});

test('a row that reuses another row\'s waiting term is held too, and the waiting term is judged once', async () => {
  const lexicon = fresh();
  const recorded = recordedJudge([]);
  const embed = tableEmbed({ 'two sides compared': at(50) });
  const proposed = { mechanism: [{ term: 'fixture-contrast', says: 'two sides compared' }], operates_on: [], needs: [], produces: [], from_medium: 'fixture' };
  const result = await makeSettler({ lexicon, conventions, embed, judge: recorded.judge })([{ id: 'c', proposed }, { id: 'd', proposed }]);
  assert.deepEqual([result.rows, result.waiting, recorded.waiting.length], [[], ['c', 'd'], 1]);
});

test('a term coined with no words takes the definition another proposal gave it', async () => {
  const lexicon = fresh();
  const embed = tableEmbed({ 'how heavy a motion feels': away });
  const row = says => ({ mechanism: [], operates_on: [{ term: 'fixture-weight', says }], needs: [], produces: [], from_medium: 'fixture' });
  await makeSettler({ lexicon, conventions, embed, judge: never })([{ id: 'a', proposed: row('') }, { id: 'b', proposed: row('how heavy a motion feels') }]);
  assert.equal(findTerm(lexicon.vocabularies.property, 'fixture-weight').says, 'how heavy a motion feels');
});

test('rowText reads the first fields in order, skips listed fields and web addresses, and clips', () => {
  const reading = { first: ['name', 'description'], skip: ['id', 'source_url'], max_chars: 12, row_max_chars: 80 };
  const text = rowText({ id: 'x', source_url: 'https://example.org', notes: ['https://example.org/a', 'kept words'], description: 'a long description here', name: 'Fixture' }, reading);
  assert.equal(text, 'name: Fixture | description: a long desc… | notes: kept words');
});

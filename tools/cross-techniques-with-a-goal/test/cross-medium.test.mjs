// tools/cross-techniques-with-a-goal: crossing 20 technique rows found in four media with a goal in a fifth, replayed
// from what the writer model really answered (fixtures/cross-medium-cassette.json, recorded by record-cassette.mjs),
// and the exact joins (candidatesFor, techniquesFor, pairsOf) on their own. Nothing here names a medium in code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boundFields } from '../do-work/vocabulary.mjs';
import { candidatesFor, crossTechniquesWithAGoal, pairsOf, techniquesFor } from '../do-work/cross.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const conventions = read('../do-work/technique-conventions.json');
const fixture = read('./fixtures/cross-medium.json');
const cassette = read('./fixtures/cross-medium-cassette.json');
const [why, changes] = boundFields(conventions.bound);

// A writer that answers only what was recorded: a call the recording never saw fails the test.
const write = async ({ name }) => {
  assert.ok(cassette.written[name], `the cassette holds the writer's answer to ${name}; re-record it with record-cassette.mjs`);
  return cassette.written[name];
};
const run = () => crossTechniquesWithAGoal({ ...fixture.request, rows: fixture.rows, vocabulary: fixture.vocabulary, models: { write } }, conventions);
const mediumOf = new Map(fixture.rows.map(row => [row.id, row.from_medium]));

test('the fixture spans four media and the goal is in none of them', () => {
  const media = new Set(fixture.rows.map(row => row.from_medium));
  assert.equal(fixture.rows.length, 20);
  assert.equal(media.size, 4);
  assert.ok(!media.has(fixture.request.goal_medium), 'the goal is in a fifth medium');
});

test('the self-insertion row surfaces for the goal through its mechanism, from another medium', async () => {
  const answer = await run();
  const found = answer.techniques.find(technique => technique.id === fixture.expect.surfaces);
  assert.ok(found, `${fixture.expect.surfaces} is among ${answer.techniques.map(technique => technique.id).join(', ')}`);
  assert.equal(found.serves.through, fixture.expect.through);
  assert.notEqual(found.from_medium, fixture.request.goal_medium);
  assert.ok(found.adaptation.length > 10, 'the writer adapted it to the goal in one line');
});

test('answers come from at least three media and several mechanisms, each serving a stated want through a wanted property', async () => {
  const answer = await run();
  assert.ok(new Set(answer.techniques.map(technique => mediumOf.get(technique.id))).size >= 3);
  assert.ok(new Set(answer.techniques.map(technique => technique.serves.through)).size >= 3);
  for (const technique of answer.techniques) {
    const want = answer.wants.find(item => item.says === technique.serves.want);
    assert.ok(want, `${technique.id} serves a stated want`);
    assert.ok(technique.serves.properties.length && technique.serves.properties.every(term => want.properties.includes(term)));
  }
  assert.equal(answer.lines.length, answer.techniques.length + answer.pairs.length);
});

test('candidates are joined exactly through properties and ordered by how many media their mechanism spans', () => {
  const property = fixture.rows[0][changes.field][0];
  const candidates = candidatesFor([property], fixture.rows, { why, changes }, 50);
  const holding = fixture.rows.filter(row => row[changes.field].includes(property));
  assert.deepEqual(new Set(candidates.map(item => item.term)), new Set(holding.flatMap(row => row[why.field])));
  for (let index = 1; index < candidates.length; index += 1) assert.ok(candidates[index - 1].media >= candidates[index].media);
  assert.deepEqual(candidatesFor(['fixture:no-such-property'], fixture.rows, { why, changes }, 50), []);
});

test('a picked mechanism\'s techniques spread over media before repeating one', () => {
  const byMechanism = new Map();
  for (const row of fixture.rows) for (const term of row[why.field]) byMechanism.set(term, [...(byMechanism.get(term) ?? []), row]);
  const [mechanism, holding] = [...byMechanism].find(([, rows]) => new Set(rows.map(row => row.from_medium)).size >= 2);
  const want = { says: 'fixture want', properties: [...new Set(holding.flatMap(row => row[changes.field]))] };
  const chosen = techniquesFor([{ want, mechanism }], fixture.rows, { why, changes }, { per_mechanism: 2, techniques: 10 });
  assert.equal(chosen.length, 2);
  assert.notEqual(chosen[0].row.from_medium, chosen[1].row.from_medium);
});

test('a "prepares" pair joins one row\'s change to the other row\'s need', () => {
  const tagged = conventions.bound.needs_tagged_by;
  const needing = fixture.rows.find(row => row.needs.some(need => need[tagged]
    && fixture.rows.some(other => other.id !== row.id && other[changes.field].includes(need[tagged]))));
  assert.ok(needing, 'the fixture holds a row whose need another row changes');
  const need = needing.needs.find(item => item[tagged] && fixture.rows.some(other => other.id !== needing.id && other[changes.field].includes(item[tagged])));
  const giver = fixture.rows.find(row => row.id !== needing.id && row[changes.field].includes(need[tagged]));
  const want = { says: 'fixture want', properties: [need[tagged]] };
  const pairs = pairsOf([{ row: giver, want, mechanism: 'fixture:first' }, { row: needing, want, mechanism: 'fixture:then' }], { changes }, tagged, 6);
  const pair = pairs.find(item => item.first === giver.id && item.then === needing.id);
  assert.equal(pair?.how, 'prepares', JSON.stringify(pairs));
  assert.ok(giver[changes.field].some(term => pair.because.includes(`changes ${term}`)), pair.because);
});

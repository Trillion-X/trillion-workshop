// A hand step that writes out a shared block again is pointed at the block (recipe-problems.mjs recipeBlockRepeats), and
// refused by recipeProblems when the caller gives the person's blocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeBlockRepeats, recipeProblems, sharedBlocks, stepWords } from '../read-data/recipe-problems.mjs';

const LOOK = "Speak to the store in its own language, with the login under its credential_name, and read its own description of what it holds. Submit where the receipts are already kept (kept_in, or null) and the names of the objects that already keep them.";
const block = {
  recipe: 'workflow:read-what-a-store-holds',
  job: 'Read what a store already holds for a subject.',
  definition: { stands_for: [LOOK], steps: [{ id: 'objects', kind: 'ask', config: { name: 'tool:run-sql-in-my-database', input: { sql: 'SELECT 1' } } }], edges: [] },
};
const blocks = sharedBlocks([block, { recipe: 'workflow:no-block', definition: { steps: [] } }]);

const ask = (id, words, name = 'anyone') => ({ id, kind: 'ask', config: { name, input: { do: words, submit: { type: 'object' } }, context: { handoff: 'whoever answers' } } });
const recipe = steps => ({ id: 'workflow:keep-some-records', job: 'Keep some records.', definition: { steps, edges: steps.slice(1).map((step, i) => ({ from: steps[i].id, to: step.id, kind: 'always' })) } });

test('a row is a block only when its definition lists the words it stands for', () => {
  assert.deepEqual(blocks.map(item => item.id), ['workflow:read-what-a-store-holds']);
  assert.equal(blocks[0].openings.length, 1);
});

test('copies that differ only in quoted words, ids and numbers read as the same words', () => {
  const a = stepWords('Run "the first" step with tool:run-sql-in-my-database 3 times on `x`.');
  const b = stepWords('Run "a second one" step with tool:other-tool 12 times on `y`.');
  assert.deepEqual(a, b);
});

test('each written-out copy of the block is pointed at it, whatever subject its last words name', () => {
  for (const words of [
    LOOK,
    'Speak to the store in its own language, with the login under its credential_name, and read its own description of what it holds. Submit kept_in (where the spaces are kept, or null) and objects.',
    'Speak to the store in its own language, with the login under its credential_name, and read what it holds about the index.',
  ]) {
    const repeats = recipeBlockRepeats(recipe([ask('look', words), ask('keep', 'Keep the record the caller gives and read it back.')]), { blocks });
    assert.equal(repeats.length, 1, words);
    assert.match(repeats[0], /definition\.steps\.look writes out workflow:read-what-a-store-holds again/);
    assert.match(repeats[0], /"definition_id": "workflow:read-what-a-store-holds"/);
  }
});

test('recipeProblems refuses the copy only when given the blocks, so every caller that gives none is unchanged', () => {
  const copied = recipe([ask('look', LOOK)]);
  assert.deepEqual(recipeProblems(copied), []);
  assert.deepEqual(recipeProblems(copied, undefined, { blocks: [] }), []);
  const refused = recipeProblems(copied, undefined, { blocks });
  assert.equal(refused.length, 1);
  assert.match(refused[0], /workflow:read-what-a-store-holds/);
});

test('a step that already runs something, a block itself, and short words are never pointed at a block', () => {
  const runs = recipe([
    ask('sql', LOOK, 'tool:run-sql-in-my-database'),
    { id: 'uses', kind: 'action', config: { definition_id: 'workflow:read-what-a-store-holds', inputs: {}, do: LOOK } },
    ask('short', 'Speak to the store in its own language.'),
    ask('other', 'Write the stated number of versions of the one piece at once, each one different.'),
  ]);
  assert.deepEqual(recipeBlockRepeats(runs, { blocks }), []);
  assert.deepEqual(recipeBlockRepeats({ ...block, id: block.recipe, definition: { ...block.definition, steps: [ask('look', LOOK)] } }, { blocks }), []);
});

test('a recipe written as steps rows is checked the same way, its tool rows left alone', () => {
  const rows = { id: 'workflow:keep-some-records', job: 'Keep some records.', steps: [
    { id: 'look', do: LOOK, submit: { type: 'object' } },
    { id: 'read', do: LOOK, submit: { type: 'object' }, run_tool: { tool_id: 'tool:run-sql-in-my-database' } },
  ] };
  const repeats = recipeBlockRepeats(rows, { blocks });
  assert.equal(repeats.length, 1);
  assert.match(repeats[0], /^steps\.look /);
});

test('a block whose copies open like other steps names how many words tell them apart', () => {
  const facts = 'Call tool:run-sql-in-my-database with { credential_name: input.business.credential_name, sql: "SELECT facts FROM setup", params: [] }. Keep the returned facts object ({} when no row comes back) and say whether it holds every field.';
  const other = 'Call tool:run-sql-in-my-database with { credential_name: input.business.credential_name, sql: "SELECT id FROM library", params: [] }. If rows come back, submit covered true and the row ids.';
  const longer = sharedBlocks([{ recipe: 'workflow:read-the-setup-facts', definition: { stands_for: [facts], stands_for_words: 20 } }]);
  assert.equal(longer[0].words, 20);
  assert.equal(recipeBlockRepeats(recipe([ask('read-facts', facts.replace('SELECT facts FROM setup', 'SELECT more FROM setup'))]), { blocks: longer }).length, 1);
  assert.deepEqual(recipeBlockRepeats(recipe([ask('read-library', other)]), { blocks: longer }), []);
  assert.equal(recipeBlockRepeats(recipe([ask('read-library', other)]), { blocks: sharedBlocks([{ recipe: 'workflow:read-the-setup-facts', definition: { stands_for: [facts] } }]) }).length, 1);
});

test('a new block is found from its row alone', () => {
  const more = sharedBlocks([block, { recipe: 'workflow:read-the-setup-facts', definition: { stands_for: ['Call tool:run-sql-in-my-database with { credential_name: input.business.credential_name, sql: "SELECT facts FROM setup" }. Keep the returned facts object and say whether it holds every field.'] } }]);
  const repeats = recipeBlockRepeats(recipe([ask('read-facts', 'Call tool:run-sql-in-my-database with { credential_name: input.business.credential_name, sql: "SELECT other FROM setup" }. Keep the facts.')]), { blocks: more });
  assert.equal(repeats.length, 1);
  assert.match(repeats[0], /workflow:read-the-setup-facts/);
});

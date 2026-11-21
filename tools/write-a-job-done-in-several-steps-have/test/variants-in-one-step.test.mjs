// A step with variants (read-data/variants.mjs) compiled by definitionOf and run on the workflow engine (the built wasm),
// its rows kept by the SQL it carries in a real Postgres (PGlite) answering as tool:run-sql-in-my-database does. The
// recipes and tools are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { runAWorkflow } from '../read-data/run-a-workflow.mjs';
import { definitionOf, recipeProblems } from '../read-data/workflows.mjs';

const counted = { $kind: 'binding', select: { from: 'steps', key: 'answer', path: 'output.words' }, transform: [{ op: 'op:core.array_length' }] };
const twoWords = { kind: 'distinct-at-least', says: 'At least two different words', path: ['this', 'words', '*'], count: 2 };
const made = n => ({ tool_id: 'tool:made-up-words', input: { n } });
const step = (fields = {}) => ({
  id: 'words', do: 'Find words for the seed.', submit: { type: 'object' }, mode: 'all', keep_in: 'made_up_for_who_runs_it',
  measure: { binding: counted, best: 'max' }, checks: [twoWords],
  variants: [{ id: 'three', run_tool: made(3) }, { id: 'one', run_tool: made(1) }, { id: 'asked', do: 'Give words yourself.' }],
  ...fields,
});
const recipe = (first = step(), rest = [{ id: 'use', do: 'Use the words.', submit: { type: 'object' } }]) => ({ id: 'workflow:made-up-words', job: 'Find words.', steps: [first, ...rest] });
const answers = { 'words#asked': { words: ['a', 'b', 'c', 'd'] } };

/** A host whose SQL tool runs in `db` and whose made-up tool answers n words (n of 0 fails as a provider would). */
function hostOver(db) {
  const asked = [];
  return {
    asked,
    async run(name, input) {
      asked.push(name);
      if (name === 'tool:run-sql-in-my-database') {
        const result = await db.query(input.sql, input.params ?? []);
        return { columns: result.fields.map(field => field.name), rows: result.rows, row_count: result.affectedRows ?? result.rows.length };
      }
      if (name === 'tool:made-up-words' && input.n === 0) throw Object.assign(new Error('the provider answered 500'), { outcome: 'committed' });
      if (name === 'tool:made-up-words') return { words: Array.from({ length: input.n }, (_, index) => `w${index}-${'x'.repeat(input.pad ?? 0)}`) };
      throw new Error(`no tool ${name}`);
    },
  };
}
const shape = definition => definition.steps.map(each => `${each.kind} ${each.id}`);

test('a step with variants in mode all compiles to make-the-table, a parallel loop, compare, keep and the winner', () => {
  const definition = definitionOf(recipe());
  assert.deepEqual(shape(definition), ['ask words#table', 'loop words#each', 'return words#compare', 'ask words#keep', 'return words', 'fail words#none', 'ask use']);
  const loop = definition.steps.find(each => each.id === 'words#each').config;
  assert.equal(loop.parallel, true);
  assert.equal(loop.tolerate_item_errors, true, 'one variant failing never stops the others');
  assert.deepEqual(loop.source, { $kind: 'binding', select: { from: 'literal', value: ['three', 'one', 'asked'] } });
  assert.deepEqual(loop.definition_refs, ['words#three', 'words#one', 'words#asked']);
  assert.deepEqual(definition.uses.map(used => used.id), ['words#three', 'words#one', 'words#asked']);
  assert.deepEqual(shape(definition.uses[2]), ['ask words#asked', 'return words#asked#checks', 'return words#asked#wrong', 'return words#asked#refused', 'return words#asked#done', 'return words#asked#broke']);
  assert.equal(definition.uses[2].steps[0].config.input.do, 'Give words yourself.');
  assert.deepEqual(definition.uses[2].steps[0].config.input.submit, { type: 'object' }, 'a variant with no submit takes the step\'s');
  assert.equal(definition.uses[0].steps[0].config.name, 'tool:made-up-words');
  for (const ask of ['words#table', 'words#keep']) assert.equal(definition.steps.find(each => each.id === ask).config.name, 'tool:run-sql-in-my-database');
  assert.deepEqual(definition.edges.filter(edge => edge.to === 'use').map(edge => edge.from), ['words']);
  assert.deepEqual(recipeProblems(recipe()), []);
});

test('mode split adds the tally, the leader and the choice before the loop, which runs only the chosen', () => {
  const definition = definitionOf(recipe(step({ mode: 'split', split: { explore_share: 0.5 } })));
  assert.deepEqual(shape(definition).slice(0, 5), ['ask words#table', 'ask words#tally', 'return words#lead', 'return words#choose', 'loop words#each']);
  const tally = definition.steps.find(each => each.id === 'words#tally').config.input;
  assert.deepEqual(tally.params, ['workflow:made-up-words', 'words', ['three', 'one', 'asked']]);
  assert.deepEqual(definition.steps.find(each => each.id === 'words#each').config.source, { $kind: 'binding', select: { from: 'steps', key: 'words#choose', path: 'output.chosen' } });
  assert.match(JSON.stringify(definition.steps.find(each => each.id === 'words#choose')), /"value":0\.5/, 'the step\'s own explore share');
  assert.deepEqual(recipeProblems(recipe(step({ mode: 'split' }))), []);
});

test('every variant runs, the one breaking its check is recorded failed with the rule, and the best measure wins', async () => {
  const db = new PGlite();
  const host = hostOver(db);
  const { run } = await runAWorkflow({ recipe: recipe(), answers }, host);
  assert.equal(run.status, 'paused');
  const compare = run.execution_context.steps['words#compare'].output;
  assert.deepEqual(compare.variants.map(({ variant, status, checks_passed, measure }) => [variant, status, checks_passed, measure]), [
    ['three', 'completed', true, 3], ['one', 'failed', false, null], ['asked', 'completed', true, 4],
  ]);
  assert.match(compare.variants[1].failed_check, /At least two different words/);
  assert.equal(compare.winner, 'asked');
  assert.deepEqual(run.execution_context.steps.words.output, { words: ['a', 'b', 'c', 'd'] }, 'the step itself answers the winner\'s whole answer');
  assert.deepEqual(run.waiting.map(wait => wait.step_id), ['use']);
});

test('a variant whose tool fails is recorded as an error and the others still run', async () => {
  const db = new PGlite();
  const failing = step({ variants: [{ id: 'broken', run_tool: made(0) }, { id: 'three', run_tool: made(3) }] });
  const { run } = await runAWorkflow({ recipe: recipe(failing) }, hostOver(db));
  const compare = run.execution_context.steps['words#compare'].output;
  assert.deepEqual(compare.variants.map(({ variant, status }) => [variant, status]), [['broken', 'error'], ['three', 'completed']]);
  assert.match(compare.variants[0].failed_check, /the provider answered 500/);
  assert.equal(compare.winner, 'three');
});

test('one variant_results row is kept per variant per run, in the database the step names', async () => {
  const db = new PGlite();
  const host = hostOver(db);
  await runAWorkflow({ recipe: recipe(), answers }, host);
  await runAWorkflow({ recipe: recipe(), input: { run_id: 'run-two' }, answers }, host);
  const { rows } = await db.query('SELECT workflow, step, variant, run, measure, cost, tokens, checks_passed, failed_check IS NOT NULL AS has_failed_check FROM variant_results ORDER BY run = $1, variant', ['run-two']);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.slice(3).map(row => [row.workflow, row.step, row.variant, row.run, row.measure, row.checks_passed, row.has_failed_check]), [
    ['workflow:made-up-words', 'words', 'asked', 'run-two', 4, true, false],
    ['workflow:made-up-words', 'words', 'one', 'run-two', null, false, true],
    ['workflow:made-up-words', 'words', 'three', 'run-two', 3, true, false],
  ]);
  assert.equal(new Set(rows.slice(0, 3).map(row => row.run)).size, 1, 'a run with no run_id gets one id for all its rows');
  assert.ok(rows.every(row => row.cost === null && row.tokens === null), 'cost and tokens are unknown while the engine gives none');
  const keepAsk = definitionOf(recipe()).steps.find(each => each.id === 'words#keep').config.input;
  assert.equal(keepAsk.database, 'made_up_for_who_runs_it');
});

test('split runs every variant until each has min_runs, then leans on the leader and explores at the set share beside it', async () => {
  const db = new PGlite();
  const host = hostOver(db);
  const split = recipe(step({ mode: 'split', split: { explore_share: 0.2, min_runs: 2 } }));
  const chosen = [];
  for (let index = 0; index < 10; index += 1) {
    const { run } = await runAWorkflow({ recipe: split, answers }, host);
    chosen.push(run.execution_context.steps['words#choose'].output.chosen.join('+'));
  }
  // Runs 1-2 warm every variant up; "asked" leads (all its runs passed, mean 4 words); runs 5 and 10 explore (0.2 of the
  // runs), each time beside the leader the other variant with the fewest runs ("three" passes with 3 words, "one" always
  // fails its check), so an exploring run still has the leader's answer.
  assert.deepEqual(chosen, ['three+one+asked', 'three+one+asked', 'asked', 'asked', 'asked+three', 'asked', 'asked', 'asked', 'asked', 'asked+one']);
  const { rows } = await db.query('SELECT variant, count(*)::int AS runs FROM variant_results GROUP BY variant ORDER BY variant');
  assert.deepEqual(rows, [{ variant: 'asked', runs: 10 }, { variant: 'one', runs: 3 }, { variant: 'three', runs: 3 }]);
});

test('with ten variants giving large answers, the compare answer stays small and the winner\'s answer passes on whole', async () => {
  const db = new PGlite();
  const host = hostOver(db);
  const ten = step({ checks: [], variants: Array.from({ length: 10 }, (_, index) => ({ id: `v${index}`, run_tool: { tool_id: 'tool:made-up-words', input: { n: 20 + index, pad: 400 } } })) });
  const { run } = await runAWorkflow({ recipe: recipe(ten) }, host);
  const compare = run.execution_context.steps['words#compare'].output;
  assert.equal(compare.variants.length, 10);
  assert.equal(compare.winner, 'v9');
  const size = JSON.stringify(compare).length;
  assert.ok(size < 4096, `the compare answer is ${size} bytes`);
  assert.ok(JSON.stringify(run.execution_context.steps.words.output).length > 10000, 'the winner\'s whole answer is the step\'s output');
});

test('a then map sends the run to the winner\'s next step; the others are passed over and the run joins after them', async () => {
  const db = new PGlite();
  const routed = recipe(step({ then: { three: 'use-three', one: 'use-one', asked: 'use-asked' } }), [
    { id: 'use-three', do: 'Use three words.', submit: { type: 'object' } },
    { id: 'use-one', do: 'Use one word.', submit: { type: 'object' } },
    { id: 'use-asked', do: 'Use the words given.', submit: { type: 'object' } },
    { id: 'after', do: 'Say what was used.', submit: { type: 'object' } },
  ]);
  assert.deepEqual(recipeProblems(routed), []);
  const edges = definitionOf(routed).edges;
  assert.deepEqual(edges.filter(edge => edge.to === 'after').map(edge => edge.from), ['use-three', 'use-one', 'use-asked']);
  const { run } = await runAWorkflow({ recipe: routed, answers: { ...answers, 'use-asked': { used: true } } }, hostOver(db));
  assert.deepEqual(run.waiting.map(wait => wait.step_id), ['after'], 'only the winner\'s branch ran, then the step after the branches');
  assert.equal(run.execution_context.steps['use-asked'].output.used, true);
  assert.equal(run.execution_context.steps['use-three'].output, null, 'a passed-over branch is never asked (the engine shows it done with no output)');
});

test('one next step: the run goes on there once a variant won', async () => {
  const db = new PGlite();
  const onward = recipe(step({ then: 'use' }));
  assert.deepEqual(recipeProblems(onward), []);
  const { run } = await runAWorkflow({ recipe: onward, answers }, hostOver(db));
  assert.deepEqual(run.waiting.map(wait => wait.step_id), ['use']);
});

test('when no variant passes its checks the run fails naming each variant and what stopped it', async () => {
  const db = new PGlite();
  const none = step({ variants: [{ id: 'one', run_tool: made(1) }, { id: 'broken', run_tool: made(0) }] });
  const { run } = await runAWorkflow({ recipe: recipe(none) }, hostOver(db));
  assert.equal(run.status, 'failed');
  assert.match(run.error_message, /No variant passed its checks: one \(At least two different words[^)]*\)+; broken \(.*the provider answered 500/);
  const { rows } = await db.query('SELECT count(*)::int AS kept FROM variant_results');
  assert.equal(rows[0].kept, 2, 'the failed runs are kept too');
});

test('a definition step of kind "variants" becomes the same steps, the edges into it led to its first', () => {
  const { id, do: job, submit, mode, keep_in, measure, checks, variants } = step();
  const definition = definitionOf({ id: 'workflow:made-up-graph', definition: {
    steps: [
      { id: 'seed', kind: 'return', config: { value: { seed: 'tennis' } } },
      { id, kind: 'variants', config: { do: job, submit, mode, keep_in, measure, checks, variants } },
      { id: 'after', kind: 'return', config: { value: { done: true } } },
    ],
    edges: [{ from: 'seed', to: 'words', kind: 'always' }, { from: 'words', to: 'after', kind: 'always' }],
  } });
  assert.deepEqual(shape(definition), ['return seed', 'ask words#table', 'loop words#each', 'return words#compare', 'ask words#keep', 'return words', 'fail words#none', 'return after']);
  assert.ok(definition.edges.some(edge => edge.from === 'seed' && edge.to === 'words#table'));
  assert.ok(definition.edges.some(edge => edge.from === 'words' && edge.to === 'after'));
  assert.equal(definition.uses.length, 3);
});

test('a step with variants that cannot run is refused, every problem at once', () => {
  const problems = recipeProblems(recipe(step({ mode: 'some', measure: { best: 'most' }, keep_in: '', variants: [{ id: 'Bad Id', run_tool: { tool_id: 'x' } }, { id: 'asked', submit: { type: 'array' } }], then: { asked: 'nowhere' }, split: { explore_share: 2 } })));
  for (const expected of [/mode must be one of: all, split/, /measure must be/, /keep_in must name/, /variants\[0\]\.id must be/, /variants\[0\]\.run_tool must be/, /variants\[1\]\.submit/, /then must name a next step for each variant/, /then\.asked names "nowhere"/, /split is only for mode "split"/, /split must be/]) {
    assert.ok(problems.some(problem => expected.test(problem)), `${expected} in ${JSON.stringify(problems)}`);
  }
  assert.match(recipeProblems(recipe(step({ variants: [{ id: 'only', run_tool: made(1) }] })))[0], /at least two variants/);
  const passedOver = recipe(step({ then: 'after' }), [{ id: 'use', do: 'Use them.', submit: { type: 'object' } }, { id: 'after', do: 'After.', submit: { type: 'object' } }]);
  assert.deepEqual(recipeProblems(passedOver), ['steps "use" is reached by no step before it: a then passes over it; name it in that then, or move it.']);
});

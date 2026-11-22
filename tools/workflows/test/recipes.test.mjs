// tools/workflows: every shipped recipe row passes the recipe validator, and the validator refuses what would make a run fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { recipeProblems, CHECK_VOCABULARY, sharedBlocks, stepAnatomyProblems, STEP_ANATOMY } from '../read-data/recipe-problems.mjs';
import { measureStepExplicitness } from '../do-work/measure-step-explicitness.mjs';
import { spawnSync } from 'node:child_process';
import { RUN_ACTOR } from '../../write-a-job-done-in-several-steps-have/read-data/workflows.mjs';

const recipesFolder = new URL('../recipes/', import.meta.url);
const files = readdirSync(recipesFolder).filter(name => name.endsWith('.json')).sort();

test('the recipes folder holds recipes', () => {
  assert.ok(files.length > 0);
});

// The shared blocks among every shipped recipe: a shipped step that writes one out again is refused like any other problem.
const blocks = sharedBlocks(files.flatMap(file => JSON.parse(readFileSync(new URL(file, recipesFolder), 'utf8')).records ?? []).map(record => record?.payload));

for (const file of files) {
  test(`every row in ${file} is a valid recipe`, () => {
    const { records } = JSON.parse(readFileSync(new URL(file, recipesFolder), 'utf8'));
    assert.ok(Array.isArray(records) && records.length > 0, `${file} has records`);
    for (const record of records) assert.deepEqual(recipeProblems(record.payload, CHECK_VOCABULARY, { blocks }), [], `${file}: ${record.id}`);
  });
}

const step = id => ({ id, title: id, do: `Do ${id}.`, submit: { type: 'object' } });
const recipe = steps => ({ kind: 'workflow-recipe', id: 'workflow:fixture', job: 'Get the fixture done.', steps });

const explicitStep = () => ({
  ...step('read'), when: 'The input names a public source record id.',
  do: 'Read the record input.source_id from the person\'s own store, in that store\'s own query language.',
  submit: { type: 'object', properties: { quote: { type: 'string' } }, required: ['quote'] },
  done_when: 'The returned quote is visible in this step answer.',
  if_missing: 'If source_id is absent, return { quote: "missing source" }; do not invent one.',
  why: 'Reading the source keeps the quote grounded in its words.',
  came_from: ['record:check:public-source-fixture'], part_of: ['workflow:fixture'], position: 0,
  good_answer: 'Passes: { quote: "The exact source words" } matches the source. Fails: { quote: "Invented words" } does not occur in the source.',
});

test('strict anatomy names every missing field without changing legacy admission', () => {
  const legacy = step('read');
  assert.deepEqual(recipeProblems(recipe([legacy])), []);
  const problems = recipeProblems(recipe([legacy]), CHECK_VOCABULARY, { stepAnatomy: true });
  for (const field of [...STEP_ANATOMY.required_text.filter(field => field !== 'do'), ...STEP_ANATOMY.required_references, 'position', 'good_answer']) assert.ok(problems.some(problem => problem.includes(field)), field);
  assert.deepEqual(stepAnatomyProblems(explicitStep()), []);
  assert.deepEqual(recipeProblems(recipe([explicitStep()]), CHECK_VOCABULARY, { stepAnatomy: true }), []);
});

test('anatomy rejects empty examples, wrong field shapes and unknown machine checks', () => {
  const bad = { ...explicitStep(), came_from: [], part_of: 'fixture', position: -1, submit: {}, good_answer: 'Passes: Fails: invented.', checks: [{ kind: 'imaginary', says: 'Looks fine.' }] };
  const problems = stepAnatomyProblems(bad);
  for (const field of ['came_from', 'part_of', 'position', 'submit', 'good_answer', 'checks[0]']) assert.ok(problems.some(problem => problem.includes(field)), field);
});

test('submit schema structure rejects malformed nested properties and required lists', () => {
  for (const submit of [{type:'object',required:'field'}, {type:'object',properties:{field:17}},
    {type:'object',properties:{nested:{type:'array',items:{type:'object',required:[7]}}}}]) {
    assert.ok(stepAnatomyProblems({...explicitStep(),submit}).some(problem=>problem.includes('.submit')));
  }
  assert.deepEqual(stepAnatomyProblems({...explicitStep(),submit:{type:'object',properties:{extra:true,nested:{type:'array',items:{type:'string'}}},required:['nested']}}),[]);
});

test('measurement uses earlier schemas within the same branch for cross-step checks', () => {
  const first=explicitStep();
  const second={...explicitStep(),id:'compare',position:1,checks:[{kind:'subset-of',path:['this','quote'],of:['steps','read','quote'],says:'Only earlier output is repeated.'}]};
  const rows=[first,second].map(({id,...value})=>({id:`record:step:${id}`,values:{...value,step:id,submit:JSON.stringify(value.submit),came_from:JSON.stringify(value.came_from),part_of:JSON.stringify(value.part_of),checks:JSON.stringify(value.checks??[])}}));
  assert.equal(measureStepExplicitness(rows).incomplete,0);
  rows[1].values.part_of=JSON.stringify(['other-branch']);assert.equal(measureStepExplicitness(rows).incomplete,1);
});

test('empty machine checks are allowed only when examples supply the alternative evidence', () => {
  assert.deepEqual(stepAnatomyProblems({ ...explicitStep(), checks: [] }), []);
  assert.ok(stepAnatomyProblems({ ...explicitStep(), checks: [], good_answer: undefined }).some(problem => problem.includes('must have machine checks or good_answer')));
  assert.ok(stepAnatomyProblems({ ...explicitStep(), checks: 'not a list' }).some(problem => problem.includes('.checks must be a list')));
});

test('machine checked steps need examples when the recipe asks an AI to judge an answer', () => {
  const machine = { ...explicitStep(), good_answer: undefined, checks: [{ kind: 'exists', catalog: 'record', path: ['this', 'quote'], says: 'A quote is present.' }] };
  assert.deepEqual(stepAnatomyProblems(machine), []);
  assert.ok(recipeProblems(recipe([machine]), CHECK_VOCABULARY, { stepAnatomy: true }).some(problem => problem.includes('required for a judged step')));
  const toolStep = { ...machine, run_tool: { tool_id: 'tool:read-source', input: {} } };
  assert.deepEqual(recipeProblems(recipe([toolStep]), CHECK_VOCABULARY, { stepAnatomy: true }), []);
  assert.ok(recipeProblems(recipe([{ ...toolStep, checks: [{ kind: 'exists', says: 'A quote is present.' }] }]), CHECK_VOCABULARY, { stepAnatomy: true }).some(problem => problem.includes('.path')));
});

test('raw engine definitions cannot bypass strict anatomy for asks', () => {
  const raw = { ...recipe([]), definition: { steps: [{ id: 'read', kind: 'ask', config: { name: RUN_ACTOR, input: step('read') } }], edges: [] } };
  assert.deepEqual(recipeProblems(raw), []);
  assert.ok(recipeProblems(raw, CHECK_VOCABULARY, { stepAnatomy: true }).some(problem => problem.includes('config.input.when')));
});

test('measurement reports anatomy gaps and never claims semantic proof or an empty zero-percent win', () => {
  const report = measureStepExplicitness([explicitStep(), step('vague')]);
  assert.equal(report.total, 2); assert.equal(report.incomplete, 1); assert.equal(report.vague_share, 0.5);
  assert.equal(report.semantic_explicitness, 'not-measured');
  assert.equal(measureStepExplicitness([]).vague_share, null);
  assert.throws(() => measureStepExplicitness({ rows: null }), /Input must/);
  // A shape checker cannot detect a fictional source or a plausible but false completion claim.
  assert.equal(measureStepExplicitness([{ ...explicitStep(), done_when: 'The fictional row exists.' }]).semantic_explicitness, 'not-measured');
  const quoted = { ...explicitStep(), why: 'Reject the answer "use judgement" because it leaves the missing input undecided.' };
  assert.deepEqual(stepAnatomyProblems(quoted), [], 'a quoted bad example must not be mistaken for an instruction');
  assert.equal(measureStepExplicitness([quoted]).phrase_candidate_steps, 1);
  assert.equal(measureStepExplicitness([quoted]).anatomy_complete, 1);
  assert.equal(measureStepExplicitness([{ ...explicitStep(), if_missing: 'Use judgement.' }]).semantic_explicitness, 'not-measured', 'a complete shape can still contain a vague instruction');
  for (const input of [{ rows: [explicitStep()] }, { records: [{ payload: explicitStep() }] }, { records: [{ value: explicitStep() }] }, { rows: [{ id: 'published', values: { ...explicitStep(), submit: JSON.stringify(explicitStep().submit) } }] }]) assert.equal(measureStepExplicitness(input).anatomy_complete, 1);
  const malformed = measureStepExplicitness([{ values: { ...explicitStep(), submit: '{broken' } }]);
  assert.ok(malformed.details[0].problems.some(problem => problem.includes('invalid JSON')));
});

test('measurement reads current published consumers and CLI JSON without mutating rows', () => {
  const published = JSON.parse(readFileSync(new URL('../published/workflow-steps.json', import.meta.url), 'utf8'));
  const report = measureStepExplicitness(published);
  assert.ok(report.total > 0);
  assert.equal(report.anatomy_complete + report.incomplete, report.total);
  assert.ok(report.incomplete > 0, 'published DATA migration remains necessary');
  assert.equal(report.details[0].id, published.rows[0].id);
  assert.ok(!report.details[0].problems.some(problem => problem.includes('.do ')), 'published words were decoded rather than measuring the wrapper');
  const cli = new URL('../do-work/measure-step-explicitness.mjs', import.meta.url);
  const run = spawnSync(process.execPath, [cli.pathname], { input: JSON.stringify([explicitStep()]), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).anatomy_complete, 1);
  const summary = spawnSync(process.execPath, [cli.pathname, new URL('../published/workflow-steps.json', import.meta.url).pathname, '--summary'], { encoding: 'utf8' });
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(JSON.parse(summary.stdout).total, report.total);
  assert.equal(JSON.parse(summary.stdout).details, undefined);
  const invalid = spawnSync(process.execPath, [cli.pathname], { input: '{}', encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Input must/);
});

test('a well-formed recipe has no problems', () => {
  assert.deepEqual(recipeProblems(recipe([step('first'), step('second')])), []);
});

test('a step with no `do` is refused', () => {
  const { do: _omitted, ...bare } = step('first');
  assert.deepEqual(recipeProblems(recipe([bare])), ['steps[0].do must say what to do in this step.']);
});

test('a duplicate step id is refused', () => {
  assert.deepEqual(recipeProblems(recipe([step('first'), step('first')])), ['steps[1].id "first" is used twice.']);
});

test('a check that reads a later step is refused', () => {
  const early = { ...step('first'), checks: [{ kind: 'exists', says: 'The tool exists.', path: ['steps', 'second', 'name'], catalog: 'tool' }] };
  assert.deepEqual(recipeProblems(recipe([early, step('second')])), ['steps[0].checks[0].path reads step "second", which is not an earlier step.']);
});

test('a check that reads a field no schema declares is refused, and one the schema leaves open is not', () => {
  const declared = { type: 'object', properties: { picks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } };
  const first = { ...step('first'), submit: declared };
  const reads = path => ({ ...step('second'), checks: [{ kind: 'distinct-at-least', says: 'Enough.', path, count: 1 }] });
  assert.deepEqual(recipeProblems(recipe([first, reads(['steps', 'first', 'picks', '*', 'id'])])), []);
  assert.deepEqual(recipeProblems(recipe([first, reads(['steps', 'first', 'picks', '*', 'name'])])), ['steps[1].checks[0].path reads "name", which step "first" does not declare.']);
  assert.deepEqual(recipeProblems(recipe([first, reads(['this', 'anything'])])), []);
  const open = { ...step('first'), submit: { type: 'object', properties: {}, additionalProperties: { type: 'string' } } };
  assert.deepEqual(recipeProblems(recipe([open, reads(['steps', 'first', 'anything'])])), []);
  assert.deepEqual(recipeProblems({ ...recipe([reads(['input', 'missing'])]), input_schema: { type: 'object', properties: { goal: { type: 'string' } } } }), ['steps[0].checks[0].path reads "missing", which the input does not declare.']);
});

test('a bad id and a missing job are both reported at once', () => {
  assert.equal(recipeProblems({ ...recipe([step('first')]), id: 'Workflow:Bad', job: '' }).length, 2);
});

test('a check kind added only as a DATA row is accepted, and refused without the row', () => {
  const row = {
    kind: 'starts-with',
    meaning: 'The text at path begins with one of the listed words.',
    fields: [
      { field: 'path', shape: 'path', required: true, refusal: 'is required.' },
      { field: 'words', shape: 'words', required: true, refusal: 'must list the words it may begin with.' },
    ],
  };
  const withRow = { ...CHECK_VOCABULARY, kinds: [...CHECK_VOCABULARY.kinds, row] };
  const check = { kind: 'starts-with', says: 'It opens with a greeting.', path: ['this', 'text'], words: ['hello'] };
  const checked = recipe([{ ...step('first'), checks: [check] }]);
  assert.deepEqual(recipeProblems(checked, withRow), []);
  assert.match(recipeProblems(checked)[0], /kind must be one of: subset-of, covers/);
  assert.deepEqual(recipeProblems(recipe([{ ...step('first'), checks: [{ ...check, words: [] }] }]), withRow), ['steps[0].checks[0].words must list the words it may begin with.']);
});

test('the shipped vocabulary refuses a missing field, a bad count and an unknown catalog from its rows', () => {
  const bad = checks => recipeProblems(recipe([{ ...step('first'), checks }]));
  assert.deepEqual(bad([{ kind: 'covers', says: 'x', path: ['input', 'a'] }]), ['steps[0].checks[0] needs of or values.']);
  assert.deepEqual(bad([{ kind: 'distinct-at-least', says: 'x', path: ['input', 'a'], count: 0 }]), ['steps[0].checks[0].count must be a whole number above 0.']);
  assert.deepEqual(bad([{ kind: 'exists', says: 'x', path: ['input', 'a'], catalog: 'nope' }]), ['steps[0].checks[0].catalog must be one of: workflow, tool, list-row, record, ran-task.']);
});

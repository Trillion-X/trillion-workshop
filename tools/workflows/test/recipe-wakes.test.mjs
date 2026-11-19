// tools/workflows: a recipe's `wakes` list is judged by recipe-wake-causes.json, so it says only what the engine's wake
// primitive takes; every shipped wake passes, fits the engine's cap, and a cause added only as a DATA row is accepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';
import { wakeProblems, WAKE_VOCABULARY } from '../read-data/wake-problems.mjs';

const step = id => ({ id, title: id, do: `Do ${id}.`, submit: { type: 'object' } });
const recipe = wake => ({
  kind: 'workflow-recipe', id: 'workflow:fixture', job: 'Get the fixture done.',
  input_schema: { type: 'object', properties: { size: { type: 'integer' } } },
  steps: [step('first'), step('weekly')], wakes: wake, produces: wake ? 'A weekly fixture report.' : undefined,
});
const weekly = { id: 'monday', on: { fact: { kind: 'due-time', from: ['run'], match: { schedule_id: 'schedule:monday' } } }, budget: { steps: 40, wall_ms: 1800000 }, input: { start_at: 'weekly' } };
const context = { stepIds: ['first', 'weekly'], inputFields: ['size'] };

test('a recipe with no wake, and one with a well-formed wake of every cause, has no problems', () => {
  assert.deepEqual(recipeProblems(recipe(undefined)), []);
  assert.deepEqual(recipeProblems(recipe([
    weekly,
    { id: 'keep', on: { running: {} }, budget: { steps: 1, wall_ms: 120000 }, input: { start_at: 'first' } },
    { id: 'due', on: { fact: { kind: 'due-time', from: ['run'], match: { schedule_id: 'schedule:weekly' }, watch: { schedules: [{ schedule_id: 'schedule:weekly' }] } } }, budget: { steps: 900, wall_ms: 600000 }, input: { start_at: 'weekly' } },
    { id: 'drive', on: { fact: { kind: 'volume-mounted', from: ['computer'], match: { volume_name: 'CARD' }, fold: true } }, budget: { steps: 5, wall_ms: 600000 }, input: { start_at: 'first' } },
  ])), []);
});

test('a wake whose start step is not a step of the recipe, or whose input names a field the recipe does not take, is refused', () => {
  assert.deepEqual(wakeProblems([{ ...weekly, input: { start_at: 'later', colour: 'red' } }], context), [
    'wakes[0].input.start_at must name a step of this recipe: first, weekly.',
    'wakes[0].input.colour is not a field of this recipe\'s input_schema.',
  ]);
});

test('a cause the engine does not take, two causes, an unknown field and an extra wake key are refused', () => {
  assert.match(wakeProblems([{ ...weekly, on: { cron: { at: 'monday' } } }], context)[0], /on must name exactly one cause: running, fact/);
  assert.match(wakeProblems([{ ...weekly, on: { record: { resource: 'own-records' } } }], context)[0], /exactly one cause/, 'a cause the engine dropped is refused');
  assert.match(wakeProblems([{ ...weekly, on: { time: { every_ms: 3600000 } } }], context)[0], /exactly one cause/, 'the engine keeps no clock: a time comes as a due-time fact');
  assert.match(wakeProblems([{ ...weekly, on: { running: {}, arrival: { source: 'x' } } }], context)[0], /exactly one cause/);
  assert.match(wakeProblems([{ ...weekly, on: { fact: { kind: 'due-time', from: ['run'], weekday: 'monday' } } }], context)[0], /^wakes\[0\]\.on\.fact\.weekday is not a field of a fact cause; it takes /);
  assert.deepEqual(wakeProblems([{ ...weekly, starts: 'weekly' }], context), ['wakes[0].starts is not part of a wake; it takes id, on, budget, input.']);
});

test('a fact names a kind and who may tell it, from the engine\'s tellers only', () => {
  const fact = (fields) => [{ ...weekly, on: { fact: fields } }];
  assert.deepEqual(wakeProblems(fact({ kind: 'due-time', from: ['run'] }), context), []);
  assert.deepEqual(wakeProblems(fact({ kind: 'due-time', from: ['the-neighbour'] }), context), ['wakes[0].on.fact.from must be one of: computer, run, sender, wake, door.']);
  assert.deepEqual(wakeProblems(fact({ kind: 'due-time', from: [] }), context), ['wakes[0].on.fact.from must be texts.']);
  assert.deepEqual(wakeProblems(fact({ from: ['run'] }), context), ['wakes[0].on.fact.kind is required.']);
  assert.deepEqual(wakeProblems(fact({ kind: 'due-time', from: ['run'], fold: 'yes' }), context), ['wakes[0].on.fact.fold must be flag.']);
});

test('a budget below what a run needs, above its ledger, or in an unknown dimension is refused', () => {
  assert.deepEqual(wakeProblems([{ ...weekly, budget: { steps: 1 } }], context), ['wakes[0].budget.wall_ms must be at least 120000, or no firing is ever funded.']);
  const told = (from) => [{ ...weekly, on: { fact: { kind: 'x', from } }, budget: { steps: 600, wall_ms: 120000 } }];
  assert.deepEqual(wakeProblems(told(['sender']), context), ['wakes[0].budget.steps must be at most 500, the inbound ledger for a whole period.']);
  assert.deepEqual(wakeProblems(told(['run']), context), [], 'what the person\'s own tools tell draws from work');
  assert.deepEqual(wakeProblems(told(['run', 'computer']), context), ['wakes[0].budget.steps must be at most 500, the inbound ledger for a whole period.'], 'it must fit every ledger it may draw from');
  assert.deepEqual(wakeProblems([{ ...weekly, budget: { ...weekly.budget, dollars: 5 } }], context), ['wakes[0].budget.dollars is not a budget dimension; they are steps, wall_ms.']);
});

test('a recipe with a wake must say what a run produces, in words', () => {
  assert.deepEqual(recipeProblems({ ...recipe([weekly]), produces: undefined }), ['a recipe with a wake must say what a run produces (produces), so the person knows what each firing makes.']);
  assert.deepEqual(recipeProblems({ ...recipe([weekly]), produces: ' ' }), ['produces must say in one line what a run makes that could become something to share.']);
});

test('a repeated wake id and an empty list are refused', () => {
  assert.deepEqual(wakeProblems([weekly, weekly], context), ['wakes[1].id "monday" is used twice.']);
  assert.deepEqual(wakeProblems([], context), ['wakes must list at least one wake, or be left out.']);
});

test('a cause added only as a DATA row is accepted, and refused without the row', () => {
  const vocabulary = { ...WAKE_VOCABULARY, causes: [...WAKE_VOCABULARY.causes, { cause: 'location', draws: 'inbound', fields: [{ field: 'place', shape: 'text', required: true }] }] };
  const wake = [{ ...weekly, on: { location: { place: 'home' } } }];
  assert.deepEqual(wakeProblems(wake, context, vocabulary), []);
  assert.match(wakeProblems(wake, context)[0], /exactly one cause/);
});

test('every shipped recipe wake together fits the engine\'s cap on declared wakes', () => {
  const folder = new URL('../recipes/', import.meta.url);
  const wakes = readdirSync(folder).filter(name => name.endsWith('.json'))
    .flatMap(name => JSON.parse(readFileSync(new URL(name, folder), 'utf8')).records)
    .flatMap(record => record.payload[WAKE_VOCABULARY.field] ?? []);
  assert.ok(wakes.length > 0, 'some recipe declares a wake');
  assert.ok(wakes.length <= WAKE_VOCABULARY.max_wakes);
});

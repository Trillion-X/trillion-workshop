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
const weekly = { id: 'monday', on: { time: { every_ms: 604800000, from_ms: 345600000 } }, budget: { steps: 40, wall_ms: 1800000 }, input: { start_at: 'weekly' } };
const context = { stepIds: ['first', 'weekly'], inputFields: ['size'] };

test('a recipe with no wake, and one with a well-formed wake of every cause, has no problems', () => {
  assert.deepEqual(recipeProblems(recipe(undefined)), []);
  assert.deepEqual(recipeProblems(recipe([
    weekly,
    { id: 'once', on: { time: { at_ms: 1800000000000 } }, budget: { steps: 1, wall_ms: 120000 }, input: { start_at: 'first', size: 3 } },
    { id: 'new-note', on: { record: { resource: 'own-records', kind: 'note' } }, budget: { steps: 5, wall_ms: 600000 }, input: { start_at: 'first' } },
    { id: 'shared', on: { arrival: { source: 'share-sheet' } }, budget: { steps: 5, wall_ms: 600000 }, input: { start_at: 'first' } },
    { id: 'drive', on: { host_event: { kind: 'volume-mounted', match: { volume_name: 'CARD' } } }, budget: { steps: 5, wall_ms: 600000 }, input: { start_at: 'first' } },
  ])), []);
});

test('a wake whose start step is not a step of the recipe, or whose input names a field the recipe does not take, is refused', () => {
  assert.deepEqual(wakeProblems([{ ...weekly, input: { start_at: 'later', colour: 'red' } }], context), [
    'wakes[0].input.start_at must name a step of this recipe: first, weekly.',
    'wakes[0].input.colour is not a field of this recipe\'s input_schema.',
  ]);
});

test('a time cause needs exactly one of at_ms and every_ms, and from_ms only beside every_ms', () => {
  assert.deepEqual(wakeProblems([{ ...weekly, on: { time: { at_ms: 5, every_ms: 10 } } }], context), ['wakes[0].on.time needs exactly one of at_ms, every_ms.']);
  assert.deepEqual(wakeProblems([{ ...weekly, on: { time: { at_ms: 5, from_ms: 1 } } }], context), ['wakes[0].on.time.from_ms is taken only beside every_ms.']);
  assert.deepEqual(wakeProblems([{ ...weekly, on: { time: { every_ms: 0 } } }], context), ['wakes[0].on.time.every_ms must be positive.']);
});

test('a repeat may keep its wall-clock time in a known time zone; an unknown zone, or a zone on a once-at time, is refused', () => {
  const zoned = zone => [{ ...weekly, on: { time: { every_ms: 604800000, from_ms: 1793026800000, zone } } }];
  assert.deepEqual(wakeProblems(zoned('America/Denver'), context), []);
  assert.deepEqual(wakeProblems(zoned('Mars/Olympus'), context), ['wakes[0].on.time.zone must name a time zone the time zone database knows, for example Europe/Lisbon.']);
  assert.deepEqual(wakeProblems([{ ...weekly, on: { time: { at_ms: 5, zone: 'America/Denver' } } }], context), ['wakes[0].on.time.zone is taken only beside every_ms.']);
});

test('a cause the engine does not take, two causes, an unknown field and an extra wake key are refused', () => {
  assert.match(wakeProblems([{ ...weekly, on: { cron: { at: 'monday' } } }], context)[0], /on must name exactly one cause: record, time, arrival, host_event/);
  assert.match(wakeProblems([{ ...weekly, on: { time: { every_ms: 1 }, arrival: { source: 'x' } } }], context)[0], /exactly one cause/);
  assert.deepEqual(wakeProblems([{ ...weekly, on: { time: { every_ms: 604800000, weekday: 'monday' } } }], context), ['wakes[0].on.time.weekday is not a field of a time cause; it takes at_ms, every_ms, from_ms, zone.']);
  assert.deepEqual(wakeProblems([{ ...weekly, starts: 'weekly' }], context), ['wakes[0].starts is not part of a wake; it takes id, on, budget, input.']);
});

test('a record wake watches only a resource the person\'s records live in, and a host event matches only fields its kind reports', () => {
  assert.deepEqual(wakeProblems([{ ...weekly, on: { record: { resource: 'wake-book' } } }], context), ['wakes[0].on.record.resource must be one of: own-records.']);
  assert.deepEqual(wakeProblems([{ ...weekly, on: { host_event: { kind: 'app-opened', match: { volume_name: 'CARD' } } } }], context), ['wakes[0].on.host_event.match.volume_name is not a field app-opened reports; it reports bundle_id.']);
  assert.deepEqual(wakeProblems([{ ...weekly, on: { host_event: { kind: 'screen-locked' } } }], context), ['wakes[0].on.host_event.kind must be one of: app-opened, app-quit, volume-mounted, volume-unmounted.']);
});

test('a budget below what a run needs, above its ledger, or in an unknown dimension is refused', () => {
  assert.deepEqual(wakeProblems([{ ...weekly, budget: { steps: 1 } }], context), ['wakes[0].budget.wall_ms must be at least 120000, or no firing is ever funded.']);
  assert.deepEqual(wakeProblems([{ ...weekly, on: { arrival: { source: 'x' } }, budget: { steps: 600, wall_ms: 120000 } }], context), ['wakes[0].budget.steps must be at most 500, the inbound ledger for a whole period.']);
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

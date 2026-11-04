import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { activityRow, keepActivity, PERSON_APP } from '../../see-what-my-ais-did/activity.mjs';
import { markScreenSeen, readNewWork } from '../src/new-work.mjs';
import { seenMarks } from '../src/seen-marks.mjs';

// Any SQLite, in the Durable Object's exec shape: a cursor that can be spread or walked.
function sqlite() {
  const db = new DatabaseSync(':memory:');
  return { exec: (query, ...binds) => { const statement = db.prepare(query); const rows = /^\s*select/i.test(query) ? statement.all(...binds) : (statement.run(...binds), []); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
}

// A field nothing in Trillion names: a kitchen whose cooks file recipes and plate dishes.
const marks = new Map([
  ['file_recipe', { tool: 'file_recipe', label: 'Filed a recipe', item: [{ from: 'result', path: ['id'] }], title: [{ from: 'input', path: ['dish'] }], facts: { course: [{ from: 'input', path: ['course'] }] }, opens: { surface: 'box.recipe', input: 'id' } }],
  ['plate_dish', { tool: 'plate_dish', label: 'Plated a dish', item: [{ from: 'result', path: ['id'] }], title: [{ from: 'input', path: ['dish'] }] }],
]);
const config = {
  window_days: 7,
  counts: [
    { surface: 'box.all', tools: ['file_recipe', 'plate_dish'] },
    { surface: 'box.recipes', tools: ['file_recipe'] },
    { surface: 'box.desserts', tools: ['file_recipe'], where: { fact: 'course', starts_with: ['dessert'] } },
    { surface: 'box.everything', tools: 'every' },
    { surface: 'box.tables', source: 'tables_waiting' },
  ],
  strip: { surface: 'box.all', count: 3, tools: ['file_recipe', 'plate_dish'] },
  looks: { plate_dish: { icon: 'Utensils', type_label: 'Dish' } },
};
const now = new Date('2026-09-29T12:00:00.000Z');
const minutesAgo = minutes => new Date(now.getTime() - minutes * 60000).toISOString();
function keep(sql, tool, id, { app = 'Kitchen AI', at, dish = id, course, error } = {}) {
  keepActivity(sql, activityRow({ tool, input: { dish, course }, result: { id }, error, app, at }, marks));
}

test('each screen counts what an AI made after the person last saw it, by DATA, and a seen screen starts again', async () => {
  const sql = sqlite();
  keep(sql, 'file_recipe', 'r1', { at: minutesAgo(50), course: 'dessert' });
  keep(sql, 'plate_dish', 'd1', { at: minutesAgo(40) });
  keep(sql, 'file_recipe', 'r2', { at: minutesAgo(30), course: 'main' });
  markScreenSeen(sql, 'box.recipes', { now: new Date(minutesAgo(35)), config });
  keep(sql, 'file_recipe', 'r3', { at: minutesAgo(20), app: PERSON_APP });
  keep(sql, 'file_recipe', 'r4', { at: minutesAgo(10), error: 'no oven' });
  const answer = await readNewWork(sql, { now, config, elsewhere: { tables_waiting: async () => 4 } });
  assert.deepEqual(answer.counts, { 'box.all': 3, 'box.recipes': 1, 'box.desserts': 1, 'box.everything': 3, 'box.tables': 4 });
  assert.deepEqual(answer.clears_on_show, ['box.all', 'box.recipes', 'box.desserts', 'box.everything']);
  markScreenSeen(sql, 'box.all', { now, config });
  const after = await readNewWork(sql, { now, config });
  assert.equal(after.counts['box.all'], 0);
  assert.equal(after.counts['box.recipes'], 1);
  assert.ok(!('box.tables' in after.counts), 'a source nobody handed in is left out, not guessed');
});

test('the strip lists the newest things an AI made once each, with what they are and whether they are new', async () => {
  const sql = sqlite();
  keep(sql, 'file_recipe', 'r1', { at: minutesAgo(50), course: 'dessert', dish: 'Pie' });
  keep(sql, 'plate_dish', 'd1', { at: minutesAgo(40), dish: 'Soup' });
  markScreenSeen(sql, 'box.all', { now: new Date(minutesAgo(35)), config });
  keep(sql, 'file_recipe', 'r1', { at: minutesAgo(30), course: 'dessert', dish: 'Pie again' });
  keep(sql, 'plate_dish', 'd2', { at: minutesAgo(20), dish: 'Salad', app: PERSON_APP });
  keep(sql, 'plate_dish', 'd3', { at: minutesAgo(10), dish: 'Bread' });
  const { items } = await readNewWork(sql, { now, config });
  assert.deepEqual(items.map(item => [item.item, item.title, item.new]), [['d3', 'Bread', true], ['r1', 'Pie again', true], ['d1', 'Soup', false]]);
  assert.deepEqual(items[0].look, { icon: 'Utensils', type_label: 'Dish' });
  assert.equal(items[1].opens.surface, 'box.recipe');
  assert.equal(items[1].app, 'Kitchen AI');
});

test('a screen never seen, or seen long ago, counts only the window; nothing older is read', async () => {
  const sql = sqlite();
  keep(sql, 'file_recipe', 'old', { at: minutesAgo(60 * 24 * 30) });
  keep(sql, 'file_recipe', 'fresh', { at: minutesAgo(5) });
  markScreenSeen(sql, 'box.recipes', { now: new Date(minutesAgo(60 * 24 * 60)), config });
  const answer = await readNewWork(sql, { now, config });
  assert.equal(answer.counts['box.all'], 1);
  assert.equal(answer.counts['box.recipes'], 1);
  assert.deepEqual(answer.items.map(item => item.item), ['fresh']);
});

test('unchanged reads reuse activity-derived work while outside counts remain fresh', async () => {
  const sql = sqlite();
  // Activity rows walked: each row a read of the record hands back.
  let walked = 0;
  let outside = 0;
  const exec = sql.exec;
  sql.exec = (query, ...binds) => {
    const cursor = exec(query, ...binds);
    if (!/FROM activity\b/.test(query) || !/SELECT seq, row/.test(query)) return cursor;
    const rows = [...cursor];
    walked += rows.length;
    return rows;
  };
  keep(sql, 'file_recipe', 'r1', { at: minutesAgo(5) });
  keep(sql, 'file_recipe', 'r2', { at: minutesAgo(4) });
  const read = () => readNewWork(sql, { now, config, elsewhere: { tables_waiting: async () => ++outside } });
  assert.equal((await read()).counts['box.tables'], 1);
  assert.equal(walked, 2);
  assert.equal((await read()).counts['box.tables'], 2);
  assert.equal(walked, 2, 'refreshing an unchanged page does not walk the activity record again');

  markScreenSeen(sql, 'box.all', { now: new Date(minutesAgo(2)), config });
  assert.equal((await read()).counts['box.all'], 0);
  assert.equal(walked, 4, 'a new seen mark changes the derived count');

  keep(sql, 'plate_dish', 'd1', { at: minutesAgo(1) });
  const after = await read();
  assert.equal(after.counts['box.all'], 1);
  assert.equal(walked, 5, 'a new activity row is read on its own, the rows before it are not walked again');
  assert.equal(after.items[0].item, 'd1', 'the newest thing leads the strip');
});

test('the activity window expires cached rows and a backdated insertion cannot hide newer rows', async () => {
  const sql = sqlite();
  keep(sql, 'file_recipe', 'fresh', { at: minutesAgo(5) });
  keep(sql, 'file_recipe', 'backdated', { at: minutesAgo(60 * 24 * 30) });
  const first = await readNewWork(sql, { now, config });
  assert.deepEqual(first.items.map(item => item.item), ['fresh']);
  assert.equal(first.counts['box.all'], 1);

  const later = await readNewWork(sql, { now: new Date(now.getTime() + 7 * 86400000), config });
  assert.deepEqual(later.items, []);
  assert.equal(later.counts['box.all'], 0);
});

test('only a screen whose count the record keeps can be marked seen', () => {
  assert.throws(() => markScreenSeen(sqlite(), 'box.tables', { now, config }), /nothing to mark seen/);
  assert.throws(() => markScreenSeen(sqlite(), 'box.nowhere', { now, config }), /nothing to mark seen/);
});

test('seen marks keep one row per place and reader, in whatever table their owner names', () => {
  const sql = sqlite();
  const marksOf = seenMarks(sql, { table: 'shelf_seen', place: 'shelf', reader: 'cook' });
  assert.equal(marksOf.seenAt('a', 'x'), null);
  marksOf.mark('a', 'x', '2026-01-01T00:00:00.000Z');
  marksOf.mark('a', 'x', '2026-02-01T00:00:00.000Z');
  marksOf.mark('b', 'x', '2026-03-01T00:00:00.000Z');
  marksOf.mark('a', 'y', '2026-04-01T00:00:00.000Z');
  assert.equal(marksOf.seenAt('a', 'x'), '2026-02-01T00:00:00.000Z');
  assert.deepEqual(marksOf.marksOf('x'), { a: '2026-02-01T00:00:00.000Z', b: '2026-03-01T00:00:00.000Z' });
});

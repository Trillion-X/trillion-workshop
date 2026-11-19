// Proof of workflow:tell-the-person (tools/workflows/recipes/tell-the-person.json): its statements, exactly as the recipe
// carries them, run on PGlite, a plain PostgreSQL. Telling keeps one notice in the person's notices; a key keeps it once;
// the render step is harmless to run again and widens a notices table made before kind and key existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const recipe = JSON.parse(readFileSync(new URL('../recipes/tell-the-person.json', import.meta.url), 'utf8')).records[0].payload;
const statements = stepId => Object.fromEntries(recipe.steps.find(step => step.id === stepId).sql.map(item => [item.name, item.text]));
const render = statements('render');
const { tell, kept } = statements('tell');

test('a told thing is one notice the devices read; told again under its key it is not kept twice', async () => {
  const db = new PGlite();
  for (let pass = 0; pass < 2; pass += 1) for (const name of ['devices', 'notices', 'kind-and-key']) await db.exec(render[name]);
  const first = await db.query(tell, ['Bo cancelled the Friday call', null, null, 'booking:101:cancelled', null]);
  assert.equal(first.rows.length, 1);
  const again = await db.query(tell, ['Bo cancelled the Friday call', 'again', 'needs-you', 'booking:101:cancelled', null]);
  assert.equal(again.rows.length, 0, 'the same key keeps no second notice');
  assert.deepEqual((await db.query(kept, ['booking:101:cancelled'])).rows.map(row => Number(row.id)), [Number(first.rows[0].id)]);
  await db.query(tell, ['No key', 'told each time', 'note', null, 'https://example.test/1']);
  await db.query(tell, ['No key', 'told each time', 'note', null, 'https://example.test/1']);
  const rows = (await db.query('SELECT title, body, kind, key, url FROM notices ORDER BY id')).rows;
  assert.deepEqual(rows, [
    { title: 'Bo cancelled the Friday call', body: '', kind: 'needs-you', key: 'booking:101:cancelled', url: null },
    { title: 'No key', body: 'told each time', kind: 'note', key: null, url: 'https://example.test/1' },
    { title: 'No key', body: 'told each time', kind: 'note', key: null, url: 'https://example.test/1' }]);
});

test('a notices table made before kind and key gets them, and keeps its rows', async () => {
  const db = new PGlite();
  await db.exec(render.devices);
  await db.exec(render.notices);
  await db.query('INSERT INTO notices (title) VALUES ($1)', ['Older notice']);
  await db.exec(render['kind-and-key']);
  await db.query(tell, ['Newer', null, null, 'k', null]);
  assert.deepEqual((await db.query('SELECT title, kind, key FROM notices ORDER BY id')).rows, [
    { title: 'Older notice', kind: null, key: null }, { title: 'Newer', kind: 'needs-you', key: 'k' }]);
});

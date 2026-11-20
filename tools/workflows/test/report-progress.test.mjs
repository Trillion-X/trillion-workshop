// Proof of workflow:report-progress (tools/workflows/recipes/report-progress.json): its statements, exactly as the recipe
// carries them, run on PGlite, a plain PostgreSQL. The assertions are the old report tests of the retired engine's
// src/tell-the-person.mjs (tools/tell-one-person-something-through-every-way-they/test/tell-the-person.test.mjs, tests
// "work still going on is one notice changed in place ... told once when it ends" and "a running report not heard from for
// the quiet minutes reads as stopped, and bad counts or an outside address are refused"), over the person's own tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const recipe = JSON.parse(readFileSync(new URL('../recipes/report-progress.json', import.meta.url), 'utf8')).records[0].payload;
const statements = stepId => Object.fromEntries(recipe.steps.find(step => step.id === stepId).sql.map(item => [item.name, item.text]));
const render = statements('render');
const { report } = statements('report');
const { cards } = statements('cards');

const made = async () => {
  const db = new PGlite();
  for (let pass = 0; pass < 2; pass += 1) for (const name of ['devices', 'notices', 'kind-and-key', 'progress']) await db.exec(render[name]);
  return db;
};
// params: key, title, body, kind, state, done, total, unit, url, source
const say = (db, key, title, more = {}) => db.query(report, [key, title, more.body ?? null, more.kind ?? null, more.state ?? null,
  more.done ?? null, more.total ?? null, more.unit ?? null, more.url ?? null, more.source ?? null]);

test('work still going on is one card changed in place, and its end is told once', async () => {
  const db = await made();
  await say(db, 'copy:1', 'Copying a drive', { kind: 'transfer', source: 'This Mac', done: 10, total: 100, unit: 'bytes' });
  await say(db, 'copy:1', 'Copying a drive', { kind: 'transfer', source: 'This Mac', done: 60, total: 100, unit: 'bytes' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM notices')).rows[0].n, 0, 'a running report is no notice for the devices');
  const [running] = (await db.query(cards, [null, null])).rows;
  assert.deepEqual({ state: running.state, done: Number(running.done), total: Number(running.total), unit: running.unit, source: running.source },
    { state: 'running', done: 60, total: 100, unit: 'bytes', source: 'This Mac' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM progress')).rows[0].n, 1);
  const ended = (await say(db, 'copy:1', 'Copied a drive', { kind: 'transfer', state: 'done', done: 100, total: 100, unit: 'bytes' })).rows[0];
  assert.equal(ended.state, 'done');
  assert.ok(ended.told_id !== null, 'the end is told');
  const again = (await say(db, 'copy:1', 'Copied a drive', { kind: 'transfer', state: 'done' })).rows[0];
  assert.equal(again.told_id, null, 'an ended job is told once');
  const notices = (await db.query('SELECT title, kind FROM notices')).rows;
  assert.deepEqual(notices, [{ title: 'Copied a drive', kind: 'transfer' }]);
  assert.equal((await db.query(cards, [null, null])).rows[0].title, 'Copied a drive');
});

test('a program started again on the same work changes the same card, and its next end is told again', async () => {
  const db = await made();
  await say(db, 'run:a', 'Working', { state: 'failed' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await say(db, 'run:a', 'Working again', { state: 'running' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM progress')).rows[0].n, 1);
  const second = (await say(db, 'run:a', 'Finished', { state: 'done' })).rows[0];
  assert.ok(second.told_id !== null, 'a new run of the same work is told when it ends');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM notices')).rows[0].n, 2);
});

test('a running report not heard from for the quiet minutes reads as stopped, and an outside address is replaced', async () => {
  const db = await made();
  await say(db, 'k', 'Making a video', { url: '//elsewhere.example/x' });
  const [fresh] = (await db.query(cards, [null, null])).rows;
  assert.equal(fresh.url, '/notifications');
  assert.equal(fresh.state, 'running');
  const later = new Date(Date.now() + 11 * 60_000).toISOString();
  assert.equal((await db.query(cards, [null, later])).rows[0].state, 'stopped');
  assert.equal((await db.query(cards, [30, later])).rows[0].state, 'running', 'the quiet minutes are the person\'s to change');
  await say(db, 'k', 'Making a video', { url: '/files/video.mp4' });
  assert.equal((await db.query(cards, [null, null])).rows[0].url, '/files/video.mp4');
});

test('bad counts, a missing key and a state that is not running, done or failed are refused', async () => {
  const db = await made();
  await assert.rejects(say(db, 'k2', 'x', { done: 5, total: 2 }), /check/i);
  await assert.rejects(say(db, 'k2', 'x', { done: 5 }), /check/i);
  await assert.rejects(say(db, null, 'no key'), /null|key/i);
  await assert.rejects(say(db, 'k3', 'x', { state: 'maybe' }), /check/i);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM progress')).rows[0].n, 0);
});

// Proof of the notice workflows (workflow:read-my-device-notices, workflow:mark-my-notices-read, workflow:act-on-my-notice,
// tools/workflows/recipes): the statements each recipe carries in its steps' sql run on PGlite, a plain PostgreSQL, and
// give the answers the recipes' words say. Made-up devices, notices and urls only. The device's own registration is written
// here as the app lane writes it; the recipes only read it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const recipe = name => JSON.parse(readFileSync(new URL(`../recipes/${name}.json`, import.meta.url), 'utf8')).records[0].payload;
const READ = recipe('read-my-device-notices');
const MARK = recipe('mark-my-notices-read');
const ACT = recipe('act-on-my-notice');

// The statements of one step, by name, exactly as the recipe carries them.
const statements = (payload, stepId) => Object.fromEntries(payload.steps.find(step => step.id === stepId).sql.map(item => [item.name, item.text]));

let db;
const run = (text, params = []) => db.query(text, params);
const ids = rows => rows.map(row => Number(row.id));
// The cursor rule the read recipe states: fewer rows than the limit means last_id; a full page means the last row shown.
const cursorOf = (rows, limit, lastId) => (rows.length < limit ? Number(lastId) : Number(rows.at(-1).id));

before(async () => {
  db = new PGlite();
  const render = statements(READ, 'render');
  // The render step runs on every use; it must be harmless to run it again.
  for (let pass = 0; pass < 2; pass += 1) for (const name of ['devices', 'notices']) await db.exec(render[name]);
  // The act recipe's render adds the reply columns to a table that already exists; it runs on every use too.
  for (let pass = 0; pass < 2; pass += 1) await db.exec(statements(ACT, 'render').answers);
  // The app lane's device registrations, and notices made by the Workshop, as the rows the recipes read.
  for (const [id, platform, at] of [
    ['device-a', 'live', '2026-01-01T00:00:00Z'], ['browser-a', 'web-push', '2026-01-01T00:00:00Z'],
    ['phone-a', 'apns', '2026-01-01T00:00:00Z'], ['late-device', 'live', '2026-02-01T00:00:00Z']]) {
    await run('INSERT INTO devices (id, platform, registered_at) VALUES ($1, $2, $3)', [id, platform, at]);
  }
  const notice = (title, deviceId, madeAt, url) => run('INSERT INTO notices (title, device_id, made_at, url) VALUES ($1, $2, $3, $4)', [title, deviceId, madeAt, url]);
  await notice('Notice 1', 'device-a', '2026-01-01T00:01:00Z', '/work/reports/1');
  await notice('Notice 2', null, '2026-01-01T00:02:00Z', null);
  await notice('Notice 3', 'browser-a', '2026-01-01T00:03:00Z', '/work/reports/3');
  await notice('Notice 4', 'phone-a', '2026-01-01T00:04:00Z', '/work/reports/4');
  await notice('Notice 5', 'device-a', '2026-01-01T00:05:00Z', 'https://example.invalid/');
  await notice('Notice 6', null, '2026-01-01T00:06:00Z', '//elsewhere.example/');
});

after(async () => { await db.close(); });

const readStatements = statements(READ, 'answer');
// The read step's answer: the device check, then the notices page (the recipe's own words, as code).
async function answerRead(deviceId, after = 0, limit = 20) {
  const device = (await run(readStatements.device, [deviceId.trim()])).rows;
  if (device.length === 0 || !['live', 'web-push', 'apns'].includes(device[0].platform)) return { refused: 'This device is not registered to read notices.' };
  const page = (await run(readStatements.notices, [deviceId.trim(), after, limit])).rows;
  const lastId = (await run(readStatements.last, [after])).rows[0].last_id;
  return { route: device[0].platform, notices: page.map(row => ({ id: `told:${row.id}`, title: row.title, read: row.read_at !== null })), cursor: cursorOf(page, limit, lastId) };
}

test('the read recipe answers a device by its route, the notices addressed to it or to every device, and the cursor', async () => {
  const a = await answerRead('device-a');
  assert.deepEqual(a.notices.map(n => n.id), ['told:1', 'told:2', 'told:5', 'told:6']);
  assert.equal(a.cursor, 6);
  assert.equal(a.route, 'live');
  const browser = await answerRead('browser-a');
  assert.deepEqual(browser.notices.map(n => n.id), ['told:2', 'told:3', 'told:6']);
  assert.equal(browser.route, 'web-push');
  assert.equal(browser.cursor, 6);
});

test('a device that is not registered is refused, and a cursor past every notice gives none', async () => {
  assert.equal((await answerRead('nobody')).refused, 'This device is not registered to read notices.');
  const after = await answerRead('browser-a', 6);
  assert.deepEqual(after.notices, []);
  assert.equal(after.cursor, 6);
});

test('a device registered later gets none of the notices made before it registered', async () => {
  const late = await answerRead('late-device');
  assert.deepEqual(late.notices, []);
  assert.equal(late.cursor, 6);
});

test('a full page keeps the cursor at its last notice, so the next page is read after it', async () => {
  const first = await answerRead('device-a', 0, 2);
  assert.deepEqual(first.notices.map(n => n.id), ['told:1', 'told:2']);
  assert.equal(first.cursor, 2);
  const next = await answerRead('device-a', first.cursor, 2);
  assert.deepEqual(next.notices.map(n => n.id), ['told:5', 'told:6']);
  assert.equal(next.cursor, 6);
});

test('the mark recipe marks the notices once and says what it changed', async () => {
  const mark = statements(MARK, 'mark');
  const numbers = [1, 2];
  const before = (await run(mark.found, [numbers])).rows;
  assert.equal(before.length, 2);
  assert.equal(before.filter(row => row.read_at === null).length, 2);
  await run(mark.mark, [numbers]);
  const after = (await run(mark.found, [numbers])).rows;
  assert.ok(after.every(row => row.read_at !== null));
  const firstRead = after[0].read_at;
  await run(mark.mark, [numbers]);
  const again = (await run(mark.found, [numbers])).rows;
  assert.equal(again[0].read_at.getTime(), firstRead.getTime(), 'a repeated mark keeps the first time it was read');
  assert.equal(again.filter(row => row.read_at === null).length, 0, 'a repeated mark changes nothing');
});

test('the act recipe opens a local path, refuses every other action, and refuses a missing notice', async () => {
  const act = statements(ACT, 'act');
  const notice = async n => (await run(statements(ACT, 'act').notice, [n])).rows[0];
  const open = await notice(3);
  assert.equal(open.url, '/work/reports/3');
  await run(act.act, [3]);
  const acted = (await run('SELECT read_at, acted_at FROM notices WHERE id = $1', [3])).rows[0];
  assert.ok(acted.read_at !== null && acted.acted_at !== null);
  assert.equal((await notice(2)).url, null, 'a notice with no url offers no open');
  assert.equal((await notice(5)).url, 'https://example.invalid/', 'a link to another site is refused: its source owner must act');
  assert.equal((await notice(6)).url, '//elsewhere.example/', 'a protocol-relative url is not a path on this site');
  assert.equal((await notice(99)), undefined, 'a notice that does not exist is refused');
});

test('a typed reply is kept once on its notice: its words and the time, a retry of the same words writes nothing, other words are refused', async () => {
  const act = statements(ACT, 'act');
  // The act step's answer for a reply, as the recipe words it.
  const reply = async (n, text) => {
    const trimmed = text.trim();
    if (trimmed === '') return { refused: 'Write the reply to send.' };
    const row = (await run(act.notice, [n])).rows[0];
    if (!row) return { refused: 'There is no such notice.' };
    if (row.answered_at !== null) return row.answer_text === trimmed ? { done: true, said: 'Reply kept.' } : { refused: 'This notice was already answered.' };
    await run(act.reply, [n, trimmed]);
    return { done: true, said: 'Reply kept.' };
  };
  assert.deepEqual(await reply(2, '   '), { refused: 'Write the reply to send.' });
  assert.deepEqual(await reply(2, '  the blue one  '), { done: true, said: 'Reply kept.' });
  const kept = (await run('SELECT answer_text, answered_at, read_at FROM notices WHERE id = $1', [2])).rows[0];
  assert.equal(kept.answer_text, 'the blue one');
  assert.ok(kept.answered_at !== null && kept.read_at !== null);
  assert.deepEqual(await reply(2, 'the blue one'), { done: true, said: 'Reply kept.' });
  assert.deepEqual(await reply(2, 'the red one'), { refused: 'This notice was already answered.' });
  await run(act.reply, [2, 'overwritten']);
  const after = (await run('SELECT answer_text, answered_at FROM notices WHERE id = $1', [2])).rows[0];
  assert.equal(after.answer_text, 'the blue one', 'the reply statement writes only a notice not yet answered');
  assert.equal(after.answered_at.getTime(), kept.answered_at.getTime());
  assert.deepEqual(await reply(99, 'hello'), { refused: 'There is no such notice.' });
});

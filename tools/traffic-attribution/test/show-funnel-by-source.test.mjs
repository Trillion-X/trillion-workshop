// The funnel-by-source read: one fixed statement, its columns and rows as answered, and no connection opened without a held one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { funnelBySource, FUNNEL_SQL } from '../do-work/show-funnel-by-source.mjs';

const journeySql = readFileSync(resolve(import.meta.dirname, '../read-data/journey-steps.sql'), 'utf8');

test('reads the view once with the fixed statement and answers its columns and rows', async () => {
  const sent = [];
  const client = {
    query: async q => { sent.push(q); return { fields: [{ name: 'source' }, { name: 'visitors' }], rows: [{ source: 'instagram', visitors: '3' }] }; },
    end: async () => {},
  };
  const answer = await funnelBySource({ connection: 'postgres://held', proxy: '', connect: async () => client });
  assert.deepEqual(answer, { columns: ['source', 'visitors'], rows: [{ source: 'instagram', visitors: '3' }], row_count: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, FUNNEL_SQL);
});

test('refuses a run with no held connection before opening one', async () => {
  let opened = false;
  await assert.rejects(
    funnelBySource({ connection: '', proxy: '', connect: async () => { opened = true; } }),
    /not held/,
  );
  assert.equal(opened, false);
});

test('the statement reads the two views only, with a row limit and the visitor-first order', () => {
  assert.match(FUNNEL_SQL, /FROM funnel_by_source f FULL JOIN visit_steps_by_source v ON COALESCE/);
  assert.match(FUNNEL_SQL, /LIMIT 500$/);
  assert.doesNotMatch(FUNNEL_SQL, /\*/);
});

test('visits with no kept person still count by their source; the people counts are the same as before', async () => {
  const db = new PGlite();
  await db.exec(journeySql);
  await db.query("INSERT INTO journey_touches (id, destination, source) VALUES ('t1', 'https://x.example/a', $1::jsonb)", [JSON.stringify({ utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'post-a' })]);
  await db.query("INSERT INTO journey_steps (visitor, touch_id, step) VALUES (NULL, 't1', 'visit')");
  await db.query("INSERT INTO journey_steps (visitor, touch_id, step) VALUES ('p1', 't1', 'visit')");
  await db.query("INSERT INTO journey_steps (step, source) VALUES ('visit', $1::jsonb)", [JSON.stringify({ utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'letter' })]);
  await db.query("INSERT INTO journey_steps (step) VALUES ('visit')");
  const rows = (await db.query(FUNNEL_SQL)).rows;
  const by = source => rows.find(row => row.source === source);
  const instagram = by('instagram');
  assert.equal(Number(instagram.visit_steps), 2, 'both instagram visits count, with or without a kept person');
  assert.equal(Number(instagram.visitors), 2, 'the anonymous visit is keyed by its touch, as funnel_by_source has always keyed it');
  const newsletter = by('newsletter');
  assert.equal(Number(newsletter.visit_steps), 1, 'a visit with a source and no person still counts');
  assert.equal(Number(newsletter.visitors), 0, 'and no person is counted for it');
  const unknown = rows.find(row => row.source === null);
  assert.equal(Number(unknown.visit_steps), 1, 'a visit with no source is counted under the unknown source');
  assert.equal(Number(unknown.visitors), 0);
});

// Every value the board's card binds to ($item) is a column the board SQL returns, so a column that draws empty is caught here.
test('each card value binds to a column the board SQL returns', () => {
  const offers = JSON.parse(readFileSync(resolve(import.meta.dirname, '../part.json'), 'utf8')).offers;
  const offer = offers.find(one => one.id === 'tool:show-funnel-by-source');
  const returned = new Set([...FUNNEL_SQL.matchAll(/ AS ([a-z_]+)/g)].map(match => match[1]));
  const bound = Object.values(offer.screen.spec.elements)
    .map(element => element.props?.text)
    .filter(text => text && typeof text === 'object' && '$item' in text)
    .map(text => text.$item);
  assert.ok(bound.length >= 10, 'the card binds its columns');
  for (const field of bound) assert.ok(returned.has(field), `${field} is bound by the card but the board SQL does not return it`);
});

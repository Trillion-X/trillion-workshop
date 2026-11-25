// tools/keep-journey-steps-from-kept-rows/test/site-form-leads.test.mjs
// A lead a site's own form keeps as one statements row (place site-form, meaning lead) becomes one lead journey step through
// the mapping in read-data/journey-kept-rows.json, in PGlite: its email kept only as its key, its visitor and offer carried,
// joined by the cookie when the visitor is known, kept once. Synthetic people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { emailKey } from '../../traffic-attribution/do-work/journey.mjs';
import { keepStepsFromRows } from '../do-work/keep-steps.mjs';
import settings from '../read-data/journey-kept-rows.json' with { type: 'json' };

const journeySql = readFileSync(resolve(import.meta.dirname, '../../traffic-attribution/read-data/journey-steps.sql'), 'utf8');
const mapping = settings.mappings.find(m => m.id === 'site-form-leads-from-statements');

test('a site form\'s lead statement is kept once as a lead step, its email only as its key', async () => {
  assert.ok(mapping, 'the mapping is in the DATA');
  const db = new PGlite();
  await db.exec(journeySql);
  await db.exec(`
    CREATE TABLE statements (key text PRIMARY KEY, source text, place text, meaning text, after jsonb, at timestamptz, recorded_at timestamptz DEFAULT now());
    INSERT INTO statements (key, source, place, meaning, after, at) VALUES
      ('f1', 'site-form', 'site-form', 'lead', '{"email":"Ana@Example.com","visitor":"visitor-a-1","offer_id":"offer:call","self_reported":"a friend"}', now()),
      ('f2', 'site-form', 'site-form', 'lead', '{"email":"ben@example.com","visitor":null,"offer_id":"offer:call"}', now()),
      ('f3', 'site-form', 'site-form', 'other', '{"email":"cy@example.com"}', now());
  `);
  const query = (sql, params) => db.query(sql, params);
  const first = await keepStepsFromRows({ query, mappings: [mapping] });
  assert.deepEqual(first.mappings.map(({ id, read, kept }) => ({ id, read, kept })), [{ id: 'site-form-leads-from-statements', read: 2, kept: 2 }]);
  const { rows } = await db.query("SELECT ref, visitor, email_key, offer_id, joined_by, source FROM journey_steps WHERE step = 'lead' ORDER BY ref");
  assert.deepEqual(rows.map(({ ref, visitor, offer_id, joined_by, source }) => ({ ref, visitor, offer_id, joined_by, source })), [
    { ref: 'site-form:f1', visitor: 'visitor-a-1', offer_id: 'offer:call', joined_by: 'cookie', source: { self_reported: 'a friend' } },
    { ref: 'site-form:f2', visitor: null, offer_id: 'offer:call', joined_by: 'email', source: null },
  ]);
  assert.equal(rows[0].email_key, emailKey('ana@example.com'));
  assert.equal(JSON.stringify(rows).includes('Ana@Example.com'), false, 'the raw email is never kept in a step');
  assert.deepEqual((await keepStepsFromRows({ query, mappings: [mapping] })).mappings.map(({ kept }) => kept), [0]);
});

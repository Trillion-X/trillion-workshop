// tools/keep-journey-steps-from-kept-rows/test/site-checkouts.test.mjs
// A checkout a site's checkout action started, kept as one statements row (place site-checkout, meaning checkout), becomes the
// journey's checkout step through the mapping in read-data/journey-kept-rows.json, in PGlite: its ref the attempt id, its offer
// and visitor carried, joined by the cookie when the visitor is known, else by the touch it followed, else by nothing; kept
// once. Synthetic visitors only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { keepStepsFromRows } from '../do-work/keep-steps.mjs';
import settings from '../read-data/journey-kept-rows.json' with { type: 'json' };

const journeySql = readFileSync(resolve(import.meta.dirname, '../../traffic-attribution/read-data/journey-steps.sql'), 'utf8');
const mapping = settings.mappings.find(m => m.id === 'site-checkouts-from-statements');

test('a site checkout\'s statement is kept once as the checkout step, joined by cookie, else touch, else nothing', async () => {
  assert.ok(mapping, 'the mapping is in the DATA');
  const db = new PGlite();
  await db.exec(journeySql);
  await db.exec(`
    CREATE TABLE statements (key text PRIMARY KEY, source text, place text, meaning text, after jsonb, at timestamptz, recorded_at timestamptz DEFAULT now());
    INSERT INTO statements (key, source, place, meaning, after, at) VALUES
      ('attempt-1', 'site-checkout', 'site-checkout', 'checkout', '{"attempt":"attempt-1","offer_id":"offer:membership","visitor":"visitor-a-1","touch_id":"touch-1"}', now()),
      ('attempt-2', 'site-checkout', 'site-checkout', 'checkout', '{"attempt":"attempt-2","offer_id":"offer:membership","visitor":null,"touch_id":"touch-2"}', now()),
      ('attempt-3', 'site-checkout', 'site-checkout', 'checkout', '{"attempt":"attempt-3","offer_id":"offer:membership"}', now()),
      ('lead-1', 'site-form', 'site-form', 'lead', '{"email":"a@example.com"}', now());
  `);
  const query = (sql, params) => db.query(sql, params);
  const first = await keepStepsFromRows({ query, mappings: [mapping] });
  assert.deepEqual(first.mappings.map(({ id, read, kept }) => ({ id, read, kept })), [{ id: 'site-checkouts-from-statements', read: 3, kept: 3 }]);
  const { rows } = await db.query("SELECT ref, visitor, touch_id, offer_id, joined_by FROM journey_steps WHERE step = 'checkout' ORDER BY ref");
  assert.deepEqual(rows, [
    { ref: 'attempt-1', visitor: 'visitor-a-1', touch_id: 'touch-1', offer_id: 'offer:membership', joined_by: 'cookie' },
    { ref: 'attempt-2', visitor: null, touch_id: 'touch-2', offer_id: 'offer:membership', joined_by: 'touch' },
    { ref: 'attempt-3', visitor: null, touch_id: null, offer_id: 'offer:membership', joined_by: null },
  ]);
  assert.deepEqual((await keepStepsFromRows({ query, mappings: [mapping] })).mappings.map(({ kept }) => kept), [0], 'kept once');
});

// tools/keep-journey-steps-from-kept-rows/test/site-visits.test.mjs
// A visit a site's page beacon keeps as one statements row (place site-visit, meaning visit) becomes the journey kit's own visit
// step through the mapping in read-data/journey-kept-rows.json, in PGlite: its kept parameters, the referrer's host and the
// landing path as its source, joined by the touch it followed, else by the cookie; a direct visit and a check keep nothing;
// kept once. Synthetic visitors only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { keepStepsFromRows } from '../do-work/keep-steps.mjs';
import settings from '../read-data/journey-kept-rows.json' with { type: 'json' };

const journeySql = readFileSync(resolve(import.meta.dirname, '../../traffic-attribution/read-data/journey-steps.sql'), 'utf8');
const mapping = settings.mappings.find(m => m.id === 'site-visits-from-statements');

test('a site beacon\'s visit statement is kept once as the journey kit\'s visit step; a direct visit or a check is not', async () => {
  assert.ok(mapping, 'the mapping is in the DATA');
  const db = new PGlite();
  await db.exec(journeySql);
  await db.exec(`
    CREATE TABLE statements (key text PRIMARY KEY, source text, place text, meaning text, after jsonb, at timestamptz, recorded_at timestamptz DEFAULT now());
    INSERT INTO statements (key, source, place, meaning, after, at) VALUES
      ('v1', 'site-visit', 'site-visit', 'visit', '{"href":"https://site.example.test/courses/a?utm_source=post&utm_campaign=spring&t=touch-1&other=x","referrer":"https://www.search.example.test/q","visitor":"visitor-a-1"}', now()),
      ('v2', 'site-visit', 'site-visit', 'visit', '{"href":"https://site.example.test/?utm_source=mail","visitor":"visitor-b-1"}', now()),
      ('v3', 'site-visit', 'site-visit', 'visit', '{"href":"https://site.example.test/?utm_source=bio","visitor":null}', now()),
      ('v4', 'site-visit', 'site-visit', 'visit', '{"href":"https://site.example.test/articles","visitor":"visitor-c-1"}', now()),
      ('v5', 'site-visit', 'site-visit', 'visit', '{"href":"https://site.example.test/?utm_source=x&utm_content=check","visitor":null}', now()),
      ('v6', 'site-visit', 'site-visit', 'visit', '{"href":"not an address"}', now()),
      ('l1', 'site-form', 'site-form', 'lead', '{"email":"a@example.com"}', now());
  `);
  const query = (sql, params) => db.query(sql, params);
  const first = await keepStepsFromRows({ query, mappings: [mapping] });
  assert.deepEqual(first.mappings.map(({ id, read, kept }) => ({ id, read, kept })), [{ id: 'site-visits-from-statements', read: 6, kept: 3 }]);
  const { rows } = await db.query("SELECT ref, visitor, touch_id, joined_by, source FROM journey_steps WHERE step = 'visit' ORDER BY ref");
  assert.deepEqual(rows, [
    { ref: 'site-visit:v1', visitor: 'visitor-a-1', touch_id: 'touch-1', joined_by: 'touch', source: { utm_source: 'post', utm_campaign: 'spring', t: 'touch-1', referrer_host: 'www.search.example.test', landing_path: '/courses/a' } },
    { ref: 'site-visit:v2', visitor: 'visitor-b-1', touch_id: null, joined_by: 'cookie', source: { utm_source: 'mail', landing_path: '/' } },
    { ref: 'site-visit:v3', visitor: null, touch_id: null, joined_by: null, source: { utm_source: 'bio', landing_path: '/' } },
  ]);
  assert.deepEqual((await keepStepsFromRows({ query, mappings: [mapping] })).mappings.map(({ kept }) => kept), [0], 'kept once');
});

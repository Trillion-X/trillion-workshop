import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { consumeRankedReviewForJsCore } from './suggested-match-jscore.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('JSCore-compatible entry consumes same projection and owner-action carrier', async () => {
  const descriptors = await readJson(join(packageRoot, 'data/ranked-review-descriptors.json'));
  const fixtures = await readJson(join(packageRoot, 'fixtures/ranked-review-fixtures.json'));
  const result = consumeRankedReviewForJsCore({
    descriptor: descriptors.projection,
    records: fixtures.sparse.records,
    related: fixtures.sparse.related,
    actionContext: { actor_ref: 'actor.ios' },
  });

  assert.equal(result.projection.rows.length, 2);
  assert.equal(result.request.target, 'slot::workflow');
  assert.equal(result.request.payload.input.actor_ref, 'actor.ios');
});

test('JSCore-compatible entry keeps empty state as projection data', async () => {
  const descriptors = await readJson(join(packageRoot, 'data/ranked-review-descriptors.json'));
  const fixtures = await readJson(join(packageRoot, 'fixtures/ranked-review-fixtures.json'));
  const result = consumeRankedReviewForJsCore({
    descriptor: descriptors.projection,
    records: fixtures.empty.records,
    related: fixtures.empty.related,
  });

  assert.equal(result.projection.rows.length, 0);
  assert.equal(result.request, null);
});

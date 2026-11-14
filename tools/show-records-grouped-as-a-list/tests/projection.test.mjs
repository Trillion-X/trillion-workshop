import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { foldRecordProjection } from '../read-data/read-record-projection.mjs';
import {
  applyProjectionChanges,
  createProjectionState,
  snapshotMaintainedProjection,
} from '../read-data/maintained-projection.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadData() {
  const descriptors = await readJson(join(packageRoot, 'data/record-projection-descriptors.json'));
  const fixtures = await readJson(join(packageRoot, 'fixtures/record-projection-fixtures.json'));
  return { descriptor: descriptors.projection, fixtures };
}

test('folds empty projection with stable proof counts', async () => {
  const { descriptor, fixtures } = await loadData();
  const snapshot = foldRecordProjection({
    descriptor,
    records: fixtures.empty.records,
    related: fixtures.empty.related,
    cursor: 'empty',
  });

  assert.equal(snapshot.projectionId, 'group-list.directory');
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.proof.recordCount, 0);
  assert.equal(snapshot.cursor, 'empty');
  console.log('[group-list] record projection folded');
});

test('folds sparse records, relationship counts, display text, and action refs', async () => {
  const { descriptor, fixtures } = await loadData();
  const snapshot = foldRecordProjection({
    descriptor,
    records: fixtures.sparse.records,
    related: fixtures.sparse.related,
  });

  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows[0].recordId, 'record.alpha');
  assert.equal(snapshot.rows[0].values.title.text, 'Local gardening crew');
  assert.equal(snapshot.rows[0].relationships.participants, 2);
  assert.equal(snapshot.rows[0].actions.length, 2);
  assert.equal(snapshot.rows[0].actions[1].target, 'slot::workflow');
});

test('preserves future descriptor values without code changes', async () => {
  const { descriptor, fixtures } = await loadData();
  const snapshot = foldRecordProjection({
    descriptor,
    records: fixtures.futureDomain.records,
    related: fixtures.futureDomain.related,
  });

  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].values.access.raw, 'waitlist');
  assert.equal(snapshot.rows[0].values.access.text, 'waitlist');
  assert.equal(snapshot.rows[0].actions[1].enabled, true);
  console.log('[group-list] future descriptor value preserved');
});

test('applies delete and resurrect events through maintained projection state', async () => {
  const { descriptor, fixtures } = await loadData();
  let state = createProjectionState();
  state = applyProjectionChanges(state, fixtures.deleteResurrect.events);
  const snapshot = snapshotMaintainedProjection({ state, descriptor });

  assert.equal(snapshot.cursor, '003');
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].recordId, 'record.delta');
  assert.equal(snapshot.rows[0].values.title.text, 'Delta room restored');
  assert.equal(snapshot.rows[0].values.access.raw, 'request');
});

test('accepts injected descriptor methods instead of adding package-specific branches', async () => {
  const { descriptor, fixtures } = await loadData();
  const customDescriptor = {
    ...descriptor,
    filters: [{ id: 'only-custom', method: 'custom.keep', params: { keep: true } }],
  };
  const snapshot = foldRecordProjection({
    descriptor: customDescriptor,
    records: fixtures.dense.records,
    methods: {
      'custom.keep': ({ params }) => params.keep === true,
    },
  });

  assert.equal(snapshot.rows.length, 3);
});

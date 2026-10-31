// tools/rank-records-for-review: the ranking fold, the person's stands on its rows, the accept or pass request, and the
// folder's vocabulary. Carried from bitfield-packages packages/suggested-match: read-data/ranked-record-review-projection.test.mjs
// (all six), do-work/owner-action-request.test.mjs (four of five; the sender test is gone with the sender) and
// tests/boundary.test.mjs (the descriptor and vocabulary checks, against this folder). Fixtures are the package's own
// made-up records.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyRankedReviewEvents,
  createRankedReviewState,
  foldRankedRecordReviewProjection,
  snapshotRankedReviewProjection,
  validateRankedRecordReviewDescriptor,
} from '../read-data/rank-records-for-review.mjs';
import { buildStandRequest } from '../do-work/stand-request.mjs';

const folder = join(import.meta.dirname, '..');
const readJson = async path => JSON.parse(await readFile(join(folder, path), 'utf8'));

async function data() {
  const descriptors = await readJson('read-data/example-review-descriptor.json');
  const fixtures = await readJson('test/fixtures/ranked-review-fixtures.json');
  return { descriptor: descriptors.projection, fixtures };
}

test('folds empty projection with stable proof counts', async () => {
  const { descriptor, fixtures } = await data();
  const snapshot = foldRankedRecordReviewProjection({ descriptor, records: fixtures.empty.records, related: fixtures.empty.related, cursor: 'empty' });
  assert.equal(snapshot.projectionId, 'example.ranked-review');
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.cursor, 'empty');
  assert.equal(snapshot.proof.recordCount, 0);
});

test('folds sparse ranked records without a domain schema', async () => {
  const { descriptor, fixtures } = await data();
  const snapshot = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, related: fixtures.sparse.related });
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows[0].recordId, 'record.alpha');
  assert.equal(snapshot.rows[0].values.primary.text, 'Alpha record');
  assert.equal(snapshot.rows[0].relationships['evidence-count'], 2);
  assert.equal(snapshot.rows[0].statusKeys.confidence, 'high');
  assert.equal(snapshot.rows[0].actions[0].stance, 'agree');
  assert.equal(snapshot.rows[1].statusKeys.action, 'queued');
});

test('orders rows by rank and preserves stable refs', async () => {
  const { descriptor, fixtures } = await data();
  const snapshot = foldRankedRecordReviewProjection({ descriptor, records: fixtures.dense.records, related: fixtures.dense.related });
  assert.deepEqual(snapshot.rows.map(row => row.recordId), ['record.first', 'record.second', 'record.third']);
});

test('preserves future descriptor values without code changes', async () => {
  const { descriptor, fixtures } = await data();
  const snapshot = foldRankedRecordReviewProjection({ descriptor, records: fixtures.futureDomain.records, related: fixtures.futureDomain.related });
  assert.equal(snapshot.rows[0].statusKeys.confidence, 'brand_new_signal');
  assert.equal(snapshot.rows[0].statusKeys.action, 'future_operation_state');
  assert.equal(snapshot.rows[0].values.reason.text, 'Future vocabulary stays data.');
});

test('applies delete and resurrect events through maintained projection state', async () => {
  const { descriptor, fixtures } = await data();
  const state = applyRankedReviewEvents(createRankedReviewState(), fixtures.events);
  const snapshot = snapshotRankedReviewProjection({ state, descriptor });
  assert.equal(snapshot.cursor, '003');
  assert.deepEqual(snapshot.rows.map(row => row.recordId), ['record.restored']);
});

test('accepts injected methods instead of adding branches', async () => {
  const { descriptor, fixtures } = await data();
  const customDescriptor = { ...descriptor, filters: [{ id: 'external-filter', method: 'external.keep', params: { keep: true } }] };
  const snapshot = foldRankedRecordReviewProjection({ descriptor: customDescriptor, records: fixtures.dense.records,
    methods: { 'external.keep': ({ params }) => params.keep === true } });
  assert.equal(snapshot.rows.length, 3);
  assert.throws(() => foldRankedRecordReviewProjection({ descriptor: { ...descriptor, filters: [{ method: 'never.registered' }] }, records: fixtures.dense.records }),
    /not registered: never.registered/);
});

test('each row carries the person\'s newest stand on its view; a stand of another kind, another view or taken back is none', async () => {
  const { descriptor, fixtures } = await data();
  const view = { record: 'record.alpha', candidates: ['record.beta'] };
  const stands = [
    { kind: 'suggestion', view, stance: 'disagree', why: 'Not these two.', at: '2026-01-01T00:00:00Z' },
    { kind: 'suggestion', view, stance: 'agree', why: 'These two, after all.', at: '2026-01-02T00:00:00Z' },
    { kind: 'title', view, stance: 'disagree', at: '2026-01-03T00:00:00Z' },
    { kind: 'suggestion', view: { record: 'record.gamma', candidates: ['record.delta'] }, stance: null, at: '2026-01-03T00:00:00Z' },
  ];
  const snapshot = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands });
  assert.deepEqual(snapshot.rows[0].standView, view);
  assert.deepEqual([snapshot.rows[0].stand.stance, snapshot.rows[0].stand.why], ['agree', 'These two, after all.']);
  assert.equal(snapshot.rows[1].stand, null);
  assert.equal(snapshot.proof.stoodCount, 1);
});

test('a newest version that takes the stand back means no stand; an older stand in the history is not revived', async () => {
  const { descriptor, fixtures } = await data();
  const view = { record: 'record.alpha', candidates: ['record.beta'] };
  const agree = { kind: 'suggestion', view, stance: 'agree', why: 'Yes.', at: '2026-01-01T00:00:00Z' };
  const takenBack = { kind: 'suggestion', view, stance: null, at: '2026-01-02T00:00:00Z' };
  const again = { kind: 'suggestion', view, stance: 'disagree', at: '2026-01-03T00:00:00Z' };
  const standFor = stands => foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands }).rows[0].stand;
  assert.equal(standFor([agree, takenBack]), null);
  assert.equal(standFor([takenBack, agree]), null, 'the order of the list does not matter, the time does');
  assert.equal(standFor([agree, takenBack, again]).stance, 'disagree');
  assert.equal(standFor([again, takenBack, agree]).stance, 'disagree');
  assert.equal(standFor([agree, { ...takenBack, at: undefined }]).stance, 'agree', 'a version with no time is oldest');
  assert.equal(foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands: [agree, takenBack] }).proof.stoodCount, 0);
});

test('a record with no rank has rank null, comes after every ranked row, and the answer survives JSON', async () => {
  const { descriptor } = await data();
  const records = [
    { record_ref: 'record.z-unranked' },
    { record_ref: 'record.b-ranked', rank: 2 },
    { record_ref: 'record.a-unranked', rank: 'high' },
    { record_ref: 'record.a-ranked', rank: 2 },
    { record_ref: 'record.nan', rank: Number.NaN },
    { record_ref: 'record.first', rank: 0 },
  ];
  const snapshot = foldRankedRecordReviewProjection({ descriptor, records });
  assert.deepEqual(snapshot.rows.map(row => row.recordId), ['record.first', 'record.a-ranked', 'record.b-ranked', 'record.a-unranked', 'record.nan', 'record.z-unranked']);
  assert.deepEqual(snapshot.rows.map(row => row.rank), [0, 2, 2, null, null, null]);
  const again = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(again.rows.map(row => row.rank), snapshot.rows.map(row => row.rank));
});

test('the example descriptor holds only what the fold reads', async () => {
  const { descriptor, fixtures } = await data();
  const file = await readJson('read-data/example-review-descriptor.json');
  assert.deepEqual(Object.keys(file).sort(), ['projection', 'what_this_is']);
  const read = new Set(['id', 'source', 'recordIdPath', 'rankPath', 'standKind', 'standView', 'statusKeyPaths', 'fields', 'relationships', 'filters', 'actions']);
  assert.deepEqual(Object.keys(descriptor).filter(key => !read.has(key)), []);
  assert.ok(foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records }).rows.length);
});

async function firstAction(index = 0) {
  const { descriptor, fixtures } = await data();
  const snapshot = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records });
  return { row: snapshot.rows[0], action: snapshot.rows[0].actions[index] };
}

test('accept builds a keep-where-you-stand request on the row\'s view, with the person\'s words from the input', async () => {
  const { row, action } = await firstAction();
  const request = buildStandRequest({ ...action, lookup: { row, input: { why: 'Yes, these belong together.' } } });
  assert.equal(request.tool, 'tool:keep-where-you-stand');
  assert.deepEqual(request.input, { kind: 'suggestion', view: { record: 'record.alpha', candidates: ['record.beta'] },
    stance: 'agree', answered_by: 'person', why: 'Yes, these belong together.' });
  assert.equal(request.row_ref, 'record.alpha');
  assert.equal(request.unchanged, false);
});

test('the request carries a deterministic idempotency ref: the same act has the same ref, another action or other words another', async () => {
  const { row, action } = await firstAction();
  const accept = words => buildStandRequest({ ...action, lookup: { row, input: words } });
  const first = accept({ why: 'Yes.' });
  assert.equal(first.idempotency_ref, `idempotency:alpha:primary-review-action:${encodeURIComponent('{"why":"Yes."}')}`);
  assert.equal(accept({ why: 'Yes.' }).idempotency_ref, first.idempotency_ref);
  assert.notEqual(accept({ why: 'Yes, really.' }).idempotency_ref, first.idempotency_ref);
  assert.equal(accept({}).idempotency_ref, 'idempotency:alpha:primary-review-action');
  const pass = await firstAction(1);
  assert.equal(buildStandRequest({ ...pass.action, lookup: { row: pass.row } }).idempotency_ref, 'idempotency:alpha:secondary-review-action');
  const noRef = { ...row, idempotencyRef: undefined };
  assert.equal(buildStandRequest({ ...action, lookup: { row: noRef } }).idempotency_ref, 'record.alpha:primary-review-action');
  assert.equal(first.request_ref, first.idempotency_ref);
  assert.equal(buildStandRequest({ ...action, lookup: { row, requestRef: 'caller:1' } }).request_ref, 'caller:1');
});

test('stands kept without a time still make a new ref for every act: accept, pass, accept, pass never repeats one', async () => {
  const { descriptor, fixtures } = await data();
  const view = { record: 'record.alpha', candidates: ['record.beta'] };
  const stands = [];
  const refs = [];
  for (const which of [0, 1, 0, 1]) {
    const { rows } = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands });
    const request = buildStandRequest({ ...rows[0].actions[which], lookup: { row: rows[0] } });
    refs.push(request.idempotency_ref);
    stands.push({ kind: 'suggestion', view, stance: request.input.stance });
  }
  assert.equal(new Set(refs).size, 4, refs.join(' '));
  const { rows } = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands });
  assert.equal(rows[0].standVersion, 'n4');
  assert.equal(rows[0].stand.stance, 'disagree');
  const timed = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands: [{ ...stands[0], at: '2026-01-01T00:00:00Z' }] });
  assert.equal(timed.rows[0].standVersion, '2026-01-01T00:00:00Z', 'a version with a time is named by its time');
});

test('a second accept with the stand already on the row is unchanged; other words or the other stance are not', async () => {
  const { descriptor, fixtures } = await data();
  const view = { record: 'record.alpha', candidates: ['record.beta'] };
  const stands = [{ kind: 'suggestion', view, stance: 'agree', why: 'Yes.', at: '2026-01-01T00:00:00Z' }];
  const { rows } = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands });
  const [accept, pass] = rows[0].actions;
  const run = (action, input) => buildStandRequest({ ...action, lookup: { row: rows[0], input } });
  assert.equal(run(accept, { why: 'Yes.' }).unchanged, true);
  assert.equal(run(accept, { why: 'Yes, and more.' }).unchanged, false);
  assert.equal(run(accept, {}).unchanged, false);
  assert.equal(run(pass, { why: 'Yes.' }).unchanged, false);
  const blank = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands: [{ ...stands[0], why: '  ' }] }).rows[0];
  assert.equal(buildStandRequest({ ...blank.actions[0], lookup: { row: blank, input: {} } }).unchanged, true);
});

test('accept, pass, accept again are three acts with three refs, and a taken-back stand still makes the next ref new', async () => {
  const { descriptor, fixtures } = await data();
  const view = { record: 'record.alpha', candidates: ['record.beta'] };
  const stands = [];
  const step = (n) => {
    const { rows } = foldRankedRecordReviewProjection({ descriptor, records: fixtures.sparse.records, stands });
    return { row: rows[0], accept: rows[0].actions[0], pass: rows[0].actions[1], at: `2026-01-0${n}T00:00:00Z` };
  };
  const keep = (request, at) => stands.push({ kind: 'suggestion', view, stance: request.input.stance, at });
  const one = step(1);
  const first = buildStandRequest({ ...one.accept, lookup: { row: one.row } });
  assert.equal(first.idempotency_ref, 'idempotency:alpha:primary-review-action');
  keep(first, one.at);
  const two = step(2);
  const second = buildStandRequest({ ...two.pass, lookup: { row: two.row } });
  assert.equal(second.unchanged, false);
  keep(second, two.at);
  const three = step(3);
  const third = buildStandRequest({ ...three.accept, lookup: { row: three.row } });
  assert.equal(third.unchanged, false);
  assert.equal(third.input.stance, 'agree');
  assert.equal(third.idempotency_ref, `idempotency:alpha:primary-review-action@${encodeURIComponent(two.at)}`);
  assert.equal(new Set([first, second, third].map(request => request.idempotency_ref)).size, 3);
  stands.push({ kind: 'suggestion', view, at: '2026-01-04T00:00:00Z' });
  const four = step(4);
  assert.equal(four.row.stand, null);
  assert.equal(four.row.standVersion, '2026-01-04T00:00:00Z');
  const fourth = buildStandRequest({ ...four.accept, lookup: { row: four.row } });
  assert.notEqual(fourth.idempotency_ref, first.idempotency_ref);
  assert.notEqual(fourth.idempotency_ref, third.idempotency_ref);
});

test('accept-or-pass prints the refs as the last line, as the tool runs it', async () => {
  const { descriptor, fixtures } = await data();
  const stands = [{ kind: 'suggestion', view: { record: 'record.alpha', candidates: ['record.beta'] }, stance: 'agree', why: 'Yes.', at: '2026-01-01T00:00:00Z' }];
  const request = { descriptor, record: fixtures.sparse.records[0], action_id: 'primary-review-action', input: { why: 'Yes.' }, stands };
  const out = await new Promise((resolve, reject) => {
    const child = execFile('node', [join(folder, 'do-work', 'accept-or-pass.mjs')], (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout.trim().split('\n').pop())));
    child.stdin.end(JSON.stringify(request));
  });
  const { result } = JSON.parse(out);
  assert.equal(result.unchanged, true);
  assert.equal(result.row_ref, 'record.alpha');
  assert.match(result.idempotency_ref, /^idempotency:alpha:primary-review-action:/);
  assert.equal(result.input.stance, 'agree');
});

test('pass is a disagree, and a copy rule may take a value or read the row', async () => {
  const { row, action } = await firstAction(1);
  assert.equal(buildStandRequest({ ...action, lookup: { row } }).input.stance, 'disagree');
  const custom = { id: 'later', stance: 'partly', copy: [{ key: 'by', value: 'review-screen' }, { key: 'why', from: 'row.values.reason.text' }] };
  assert.deepEqual(buildStandRequest({ ...custom, lookup: { row } }).input, { kind: 'suggestion', view: row.standView, stance: 'partly',
    answered_by: 'person', by: 'review-screen', why: 'Shared context appears in multiple source records.' });
});

test('disabled actions, actions with no stance, copies outside a stand and rows not from the fold are refused', async () => {
  const { row } = await firstAction();
  assert.throws(() => buildStandRequest({ id: 'blocked', stance: 'agree', enabled: false, disabledReason: 'Blocked by descriptor.', lookup: { row } }), /Blocked by descriptor/);
  assert.throws(() => buildStandRequest({ id: 'none', lookup: { row } }), /names no stance/);
  assert.throws(() => buildStandRequest({ id: 'leak', stance: 'agree', copy: [{ key: 'record_ref', from: 'row.recordId' }], lookup: { row } }), /takes only why, by, at/);
  assert.throws(() => buildStandRequest({ id: 'bare', stance: 'agree', lookup: { row: { recordId: 'x' } } }), /must come from the fold/);
});

test('the descriptor keeps methods and vocabulary open, and names the parts a stand is on', async () => {
  const { descriptor } = await data();
  validateRankedRecordReviewDescriptor(descriptor);
  const text = JSON.stringify(descriptor);
  assert.match(text, /"method"/);
  assert.match(text, /"params"/);
  assert.doesNotMatch(text, /"enum"\s*:|"oneOf"\s*:|"anyOf"\s*:/);
  const { standView: _view, ...noView } = descriptor;
  assert.throws(() => validateRankedRecordReviewDescriptor(noView), /standView/);
  const { standKind: _kind, ...noKind } = descriptor;
  assert.throws(() => validateRankedRecordReviewDescriptor(noKind), /standKind/);
});

test('the code names no domain, runs nothing and holds no second owner', async () => {
  const files = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path.endsWith('.mjs')) files.push(path);
    }
  };
  await walk(join(folder, 'read-data'));
  await walk(join(folder, 'do-work'));
  const text = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(text, /suggested_match|match_request|match_explanation/);
  assert.doesNotMatch(text, /\blead\b|\bloss\b|\bcampaign\b|\bprovider\b|\bcalendar\b|\bmail\b/);
  assert.doesNotMatch(text, /fetch\s*\(|XMLHttpRequest|spawn\s*\(|execFile|credentials-vault/);
  assert.doesNotMatch(text, /slot::|process_session|blake3/i);
});

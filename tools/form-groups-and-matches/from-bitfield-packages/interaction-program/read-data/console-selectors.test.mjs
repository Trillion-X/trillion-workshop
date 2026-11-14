// packages/interaction-program/read-data/console-selectors.test.mjs
//
// Tests the Community-console selectors against the ACTUAL seed payloads in
// things-to-store-and-run.json (imported, not copy-pasted) + the DELETION TEST:
// a completely different community's rows (novel roles + novel permission
// strings) must produce a working model with ZERO code change (gate §32).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildMeasureModels,
  buildProgramModels,
  buildRoleMatrix,
  buildSequenceModels,
  buildSurfaceModels,
  normalizeRows,
  togglePermission,
} from './console-selectors.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const things = JSON.parse(
  readFileSync(path.join(here, '..', 'things-to-store-and-run.json'), 'utf8'),
).things;

function seedPayloads(kind) {
  return things
    .map((t) => t.payload)
    .filter((p) => p && typeof p === 'object' && p.kind === kind);
}

test('role matrix (T5) from the actual member-type seeds: has the four seeded tribe roles', () => {
  const seeds = seedPayloads('interaction-program.member-type');
  const matrix = buildRoleMatrix(seeds);
  assert.deepStrictEqual(matrix.rows.map((r) => r.role).sort(), ['guest', 'member', 'moderator', 'owner']);
});

test('role matrix (T5) from the actual member-type seeds: columns are the UNION of permission strings in the DATA (no hardcoded list)', () => {
  const seeds = seedPayloads('interaction-program.member-type');
  const matrix = buildRoleMatrix(seeds);
  const allPerms = new Set(seeds.flatMap((s) => s.permissions));
  assert.deepStrictEqual(new Set(matrix.columns), allPerms);
  for (const row of matrix.rows) assert.strictEqual(row.cells.length, matrix.columns.length);
});

test('role matrix (T5) from the actual member-type seeds: grants reflect each row exactly', () => {
  const seeds = seedPayloads('interaction-program.member-type');
  const matrix = buildRoleMatrix(seeds);
  const owner = matrix.rows.find((r) => r.role === 'owner');
  const guest = matrix.rows.find((r) => r.role === 'guest');
  assert.deepStrictEqual(
    owner.cells.filter((c) => c.granted).map((c) => c.column).sort(),
    [...seeds.find((s) => s.role === 'owner').permissions].sort(),
  );
  assert.deepStrictEqual(
    guest.cells.filter((c) => c.granted).map((c) => c.column).sort(),
    [...seeds.find((s) => s.role === 'guest').permissions].sort(),
  );
});

test('role matrix (T5) from the actual member-type seeds: togglePermission adds and removes immutably', () => {
  const guest = seedPayloads('interaction-program.member-type').find((s) => s.role === 'guest');
  const withMatch = togglePermission(guest, 'match');
  assert.ok(withMatch.permissions.includes('match'));
  assert.ok(!guest.permissions.includes('match'));
  const without = togglePermission(withMatch, 'match');
  assert.ok(!without.permissions.includes('match'));
});

test('DELETION TEST (gate §32) novel community, novel permissions, zero code change: renders a matrix for rows the code has never seen', () => {
  const basketball = [
    { kind: 'interaction-program.member-type', id: 'bb:coach', community: 'basketball', role: 'coach', permissions: ['set-lineup', 'call-timeout', 'bench'] },
    { kind: 'interaction-program.member-type', id: 'bb:captain', community: 'basketball', role: 'captain', permissions: ['call-timeout', 'huddle'] },
    { kind: 'interaction-program.member-type', id: 'bb:player', community: 'basketball', role: 'player', permissions: ['huddle'] },
  ];
  const matrix = buildRoleMatrix(basketball);
  assert.deepStrictEqual(matrix.columns, ['set-lineup', 'call-timeout', 'bench', 'huddle']);
  assert.deepStrictEqual(matrix.rows.map((r) => r.role), ['coach', 'captain', 'player']);
  const captain = matrix.rows.find((r) => r.role === 'captain');
  assert.strictEqual(captain.cells.find((c) => c.column === 'call-timeout').granted, true);
  assert.strictEqual(captain.cells.find((c) => c.column === 'set-lineup').granted, false);
});

test('measures (T6), sequences + surfaces (T7), programs from the actual seeds: measure seed produces a display model without op/window vocabulary', () => {
  const models = buildMeasureModels(seedPayloads('measure-definition'));
  assert.ok(models.length >= 1);
  const cp = models.find((m) => m.id.includes('connection_points'));
  assert.strictEqual(cp.title, 'connection points');
  assert.strictEqual(cp.failClosed, true);
});

test('measures (T6), sequences + surfaces (T7), programs from the actual seeds: daily-sequence seed yields ordered days with human copy', () => {
  const models = buildSequenceModels(seedPayloads('interaction-program.daily-sequence'));
  assert.ok(models.length >= 1);
  const days = models[0].days;
  assert.ok(days.length >= 3);
  assert.deepStrictEqual(days.map((d) => d.day), [...days.map((d) => d.day)].sort((a, b) => a - b));
  assert.ok(days[0].title.length > 0);
});

test('measures (T6), sequences + surfaces (T7), programs from the actual seeds: surface seed yields a compose_via pointer (opaque)', () => {
  const models = buildSurfaceModels(seedPayloads('interaction-program.surface'));
  assert.ok(models.length >= 1);
  assert.ok(models[0].composeVia.length > 0);
});

test('measures (T6), sequences + surfaces (T7), programs from the actual seeds: the five seeded programs summarize by present refs', () => {
  const models = buildProgramModels(seedPayloads('interaction-program'));
  assert.ok(models.length >= 5);
  for (const m of models) assert.ok(m.refCount > 0);
});

test('fail-soft normalization: skips malformed rows, accepts wrapped rows, never throws', () => {
  assert.deepStrictEqual(normalizeRows(null), []);
  assert.deepStrictEqual(
    normalizeRows([null, 42, 'x', { payload: { kind: 'k', id: 'a' } }, { kind: 'k', id: 'b' }]),
    [{ kind: 'k', id: 'a' }, { kind: 'k', id: 'b' }],
  );
  assert.deepStrictEqual(buildRoleMatrix(undefined).rows, []);
  assert.deepStrictEqual(buildMeasureModels([{ noId: true }]), []);
});

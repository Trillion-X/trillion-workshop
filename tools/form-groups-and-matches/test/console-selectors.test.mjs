// The community console's selectors, on made-up rows. Carried from the original console test: the role matrix (its
// columns are the union of the rows' permission strings, its grants match each row, toggling is immutable), the
// deletion test (a novel community with novel roles and permissions renders with no code change), the measure, sequence,
// surface and program models, and fail-soft normalization. The original read its seed rows from the package's
// things-to-store-and-run.json; those rows are not in this folder, so the same assertions run on made-up rows of the
// same shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMatchModels, buildMeasureModels, buildProgramModels, buildRoleMatrix, buildSequenceModels, buildSetupModels,
  buildSurfaceModels, normalizeRows, togglePermission,
} from '../read-data/console-selectors.mjs';

const circleRoles = [
  { kind: 'interaction-program.member-type', id: 'circle:steward', community: 'circle', role: 'steward', permissions: ['post', 'invite', 'moderate', 'match'] },
  { kind: 'interaction-program.member-type', id: 'circle:member', community: 'circle', role: 'member', permissions: ['post', 'match'] },
  { kind: 'interaction-program.member-type', id: 'circle:helper', community: 'circle', role: 'helper', permissions: ['post', 'assist'] },
  { kind: 'interaction-program.member-type', id: 'circle:visitor', community: 'circle', role: 'visitor', permissions: ['read'] },
];

test('the role matrix has one row per role, with the rows the community authored', () => {
  const matrix = buildRoleMatrix(circleRoles);
  assert.deepEqual(matrix.rows.map((r) => r.role).sort(), ['helper', 'member', 'steward', 'visitor']);
});

test('matrix columns are the union of the permission strings in the data, and every row has one cell per column', () => {
  const matrix = buildRoleMatrix(circleRoles);
  const all = new Set(circleRoles.flatMap((s) => s.permissions));
  assert.deepEqual(new Set(matrix.columns), all);
  assert.equal(matrix.columns.length, all.size);
  for (const row of matrix.rows) assert.equal(row.cells.length, matrix.columns.length);
});

test('grants reflect each row exactly', () => {
  const matrix = buildRoleMatrix(circleRoles);
  const steward = matrix.rows.find((r) => r.role === 'steward');
  const visitor = matrix.rows.find((r) => r.role === 'visitor');
  assert.deepEqual(steward.cells.filter((c) => c.granted).map((c) => c.column).sort(), [...circleRoles[0].permissions].sort());
  assert.deepEqual(visitor.cells.filter((c) => c.granted).map((c) => c.column), ['read']);
});

test('togglePermission adds and removes a permission immutably', () => {
  const visitor = circleRoles[3];
  const withMatch = togglePermission(visitor, 'match');
  assert.ok(withMatch.permissions.includes('match'));
  assert.equal(visitor.permissions.includes('match'), false);
  const without = togglePermission(withMatch, 'match');
  assert.equal(without.permissions.includes('match'), false);
});

test('DELETION TEST: a novel community with novel roles and permissions renders with no code change', () => {
  const basketball = [
    { kind: 'interaction-program.member-type', id: 'bb:coach', community: 'basketball', role: 'coach', permissions: ['set-lineup', 'call-timeout', 'bench'] },
    { kind: 'interaction-program.member-type', id: 'bb:captain', community: 'basketball', role: 'captain', permissions: ['call-timeout', 'huddle'] },
    { kind: 'interaction-program.member-type', id: 'bb:player', community: 'basketball', role: 'player', permissions: ['huddle'] },
  ];
  const matrix = buildRoleMatrix(basketball);
  assert.deepEqual(matrix.columns, ['set-lineup', 'call-timeout', 'bench', 'huddle']);
  assert.deepEqual(matrix.rows.map((r) => r.role), ['coach', 'captain', 'player']);
  const captain = matrix.rows.find((r) => r.role === 'captain');
  assert.equal(captain.cells.find((c) => c.column === 'call-timeout').granted, true);
  assert.equal(captain.cells.find((c) => c.column === 'set-lineup').granted, false);
});

test('a measure row becomes a display model whose title is its id tail, with no operator vocabulary', () => {
  const models = buildMeasureModels([{ kind: 'measure-definition', id: 'measure:circle_points', emit: 'points', failClosed: true }]);
  assert.equal(models.length, 1);
  assert.equal(models[0].title, 'circle points');
  assert.equal(models[0].failClosed, true);
  assert.equal(models[0].emit, 'points');
});

test('daily-sequence rows yield their days in order with human copy', () => {
  const models = buildSequenceModels([{
    kind: 'interaction-program.daily-sequence', id: 'circle:weekly-themes', for_program: 'weekly-circle',
    days: [
      { day: 2, title: 'Second day', prompt_text: 'Ask one question.' },
      { day: 1, title: 'First day', prompt_text: 'Say hello.' },
      { day: 3, title: 'Third day', prompt_text: 'Share a win.' },
    ],
  }]);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].days.map((d) => d.day), [1, 2, 3]);
  assert.equal(models[0].days[0].title, 'First day');
  assert.equal(models[0].row.id, 'circle:weekly-themes');
});

test('a surface row yields a compose_via pointer, opaque', () => {
  const models = buildSurfaceModels([{ kind: 'interaction-program.surface', id: 'circle:home', for_program: 'weekly-circle', compose_via: 'documents.page:circle-home' }]);
  assert.equal(models.length, 1);
  assert.equal(models[0].composeVia, 'documents.page:circle-home');
});

test('a program is summarized by the *_ref fields it carries', () => {
  const models = buildProgramModels([
    { kind: 'interaction-program', id: 'weekly-circle', group_ref: 'group:circle-members', surface_ref: 'documents.page:circle-home', label: 'Weekly' },
    { kind: 'interaction-program', id: 'empty-refs', group_ref: '' },
  ]);
  assert.equal(models[0].refCount, 2);
  assert.equal(models[1].refCount, 0);
});

test('setup items show their own name, or their id with separators read as spaces, and default to type item', () => {
  const models = buildSetupModels([
    { id: 'weekly_pairs', type: 'ritual', purpose: 'pair members each week' },
    { id: 'house-rules' },
  ]);
  assert.deepEqual(models.map((m) => [m.name, m.type, m.purpose]), [['weekly pairs', 'ritual', 'pair members each week'], ['house rules', 'item', '']]);
});

test('a formed match shows its members, program, score and rationale from its own attributes', () => {
  const models = buildMatchModels([
    { id: 'connection:1', members: ['member:a', 'member:b'], attributes: { program_id: 'weekly-circle', match_score: 0.82, match_rationale: 'both bake sourdough' } },
    { id: 'connection:2', source: 'member:c', target: 'member:d' },
  ]);
  assert.deepEqual(models[0].members, ['member:a', 'member:b']);
  assert.equal(models[0].program, 'weekly-circle');
  assert.equal(models[0].score, 0.82);
  assert.equal(models[0].rationale, 'both bake sourdough');
  assert.deepEqual(models[1].members, ['member:c', 'member:d']);
  assert.equal(models[1].score, null);
});

test('fail-soft: malformed rows are skipped, wrapped rows are read, and nothing throws', () => {
  assert.deepEqual(normalizeRows(null), []);
  assert.deepEqual(normalizeRows([null, 42, 'x', { payload: { kind: 'k', id: 'a' } }, { kind: 'k', id: 'b' }]), [{ kind: 'k', id: 'a' }, { kind: 'k', id: 'b' }]);
  assert.deepEqual(buildRoleMatrix(undefined).rows, []);
  assert.deepEqual(buildMeasureModels([{ noId: true }]), []);
  assert.deepEqual(buildSequenceModels('nonsense'), []);
});

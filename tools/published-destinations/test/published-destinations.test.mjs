// Tests for tools/published-destinations. The fixtures are a made-up bakery.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { honestStateProblems } from '../read-data/check-honest-state.mjs';
import {
  decodeDestinationDescriptor,
  findDestinationDescriptor,
  finishedCelebratingRefs,
} from '../read-data/read-destination.mjs';

const descriptor = {
  kind: 'destination-descriptor',
  ref: 'destination:bakery',
  kicker: 'Bakery',
  statement: 'A statement.',
  subtitle: 'A subtitle.',
  subject_ref: 'subject:bakery',
  projection_ref: 'projection:bakery',
  progression_ref: 'progression:bakery',
  sections: [
    { presentation: 'stat-strip', stats: [{ value: '3', label: 'Loaves' }] },
    {
      presentation: 'task-list',
      label: 'Today',
      column: 'main',
      items: [{ ref: 'q1', title: 'Bake a loaf', percent: 100, fraction: '2/2', chip: '+10', tone: 'positive', celebrate: true }],
    },
    { presentation: 'progress-ring', column: 'rail', percent: 72, ring_label: '72%' },
    { presentation: 'pulse', column: 'rail', bars: [{ value: 70, tone: 'positive' }] },
  ],
};

const honest = {
  kind: 'destination-descriptor',
  ref: 'destination:bakery-progress',
  subject_ref: 'subject:one',
  statement: 'Progress appears after accepted activity.',
  sections: [
    { presentation: 'stat-strip', stats: [] },
    { presentation: 'task-list', items: [{ ref: 'q1', title: 'Bake one loaf' }] },
    { presentation: 'rank-list', items: [] },
    { presentation: 'pulse', bars: [] },
    { presentation: 'progress-ring' },
  ],
};

test('decodes the owner-evaluated values it is given and nothing else', () => {
  const decoded = decodeDestinationDescriptor(descriptor);
  assert.notEqual(decoded, null);
  assert.equal(decoded.subjectRef, 'subject:bakery');
  assert.equal(decoded.projectionRef, 'projection:bakery');
  assert.equal(decoded.progressionRef, 'progression:bakery');
  assert.equal(decoded.sections[0].stats[0].value, '3');
  assert.equal(decoded.sections[1].items[0].percent, 100);
  assert.deepEqual(finishedCelebratingRefs(decoded), ['q1']);
});

test('a celebration needs both the owner flag and a complete percent', () => {
  const decoded = decodeDestinationDescriptor({
    statement: 'x',
    sections: [{ presentation: 'task-list', items: [
      { ref: 'a', title: 'A', percent: 99, celebrate: true },
      { ref: 'b', title: 'B', percent: 100 },
      { ref: 'c', title: 'C', celebrate: true },
      { ref: 'd', title: 'D', percent: 120, celebrate: true },
    ] }],
  });
  assert.deepEqual(finishedCelebratingRefs(decoded), ['d']);
});

test('absent or malformed descriptors decode to null', () => {
  assert.equal(decodeDestinationDescriptor(null), null);
  assert.equal(decodeDestinationDescriptor({}), null);
  assert.equal(decodeDestinationDescriptor({ statement: 'x', sections: [] }), null);
  assert.equal(decodeDestinationDescriptor({ statement: 'x', sections: [{}] }), null);
});

test('hostile unbounded rows are dropped and a valid prefix is kept', () => {
  const decoded = decodeDestinationDescriptor({
    statement: 'x',
    sections: Array.from({ length: 100 }, () => ({
      presentation: 'item-list',
      items: [...Array.from({ length: 500 }, (_, index) => ({ title: `t${index}` })), { nope: true }],
    })),
  });
  assert.equal(decoded.sections.length, 64);
  assert.equal(decoded.sections[0].items.length, 200);
});

test('an unseen presentation key is passed through, never refused', () => {
  const decoded = decodeDestinationDescriptor({ statement: 'x', sections: [{ presentation: 'never-seen-before', body: 'b' }] });
  assert.equal(decoded.sections[0].presentation, 'never-seen-before');
  assert.equal(decoded.sections[0].column, 'main');
});

const rows = [{ record: { address: 'a:1', source_package: 'owner' }, payload: descriptor }];

test('a subject-scoped descriptor is found only for the exact subject', () => {
  assert.notEqual(findDestinationDescriptor(rows, 'destination:bakery', 'subject:bakery'), null);
  assert.equal(findDestinationDescriptor(rows, 'destination:bakery', 'subject:other'), null);
  assert.equal(findDestinationDescriptor(rows, 'destination:bakery'), null);
  assert.equal(findDestinationDescriptor(rows, 'destination:other', 'subject:bakery'), null);
});

test('an unscoped descriptor is found, and wrong kinds and invalid cells are skipped', () => {
  const { subject_ref: _gone, ...unscoped } = descriptor;
  assert.notEqual(findDestinationDescriptor([
    { payload: 'not-an-object' },
    { payload: { ...unscoped, kind: 'something-else' } },
    { payload: JSON.stringify(unscoped) },
    { payload: unscoped },
  ], 'destination:bakery'), null);
  assert.equal(findDestinationDescriptor('not rows', 'destination:bakery'), null);
});

test('a serialized descriptor is not a row: strings are never parsed', () => {
  assert.equal(findDestinationDescriptor([{ payload: JSON.stringify(descriptor) }], 'destination:bakery', 'subject:bakery'), null);
  assert.equal(findDestinationDescriptor([{ path: JSON.stringify(descriptor) }], 'destination:bakery', 'subject:bakery'), null);
});

test('an honest successor has no problems, and an unseen presentation key is fine', () => {
  assert.deepEqual(honestStateProblems(honest), []);
  assert.deepEqual(honestStateProblems({ ...honest, sections: [{ presentation: 'unseen-owner-view', items: [], stats: [], bars: [] }] }), []);
});

test('values the owner has to work out are refused, and every one is reported', () => {
  const problems = honestStateProblems({
    ...honest,
    sections: [
      { presentation: 'rank-list', items: [{ title: 'Invented', rank: 1, percent: 50, actor: 'someone' }] },
      { presentation: 'progress-ring', percent: 1 },
      { presentation: 'pulse', bars: [{ value: 3 }] },
      { presentation: 'stat-strip', stats: [{ value: '1', label: 'x' }] },
    ],
  });
  assert.equal(problems.length, 6);
  assert.match(problems[0], /section 1, item 1: "actor" must start empty/);
  assert.match(problems.join('\n'), /section 2: "percent" must start empty/);
  assert.match(problems.join('\n'), /section 3: bars must start empty/);
  assert.match(problems.join('\n'), /section 4: stats must start empty/);
});

test('a descriptor is for one subject and carries a ref and a statement', () => {
  assert.deepEqual(
    honestStateProblems({ kind: 'destination-descriptor', sections: [{ presentation: 'text' }] }),
    ['ref is required', 'subject_ref is required: the descriptor is for one subject', 'statement is required'],
  );
  assert.match(honestStateProblems({ ...honest, sections: [] })[0], /sections must hold 1 to 64/);
  assert.match(honestStateProblems({ kind: 'other' })[0], /not a destination descriptor/);
  assert.match(honestStateProblems(null)[0], /not a destination descriptor/);
});

test('keys the person refuses are found anywhere in the descriptor, and none are refused by default', () => {
  const nested = { ...honest, sections: [{ presentation: 'task-list', items: [{ title: 'Unsafe', track: { writes: { award: {} } } }] }] };
  assert.deepEqual(honestStateProblems(nested), []);
  assert.deepEqual(honestStateProblems(nested, { refuseKeys: ['award', 'writes'] }), [
    'it contains the refused key "award"',
    'it contains the refused key "writes"',
  ]);
});

const tool = (file, input) => JSON.parse(execFileSync('node', [new URL(`../do-work/${file}`, import.meta.url).pathname], { input: JSON.stringify(input) }).toString().trim().split('\n').pop());

test('the find tool prints found, the descriptor and the finished refs', () => {
  const found = tool('find-a-destination.mjs', { rows, ref: 'destination:bakery', subject_ref: 'subject:bakery' });
  assert.equal(found.found, true);
  assert.equal(found.descriptor.statement, 'A statement.');
  assert.deepEqual(found.finished_refs, ['q1']);
  assert.deepEqual(tool('find-a-destination.mjs', { rows, ref: 'destination:bakery' }), { found: false, descriptor: null, finished_refs: [] });
});

test('the check tool prints honest and the problems, with refuse_keys read from the input', () => {
  assert.deepEqual(tool('check-a-destination-is-honest.mjs', { descriptor: honest }), { honest: true, problems: [] });
  const bad = tool('check-a-destination-is-honest.mjs', { descriptor: { ...honest, extra: { award: 1 } }, refuse_keys: ['award'] });
  assert.equal(bad.honest, false);
  assert.deepEqual(bad.problems, ['it contains the refused key "award"']);
});

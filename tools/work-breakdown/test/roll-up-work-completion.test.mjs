// Carried from bitfield-packages/packages/work-breakdown/tests/roll-up-work-completion.test.mjs.
//
// The tests that carry the weight are the refusals and the unverified case. A roll-up that reports a cheerful
// percentage for any tree it is handed is indistinguishable from one that never looked, so the first thing proven
// here is what it turns away.
//
// Changed: the Workshop tool takes the tree as a value (`rollUpWork(tree, options)`, `readTree(tree)`) where the
// package read a file (`load(path)`, `run(['--tree', path])`), so the tests pass the tree itself. Not carried:
// the three cases of the package's `--out`/`--heading` file writer and its usage line, which the Workshop tool does
// not have (it returns the checklist instead of writing a file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_STATES,
  TreeRefused,
  measure,
  readTree,
  renderChecklist,
  rollUpWork,
  shareFinished,
} from '../do-work/roll-up-work-completion.mjs';

const leaf = (id, extra = {}) => ({id, title: id, ...extra});

test('a tree that writes its own completion down is refused, not quietly corrected', () => {
  const tree = {title: 'T', children: [{id: 'a', title: 'a', percent: 80, children: [leaf('a1')]}]};
  assert.throws(() => readTree(tree), /cannot also be written down/);
  assert.throws(() => readTree(tree), /a\.percent/);
});

test('every authored completion spelling is caught, not just the one word', () => {
  for (const field of ['completion', 'percent', 'percentage', 'progress', 'done_count']) {
    assert.throws(() => readTree({title: 'T', children: [leaf('a', {[field]: 1})]}), new RegExp(`a\\.${field}`));
  }
});

test('a leaf in a state the tree never declared is refused rather than guessed at', () => {
  const tree = {title: 'T', children: [leaf('a', {state: 'nearly'})]};
  assert.throws(() => readTree(tree), /never declared/);
  assert.throws(() => readTree(tree), /a=nearly/);
});

test('done with nothing to point at is counted apart and never as finished', () => {
  const totals = measure(leaf('a', {state: 'done'}), DEFAULT_STATES);
  assert.equal(totals.finished, 0, 'an unverified claim must not count as finished');
  assert.equal(totals.claimed, 1);
  assert.equal(totals.claimed_without_verification, true);
});

test('done with verification counts, and the two cases give different shares', () => {
  const claimed = measure({id: 'r', children: [leaf('a', {state: 'done'}), leaf('b', {state: 'open'})]}, DEFAULT_STATES);
  const proven = measure(
    {id: 'r', children: [leaf('a', {state: 'done', verified_by: 'screenshot.png'}), leaf('b', {state: 'open'})]},
    DEFAULT_STATES,
  );
  assert.equal(shareFinished(claimed), 0);
  assert.equal(shareFinished(proven), 50);
  assert.notEqual(shareFinished(claimed), shareFinished(proven));
});

test('a parent cannot be marked done to make its branch look finished', () => {
  const totals = measure({id: 'p', state: 'done', verified_by: 'x', children: [leaf('a'), leaf('b')]}, DEFAULT_STATES);
  assert.equal(totals.finished, 0);
  assert.equal(totals.leaves, 2);
});

test('nesting is unbounded and a deep leaf still reaches the top-level count', () => {
  let node = leaf('deepest', {state: 'done', verified_by: 'proof'});
  for (let depth = 0; depth < 12; depth += 1) node = {id: `d${depth}`, children: [node]};
  const totals = measure(node, DEFAULT_STATES);
  assert.equal(totals.leaves, 1);
  assert.equal(totals.finished, 1);
  assert.equal(shareFinished(totals), 100);
});

test('a state map is DATA, so a tree can name states this file has never heard of', () => {
  const states = {
    shipped: {label: 'shipped', counts_as_finished: true, needs_verification: false},
    thinking: {label: 'thinking', counts_as_finished: false, needs_verification: false},
  };
  const totals = measure({id: 'r', children: [leaf('a', {state: 'shipped'}), leaf('b', {state: 'thinking'})]}, states);
  assert.equal(totals.finished, 1, 'a state that needs no verification counts on its own');
  assert.equal(totals.claimed, 0);
});

test('the roll-up reports counts for each declared state without changing completion math', () => {
  const result = rollUpWork({
    title: 'T',
    states: {
      started: {label: 'Started', counts_as_finished: false, needs_verification: false},
      implemented: {label: 'Implemented', counts_as_finished: false, needs_verification: true},
      verified: {label: 'Verified', counts_as_finished: true, needs_verification: true},
    },
    children: [
      leaf('a', {state: 'started'}),
      leaf('b', {state: 'implemented'}),
      leaf('c', {state: 'verified', verified_by: 'live readback'}),
    ],
  });
  assert.deepEqual(result.state_counts, {done: 0, open: 0, blocked: 0, started: 1, implemented: 1, verified: 1});
  assert.equal(result.finished, 1);
  assert.equal(result.leaves, 3);
  assert.equal(result.share_finished, 33.3);
});

test('the checklist marks the three outcomes differently', () => {
  const checklist = renderChecklist(
    {
      id: 'r',
      children: [
        leaf('proven', {state: 'done', verified_by: 'shot.png'}),
        leaf('claimed', {state: 'done'}),
        leaf('open', {state: 'open'}),
      ],
    },
    DEFAULT_STATES,
  );
  const lines = checklist.split('\n');
  assert.match(lines[0], /^- \[x\] proven/);
  assert.match(lines[1], /^- \[~\] claimed/);
  assert.match(lines[2], /^- \[ \] open/);
  assert.match(lines[0], /proof: shot\.png/);
});

test('the checklist carries provenance and the wall, because both are why an item sits there', () => {
  const checklist = renderChecklist(
    {
      id: 'r',
      children: [leaf('a', {state: 'blocked', blocked_by: 'the sender is not an allowed one', said: [{session: 's1', ordinal: 7}]})],
    },
    DEFAULT_STATES,
  );
  assert.match(checklist, /wall: the sender is not an allowed one/);
  assert.match(checklist, /asked: s1#7/);
});

test('depth limits what is rendered without changing what is counted', () => {
  const tree = {id: 'r', children: [{id: 'a', title: 'a', children: [leaf('a1', {state: 'done', verified_by: 'p'})]}]};
  const shallow = renderChecklist(tree, DEFAULT_STATES, 0);
  assert.ok(!shallow.includes('a1'), 'a depth limit must actually cut the render');
  assert.match(shallow, /1\/1, 100%/, 'the count still comes from the whole subtree');
});

test('an empty parent reports no share rather than a made-up hundred per cent', () => {
  assert.equal(shareFinished(measure({id: 'r', children: []}, DEFAULT_STATES)), null);
});

test('the report names every unverified id, so a claim cannot hide inside an average', () => {
  const result = rollUpWork({
    title: 'T',
    children: [
      leaf('honest', {state: 'done', verified_by: 'proof'}),
      leaf('hopeful', {state: 'done'}),
      leaf('stuck', {state: 'blocked', blocked_by: 'no key'}),
    ],
  });
  assert.deepEqual(result.unverified_ids, ['hopeful']);
  assert.deepEqual(result.blocked_items, [{id: 'stuck', wall: 'no key'}]);
  assert.equal(result.finished, 1);
  assert.equal(result.leaves, 3);
});

test('`only` reports one branch, and an id nobody has is refused rather than answered', () => {
  const tree = {
    title: 'T',
    children: [
      {id: 'x', title: 'x', children: [leaf('x1', {state: 'done', verified_by: 'p'})]},
      {id: 'y', title: 'y', children: [leaf('y1')]},
    ],
  };
  const only = rollUpWork(tree, {only: 'x'});
  assert.equal(only.leaves, 1);
  assert.equal(only.share_finished, 100);
  assert.throws(() => rollUpWork(tree, {only: 'nope'}), /no item in this tree/);
});

test('no tree at all is refused, never an empty pass', () => {
  assert.throws(() => rollUpWork(undefined), TreeRefused);
  assert.throws(() => rollUpWork(undefined), /must be a JSON object/);
});

test('the written summary names the claims and the walls, not only the share', () => {
  const result = rollUpWork(
    {title: 'T', children: [leaf('hopeful', {state: 'done'}), leaf('stuck', {state: 'blocked', blocked_by: 'no key'})]},
    {as: 'checklist'},
  );
  assert.match(result.summary, /said done with nothing to point at/);
  assert.match(result.summary, /1 blocked/);
});

test('a later decision that governs how an item is built is shown on its line', () => {
  const checklist = renderChecklist(
    {id: 'r', children: [leaf('a', {through: 'the shared table, not a second filter form'})]},
    DEFAULT_STATES,
  );
  assert.match(checklist, /build it through: the shared table, not a second filter form/);
});

test('routing set on a branch reaches every leaf under it, at any depth', () => {
  const checklist = renderChecklist(
    {
      id: 'r',
      children: [{id: 'branch', title: 'branch', through: 'the new substrate', children: [{id: 'mid', title: 'mid', children: [leaf('deep')]}]}],
    },
    DEFAULT_STATES,
  );
  assert.match(checklist, /- \[ \] deep.*build it through: the new substrate/);
});

test('a leaf with its own routing keeps it, so a branch rule never overwrites a specific one', () => {
  const checklist = renderChecklist(
    {id: 'r', children: [{id: 'branch', title: 'branch', through: 'the branch rule', children: [leaf('special', {through: 'its own rule'})]}]},
    DEFAULT_STATES,
  );
  assert.match(checklist, /- \[ \] special.*build it through: its own rule/);
  assert.ok(!/special.*the branch rule/.test(checklist), 'the branch rule must not also appear on the leaf');
});

test('open items nobody has decided how to build are named, and finished ones are not', () => {
  const result = rollUpWork({
    title: 'T',
    children: [
      {id: 'governed', title: 'governed', through: 'the new way', children: [leaf('a'), leaf('b')]},
      leaf('nobody-decided'),
      leaf('already-built', {state: 'done', verified_by: 'proof'}),
    ],
  });
  assert.deepEqual(result.unrouted_open_ids, ['nobody-decided']);
  assert.equal(result.routed_leaves, 2);
  assert.deepEqual(result.routings, [{through: 'the new way', leaves: 2}]);
});

test('routings are reported most-used first, so the governing decision leads', () => {
  const result = rollUpWork({
    title: 'T',
    children: [
      {id: 'big', title: 'big', through: 'decision X', children: [leaf('a'), leaf('b'), leaf('c')]},
      {id: 'small', title: 'small', through: 'decision Y', children: [leaf('d')]},
    ],
  });
  assert.deepEqual(result.routings, [
    {through: 'decision X', leaves: 3},
    {through: 'decision Y', leaves: 1},
  ]);
});

// The Workshop seam: the command the tool container runs.
const command = new URL('../do-work/roll-up-work-completion.mjs', import.meta.url).pathname;

test('the command prints one JSON line and refuses a tree that writes its completion down', () => {
  const ok = spawnSync(process.execPath, [command, JSON.stringify({tree: {title: 'T', children: [leaf('a', {state: 'done', verified_by: 'p'})]}})], {encoding: 'utf8'});
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout.trim().split('\n').at(-1)).share_finished, 100);
  const refused = spawnSync(process.execPath, [command, JSON.stringify({tree: {title: 'T', children: [leaf('a', {percent: 50})]}})], {encoding: 'utf8'});
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /cannot also be written down/);
});

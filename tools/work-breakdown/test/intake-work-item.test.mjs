// Carried from bitfield-packages/packages/work-breakdown/tests/intake-work-item.test.mjs.
//
// Not carried: the two cases of the package's file writer (`appendWorkItem`: atomic write, leaves no lock file; fails
// closed when another writer holds the lock). The Workshop tool takes the tree as a value and hands it back with the
// item in it, so it writes no file and has no lock. The command case at the end is added at the Workshop seam.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {intakeWorkItem, IntakeRefused} from '../do-work/intake-work-item.mjs';

const baseTree = () => ({
  id: 'work',
  title: 'Work',
  states: {open: {counts_as_finished: false}, done: {counts_as_finished: true, needs_verification: true}},
  children: [
    {id: 'tracking', title: 'Tracking', children: []},
    {id: 'existing', title: 'Existing', state: 'open', said: [{session: 's1', ordinal: 2}]},
  ],
});
const item = overrides => ({
  id: 'ui.sidebar.new-list',
  title: 'Add a clearly visible control for creating a list',
  parent_id: 'tracking',
  said: [{session: 'example-session', ordinal: 14}],
  checks: ['The control is visible in the running sidebar', 'Creating a list persists after relaunch'],
  ...overrides,
});

test('adds a new open leaf with message attribution and verification checks', () => {
  const tree = baseTree();
  const result = intakeWorkItem(tree, item());
  assert.equal(result.changed, true);
  assert.deepEqual(tree.children[0].children[0], {
    id: 'ui.sidebar.new-list',
    title: 'Add a clearly visible control for creating a list',
    state: 'open',
    said: [{session: 'example-session', ordinal: 14}],
    checks: ['The control is visible in the running sidebar', 'Creating a list persists after relaunch'],
  });
});

test('replaying the same id and message is idempotent', () => {
  const tree = baseTree();
  intakeWorkItem(tree, item());
  const result = intakeWorkItem(tree, item());
  assert.equal(result.changed, false);
  assert.equal(tree.children[0].children.length, 1);
});

test('a new example can be attributed to its existing owning leaf', () => {
  const tree = baseTree();
  const result = intakeWorkItem(tree, item({
    id: 'ui.sidebar.new-list-example',
    attach_to: 'existing',
    said: [{session: 'example-session', ordinal: 15}],
  }));
  assert.equal(result.changed, true);
  assert.deepEqual(tree.children[1].said, [
    {session: 's1', ordinal: 2},
    {session: 'example-session', ordinal: 15},
  ]);
  assert.equal(tree.children[0].children.length, 0);
});

test('a later correction replaces current wording and checks while retaining every source', () => {
  const tree = baseTree();
  const result = intakeWorkItem(tree, item({
    attach_to: 'existing',
    title: 'Keep the intro under seven seconds',
    checks: ['A saved edit is seven seconds or shorter'],
    correction: true,
    said: [{session: 'example-session', ordinal: 15}],
  }));
  assert.equal(result.changed, true);
  assert.equal(tree.children[1].title, 'Keep the intro under seven seconds');
  assert.deepEqual(tree.children[1].checks, ['A saved edit is seven seconds or shorter']);
  assert.deepEqual(tree.children[1].said, [
    {session: 's1', ordinal: 2},
    {session: 'example-session', ordinal: 15},
  ]);
  assert.throws(() => intakeWorkItem(tree, item({
    attach_to: 'existing',
    title: 'A different correction under the same message identity',
    checks: ['A different current check'],
    correction: true,
    said: [{session: 'example-session', ordinal: 15}],
  })), /replayed with different correction content/);
});

test('refuses missing attribution, unknown parents, source reuse, and unknown states', () => {
  const tree = baseTree();
  assert.throws(() => intakeWorkItem(tree, item({said: []})), IntakeRefused);
  assert.throws(() => intakeWorkItem(tree, item({parent_id: 'missing'})), /unknown parent_id/);
  assert.throws(() => intakeWorkItem(tree, item({said: [{session: 's1', ordinal: 2}]})), /already belongs to existing/);
  assert.throws(() => intakeWorkItem(tree, item({state: 'maybe'})), /undeclared state/);
  assert.equal(tree.children[0].children.length, 0);
});

test('refuses reusing an item id for different content', () => {
  const tree = baseTree();
  intakeWorkItem(tree, item());
  assert.throws(() => intakeWorkItem(tree, item({title: 'Different request', said: [{session: 'example-session', ordinal: 16}]})), /already exists with different content/);
});

test('the command hands back the tree with the item in it, and refuses an item with no source', () => {
  const command = new URL('../do-work/intake-work-item.mjs', import.meta.url).pathname;
  const run = input => spawnSync(process.execPath, [command, JSON.stringify(input)], {encoding: 'utf8'});
  const added = run({tree: baseTree(), item: item()});
  assert.equal(added.status, 0, added.stderr);
  const answer = JSON.parse(added.stdout.trim().split('\n').at(-1));
  assert.equal(answer.changed, true);
  assert.equal(answer.tree.children[0].children[0].id, 'ui.sidebar.new-list');
  const refused = run({tree: baseTree(), item: item({said: []})});
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /source attribution is required/);
});

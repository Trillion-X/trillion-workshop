import test from 'node:test';
import assert from 'node:assert/strict';
import { recordBlock, readBlocks } from '../src/work-blocks.mjs';

function store() {
  const rows = new Map([['message:one', { speaker: 'person', text: 'Make a launch checklist now' }], ['message:two', { speaker: 'person', text: 'The checklist needs clear steps' }], ['handoff:one', { state: 'finished' }]]);
  return { read: id => rows.get(id) ?? null, ids: type => [...rows.keys()].filter(id => id.startsWith(`${type}:`)), write: entries => entries.forEach(entry => rows.set(entry.id, entry.value)) };
}

test('blocks keep validated source spans, parent links and proof, with idempotent retries', () => {
  const eeaf = store();
  const first = recordBlock(eeaf, { source_id: 'message:one', start: 7, end: 13, title: 'Launch checklist', proof: [{ kind: 'handoff', id: 'handoff:one' }] });
  assert.equal(first.repeated, false);
  const child = recordBlock(eeaf, { source_id: 'message:one', parent_id: first.block.id, title: 'Check wording', state: 'done', proof: [{ kind: 'handoff', id: 'handoff:one' }] });
  assert.equal(child.block.parent_id, first.block.id);
  assert.equal(recordBlock(eeaf, { source_id: 'message:one', start: 7, end: 13, title: 'Launch checklist' }).repeated, true);
  assert.equal(readBlocks(eeaf).length, 2);
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:one', title: '' }), /source_id and title/);
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:missing', title: 'Lost source' }), /source record was not found/);
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:one', start: 7, end: 100, title: 'Bad range' }), /not in the source/);
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:one', start: 7, title: 'Half range' }), /both the start and end/);
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:one', parent_id: 'block:missing', title: 'Lost parent' }), /parent block/);
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:one', title: 'Unproved completion', state: 'done' }), /linked result/);
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:one', title: 'False proof', proof: [{ kind: 'file', id: 'file:missing' }] }), /proof link/);
  const progressed = recordBlock(eeaf, { source_id: 'message:one', start: 7, end: 13, title: 'Launch checklist', state: 'in_progress', progress: 40 });
  assert.equal(progressed.block.progress, 40);
  assert.equal(recordBlock(eeaf, { source_id: 'message:one', start: 7, end: 13, title: 'Launch checklist', state: 'in_progress', progress: 40 }).repeated, true);
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:one', title: 'Invalid percent', progress: 101 }), /whole percentage/);
  const linked = recordBlock(eeaf, { source_id: 'message:one', start: 7, end: 13, title: 'Launch checklist', sources: [{ source_id: 'message:two', start: 4, end: 13 }] });
  assert.equal(linked.block.sources[0].source_id, 'message:two');
  assert.throws(() => recordBlock(eeaf, { source_id: 'message:one', title: 'Invalid extra source', sources: [{ source_id: 'message:missing' }] }), /Every extra source/);
});

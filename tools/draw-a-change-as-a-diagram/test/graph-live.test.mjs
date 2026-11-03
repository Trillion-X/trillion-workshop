// tools/draw-a-change-as-a-diagram/test/graph-live.test.mjs
//
// A reader's own AI steers an open graph picture through typed commands (parts/ui/show/layer-diagram/graph-live.mjs): every id
// is checked against the document, the parts named come back with where they are drawn, a sketch applies to a copy, and the
// commands are DATA.
import assert from 'node:assert/strict';
import test from 'node:test';
import liveRules from '../read-data/graph-live.json' with { type: 'json' };
import { renderGraphDocument } from '../do-work/graph-contract.mjs';
import { graphAddresses, resolveLiveCommand } from '../do-work/graph-live.mjs';

const doc = () => ({
  schema_version: 1, id: 'change', label: 'Change',
  lanes: [{ id: 'callers', label: 'Callers', nodes: [{ id: 'web', label: 'Web', delta: 'unchanged' }] },
    { id: 'core', label: 'Core', nodes: [{ id: 'pay', label: 'Payment', delta: 'modified' }] }],
  edges: [{ from: 'web', to: 'pay', delta: 'unchanged' }],
});
const codes = (command) => resolveLiveCommand(doc(), command).errors.map((error) => [error.code, error.path]);

test('a document is addressed by its own ids: lanes, nodes and edges as from>to', () => {
  assert.deepEqual([...graphAddresses(doc())], ['callers', 'web', 'core', 'pay', 'web>pay']);
});

test('show returns where the named parts are drawn, in both orientations, from the same atlas', () => {
  const result = resolveLiveCommand(doc(), { kind: 'show', focus: ['pay', 'web>pay', 'core'], note: 'Look here' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const atlas = renderGraphDocument(doc()).atlas;
  assert.deepEqual(result.boxes.across.nodes, atlas.across.boxes.filter((box) => ['pay', 'core'].includes(box.id)));
  assert.deepEqual(result.boxes.down.edges, atlas.down.edges);
  assert.equal(result.sketch, null);
});

test('answer leads through steps and lets the AI say it cannot tell', () => {
  const result = resolveLiveCommand(doc(), { kind: 'answer', question: 'What changed?', steps: [
    { heading: 'The payment service', focus: ['pay'], parts: ['It now retries once.'] },
    { heading: 'Who calls it', focus: ['web'], cannot_tell: true, parts: ['The picture does not say how often.'] }] });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.focus, ['pay', 'web']);
});

test('an id the document does not hold, a wrong shape or an unknown command is refused with its path', () => {
  assert.deepEqual(codes({ kind: 'show', focus: ['pay', 'ghost'] }), [['UNKNOWN_ID', 'command.focus[1]']]);
  assert.deepEqual(codes({ kind: 'answer', question: 'q', steps: [{ heading: 'h', focus: ['web>web'] }] }), [['UNKNOWN_ID', 'command.steps[0].focus[0]']]);
  assert.deepEqual(codes({ kind: 'answer', question: 'q', steps: [] }), [['TOO_FEW', 'command.steps']]);
  assert.deepEqual(codes({ kind: 'answer', question: 'q', steps: Array.from({ length: 5 }, () => ({ heading: 'h' })) }), [['TOO_MANY', 'command.steps']]);
  assert.deepEqual(codes({ kind: 'show' }), [['MISSING_FIELD', 'command.focus']]);
  assert.deepEqual(codes({ kind: 'show', focus: ['pay'], x: 3 }), [['UNKNOWN_FIELD', 'command.x']]);
  assert.deepEqual(codes({ kind: 'answer', question: 'q'.repeat(501), steps: [{ heading: 'h' }] }), [['TOO_LONG', 'command.question']]);
  assert.deepEqual(codes({ kind: 'answer', question: 'q', steps: [{ heading: 'h', cannot_tell: 'yes' }] }), [['WRONG_TYPE', 'command.steps[0].cannot_tell']]);
  assert.deepEqual(codes({ kind: 'run' }), [['UNKNOWN_COMMAND', 'command.kind']]);
  assert.deepEqual(codes('show'), [['NOT_AN_OBJECT', 'command']]);
});

test('a sketch applies to a copy; the document is untouched and a bad operation is refused with its path', () => {
  const document = doc();
  const before = JSON.stringify(document);
  const result = resolveLiveCommand(document, { kind: 'sketch', under: ['core'], ops: [
    { op: 'add_node', lane: 'core', value: { id: 'ledger', label: 'Ledger', delta: 'added' } }, { op: 'add_edge', value: { from: 'pay', to: 'ledger', delta: 'added' } }] });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(JSON.stringify(document), before);
  assert.deepEqual(result.sketch.lanes[1].nodes.map((node) => node.id), ['pay', 'ledger']);
  const bad = resolveLiveCommand(document, { kind: 'sketch', under: ['core'], ops: [{ op: 'remove_node', id: 'ghost' }] });
  assert.deepEqual(bad.errors.map((error) => [error.code, error.path]), [['NOT_FOUND', 'command.ops[0]']]);
});

test('a command is a row: adding one needs no code', () => {
  const rules = structuredClone(liveRules);
  rules.commands.compare = { required: ['a', 'b'], fields: { a: { type: 'ids', most: 1 }, b: { type: 'ids', most: 1 } } };
  const result = resolveLiveCommand(doc(), { kind: 'compare', a: ['web'], b: ['pay'] }, rules);
  assert.equal(result.ok, true);
  assert.deepEqual(result.focus, ['web', 'pay']);
  assert.equal(resolveLiveCommand(doc(), { kind: 'compare', a: ['web'], b: ['ghost'] }, rules).errors[0].code, 'UNKNOWN_ID');
});

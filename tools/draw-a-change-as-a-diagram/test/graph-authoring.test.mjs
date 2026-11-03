// tools/draw-a-change-as-a-diagram/test/graph-authoring.test.mjs
//
// Asking a model for a graph document (parts/ui/show/layer-diagram/graph-authoring.mjs): the message and the schema are the
// validator's own rules read from DATA, the host's facts overwrite the model's, its words are made safe before they are
// validated, a refusal is fed back once with the validator's own findings, and a second refusal ends in a typed failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../read-data/graph-contract.json' with { type: 'json' };
import authoring from '../read-data/graph-authoring.json' with { type: 'json' };
import { validateGraphDocument } from '../do-work/graph-contract.mjs';
import { authorGraphDocument, containDocumentText, containModelText, graphAuthoringBrief, readModelObject, repairMessage, stampHostFields } from '../do-work/graph-authoring.mjs';

const good = () => ({
  schema_version: 99, id: 'change', label: 'A change',
  lanes: [{ id: 'core', label: 'Core', nodes: [{ id: 'pay', label: 'Pay', delta: 'modified' }, { id: 'ledger', label: 'Ledger', delta: 'added' }] }],
  edges: [{ from: 'pay', to: 'ledger', delta: 'added' }],
});

test('the message and the schema are the contract read at call time, not a copy of it', () => {
  const { system, schema } = graphAuthoringBrief();
  for (const state of Object.keys(contract.delta.states)) assert.ok(system.includes(state), state);
  for (const field of contract.forbidden_fields) assert.ok(system.includes(field), field);
  assert.ok(system.includes(`${contract.limits.nodes} nodes`));
  const changed = structuredClone(contract);
  changed.limits.nodes = 7;
  changed.delta.states.parked = { node: null, edge: null, label: 'Parked' };
  changed.kinds.unknown = 'refuse';
  const again = graphAuthoringBrief(changed);
  assert.ok(again.system.includes('7 nodes') && again.system.includes('parked') && again.system.includes('is refused'));
  assert.deepEqual(again.schema.properties.lanes.items.properties.nodes.items.properties.delta.enum, ['added', 'modified', 'removed', 'unchanged', 'parked']);
  assert.deepEqual(Object.keys(schema.properties), contract.allowed_fields.document);
  assert.deepEqual(schema.properties.schema_version, { type: 'integer', minimum: 1, maximum: 1 });
  assert.equal(schema.additionalProperties, false);
});

test('every field the contract allows has a type, a required list and nothing is left untyped', () => {
  for (const [shape, fields] of Object.entries(contract.allowed_fields)) {
    assert.ok(authoring.required[shape], `${shape} has a required list`);
    for (const field of fields) assert.ok(authoring.field_types[field], `${shape}.${field} has a type`);
    for (const field of authoring.required[shape]) assert.ok(fields.includes(field), `${shape}.${field} is allowed`);
  }
});

test('a schema-valid document is accepted by the validator and a schema-broken one is not', () => {
  const document = good();
  document.schema_version = 1;
  assert.equal(validateGraphDocument(document).ok, true);
  const { schema } = graphAuthoringBrief();
  for (const field of schema.required) assert.ok(field in document, field);
  assert.deepEqual(Object.keys(document).filter((key) => !(key in schema.properties)), []);
});

test('the host overwrites what the model wrote, and words are made safe before they are validated', async () => {
  const reply = good();
  reply.label = 'Fix for\n@everyone #1234 now';
  reply.lanes[0].nodes[0].detail = 'ping @owner';
  const seen = [];
  const result = await authorGraphDocument({ request: 'draw the change', ask: async (turn) => { seen.push(turn); return JSON.stringify(reply); } });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.attempts, 1);
  assert.equal(result.document.schema_version, contract.schema_version, 'the model\'s version is gone');
  assert.equal(result.document.label, `Fix for @${authoring.joiner}everyone #${authoring.joiner}1234 now`);
  assert.equal(result.document.lanes[0].nodes[0].detail, `ping @${authoring.joiner}owner`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].repair, null);
  assert.equal(seen[0].request, 'draw the change');
  assert.equal(stampHostFields({ a: 1, b: 2 }, { b: 9 }).b, 9);
});

test('a refusal is fed back once with the validator\'s own findings and the second try can succeed', async () => {
  const broken = good();
  broken.edges.push({ from: 'pay', to: 'ghost', delta: 'added' });
  broken.lanes[0].nodes[1].x = 40;
  const turns = [];
  const replies = [broken, good()];
  const result = await authorGraphDocument({ request: 'r', ask: async (turn) => { turns.push(turn); return replies.shift(); } });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(turns[0].repair, null);
  assert.match(turns[1].repair, /document\.edges\[1\]\.to \[BROKEN_REFERENCE\]/);
  assert.match(turns[1].repair, /document\.lanes\[0\]\.nodes\[1\]\.x \[POSITION_NOT_ALLOWED\]/);
  assert.ok(turns[1].repair.startsWith(authoring.repair.intro));
});

test('two refusals end in a typed failure carrying the last findings, and it never asks a third time', async () => {
  const broken = good();
  broken.edges.push({ from: 'pay', to: 'pay', delta: 'added' });
  let asks = 0;
  const result = await authorGraphDocument({ request: 'r', ask: async () => { asks += 1; return broken; } });
  assert.equal(asks, authoring.attempts);
  assert.equal(result.ok, false);
  assert.equal(result.document, null);
  assert.equal(result.errors[0].code, 'STILL_INVALID');
  assert.ok(result.errors.some((error) => error.code === 'SELF_EDGE'));
});

test('a reply with no object is told so, and a fenced or wrapped object is read', async () => {
  const turns = [];
  const replies = ['I cannot draw that', `Here you go:\n\`\`\`json\n${JSON.stringify(good())}\n\`\`\``];
  const result = await authorGraphDocument({ request: 'r', ask: async (turn) => { turns.push(turn); return replies.shift(); } });
  assert.equal(result.ok, true);
  assert.equal(turns[1].repair, authoring.repair.unreadable);
  assert.equal(readModelObject('[1,2]'), null);
  assert.equal(readModelObject(7), null);
  assert.deepEqual(readModelObject({ a: 1 }), { a: 1 });
  assert.match(repairMessage([{ path: 'p', code: 'C', message: 'm' }]), /p \[C\] m$/);
});

test('containment touches only model-authored text fields and leaves ids and kinds alone', () => {
  const safe = containDocumentText({ id: 'a@b', label: ' x\t@y ', lanes: [{ id: 'l#1', nodes: [{ id: 'n', kind: 'a@b', detail: 'z#' }] }] });
  assert.equal(safe.id, 'a@b');
  assert.equal(safe.label, `x @${authoring.joiner}y`);
  assert.equal(safe.lanes[0].id, 'l#1');
  assert.equal(safe.lanes[0].nodes[0].kind, 'a@b');
  assert.equal(safe.lanes[0].nodes[0].detail, `z#${authoring.joiner}`);
  assert.equal(containModelText('plain words'), 'plain words');
});

test('a large input is bounded and filtered before the model sees it, and a dry run asks nothing', async () => {
  const files = [{ path: 'src/pay.mjs', text: 'export const pay = 1;' }, { path: '.env', text: 'KEY=secret' }, { path: 'package-lock.json', text: '{}' }];
  const turns = [];
  const dry = await authorGraphDocument({ request: 'r', files, dryRun: true, ask: async (turn) => { turns.push(turn); return good(); } });
  assert.equal(turns.length, 0);
  assert.deepEqual(dry.outbound, ['Sent to the model (1 files, 21 bytes of 400000):', '  src/pay.mjs (21 bytes)', 'Not sent (2 files):', '  .env: may hold a secret', '  package-lock.json: a lock file is churn, not design']);
  const result = await authorGraphDocument({ request: 'r', files, ask: async (turn) => { turns.push(turn); return good(); } });
  assert.deepEqual(turns[0].input.map((sent) => sent.path), ['src/pay.mjs']);
  assert.ok(!JSON.stringify(turns[0]).includes('KEY=secret'));
  assert.deepEqual(result.outbound, dry.outbound);
});

test('every lane and node id has a name an AI can use as an identifier in code, stable and never shared', async () => {
  const { graphIdentifiers } = await import('../do-work/graph-authoring.mjs');
  const document = good();
  document.lanes.push({ id: '9-lane', label: 'L', nodes: [{ id: 'pay.v2', label: 'a', delta: 'added' }, { id: 'pay_v2', label: 'b', delta: 'added' }, { id: 'a-b', label: 'c', delta: 'added' }, { id: 'a_b', label: 'd', delta: 'added' }] });
  const { byId, byName } = graphIdentifiers(document);
  assert.deepEqual([...byId.entries()], [['core', 'core'], ['pay', 'pay'], ['ledger', 'ledger'], ['9-lane', 'n9_lane'], ['pay.v2', 'pay_v2'], ['pay_v2', 'pay_v2_2'], ['a-b', 'a_b'], ['a_b', 'a_b_2']]);
  for (const name of byName.keys()) assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/u);
  assert.equal(byName.get('pay_v2_2'), 'pay_v2');
  assert.deepEqual([...graphIdentifiers(structuredClone(document)).byId], [...byId]);
});

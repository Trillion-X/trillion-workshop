// tools/funnels-and-offers/test/funnels-and-offers-tools.test.mjs
// Each tool runs the way its row runs it: its argv, in the folder its workdir stands for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'records.json'), 'utf8')).things.map(thing => thing.payload);

function runByRow(toolId, input) {
  const row = rows.find(item => item.id === toolId);
  assert.ok(row, `${toolId} is a row in records.json`);
  assert.equal(row.invoke.workdir, row.invoke.files.package_files.at);
  const argv = row.invoke.argv.map(item => (typeof item === 'string' ? item : JSON.stringify(input)));
  const ran = spawnSync(process.execPath, argv.slice(1), { cwd: folder, encoding: 'utf8' });
  if (ran.status !== 0) return { refused: ran.stderr.trim() };
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

const pick = (answer, selector) => selector.slice(1).match(/[^.[\]]+/g).reduce((value, key) => value?.[key], answer);

const graphs = [{ id: 'graph:ladder', entry_node: 'front' }];
const nodes = [
  { id: 'front', entry: true, offer: { amount_cents: 900, name: 'Loaf' }, transitions: [{ on: 'purchase', to: 'extra' }, { on: 'decline', to: 'exit' }] },
  { id: 'extra', offer: { amount_cents: 400, name: 'Jam' }, transitions: [{ on: 'purchase', to: 'done' }] },
];

test('every row\'s sample run gives what its verify says', () => {
  for (const row of rows) {
    for (const check of row.verify.filter(item => item.kind === 'sample-run')) {
      assert.ok(JSON.stringify(pick(runByRow(row.id, check.input), check.output_selector)).includes(check.contains), `${row.id}: ${check.output_selector} contains ${check.contains}`);
    }
  }
});

test('walking: where the buyer is, where an outcome takes them, the price a settled experiment decided, the ordered links', () => {
  const answer = runByRow('tool:walk-a-funnel', {
    graphs, nodes, at: 'front', outcome: 'decline',
    experiments: [{ id: 'exp:1', state: 'settled', node_ref: 'front', result: { winner: 'v1' } }],
    variants: [{ variant_key: 'v1', amount_cents: 700 }],
    cta_links: [{ page: 'p', label: 'Later', role: 'secondary', href: '/l' }, { page: 'p', label: 'Order', href: '/o' }],
  });
  assert.deepEqual(answer.flow.order, ['front', 'extra']);
  assert.equal(answer.current.display_amount_cents, 700);
  assert.equal(answer.current.price_source_ref, 'exp:1');
  assert.deepEqual(answer.advance, { next: null, target: 'exit', terminal: true });
  assert.deepEqual(answer.cta_links.map(link => link.label), ['Order', 'Later']);
});

test('a funnel with no entry node says so instead of failing', () => {
  const answer = runByRow('tool:walk-a-funnel', { graphs: [{ id: 'g' }], nodes: [] });
  assert.equal(answer.flow, null);
  assert.match(answer.reason, /No funnel graph/);
});

test('bad input is refused with every problem listed', () => {
  const refused = runByRow('tool:walk-a-funnel', { graphs: 'x', nodes, experiments: 5, at: 3, outcome: 'purchase' });
  for (const part of ['graphs must be', 'experiments must be', 'at must be text']) assert.match(refused.refused, new RegExp(part));
  assert.match(runByRow('tool:walk-a-funnel', { graphs, nodes, outcome: 'purchase' }).refused, /outcome needs at/);
  assert.match(runByRow('tool:measure-funnel-stages', { facts: 1, stage_ids: [], group_by: '', amount_field: 5 }).refused, /facts must be a list.*stage_ids.*group_by.*amount_field/);
  assert.match(runByRow('tool:read-a-funnel-definition', { definitions: {}, owners: { offers: 3 }, decisions: 1, funnel_id: 2 }).refused, /definitions must be.*owners\.offers.*decisions.*funnel_id/);
});

test('measuring counts each stage and says how many facts named none of them', () => {
  const answer = runByRow('tool:measure-funnel-stages', { facts: [{ s: 'a', amount_cents: 100 }, { s: 'a' }, { s: 'elsewhere' }], stage_ids: ['a', 'b'], group_by: 's', amount_field: 'amount_cents' });
  assert.deepEqual(answer.stages.a, { visits: 2, conversions: 1, conversion_rate: 50, revenue_cents: 100 });
  assert.equal(answer.facts_read, 3);
  assert.equal(answer.facts_unplaced, 1);
});

test('reading a definition marks the decided version live and says when there is no such funnel', () => {
  const definitions = [{ kind: 'funnel-definition', id: 'funnel:f', stages: [{ stage_address: 's:1', variant_surface_ref: { $ref: 'surface:front' } }] }];
  const owners = { variantSurfaces: [{ id: 'front', candidates: [{ candidate_id: 'a' }, { candidate_id: 'b' }] }] };
  const answer = runByRow('tool:read-a-funnel-definition', { definitions, owners, decisions: [{ surface_address: 'front', winner_id: 'a' }] });
  assert.deepEqual(answer.funnel.stages[0].variants.map(variant => [variant.candidate_id, variant.live]), [['a', true], ['b', false]]);
  assert.equal(runByRow('tool:read-a-funnel-definition', { definitions, funnel_id: 'nope' }).funnel, null);
});

test('drafting a funnel gives a record that reads back; growing one keeps it', () => {
  const made = runByRow('tool:draft-a-funnel', { title: 'Spring loaf offers', stages: ['Visit'], entropy: 'a1' }).funnel;
  assert.equal(made.stages[0].stage_address, 'stage:spring-loaf-offers-a1:s1');
  const grown = runByRow('tool:draft-a-funnel', { add_to: made, stages: ['Order'] }).funnel;
  assert.deepEqual(grown.stages.map(stage => stage.title), ['Visit', 'Order']);
});

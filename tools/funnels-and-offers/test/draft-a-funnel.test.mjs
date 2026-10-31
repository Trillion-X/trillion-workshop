// tools/funnels-and-offers/test/draft-a-funnel.test.mjs
// Drafting: a new funnel is honestly empty, a step is appended deterministically and without a clash, and growing a funnel keeps every field of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendStage, buildNewFunnelDefinition, readFunnelDefinition, resolveFunnelDefinition, slugify } from '../read-data/funnel-definition.mjs';
import { draftAFunnel } from '../do-work/draft-a-funnel.mjs';

test('slugify makes a url-safe slug', () => {
  assert.equal(slugify('My Offer Ladder!'), 'my-offer-ladder');
  assert.equal(slugify('  spaced  out  '), 'spaced-out');
  assert.equal(slugify('###'), '');
  assert.equal(slugify(5), '');
});

test('a new funnel has the title, an id with the entropy and no stages (nothing is made up)', () => {
  const definition = buildNewFunnelDefinition('Offer Ladder', 'k9');
  assert.deepEqual(definition, { kind: 'funnel-definition', id: 'funnel:offer-ladder-k9', title: 'Offer Ladder', stages: [] });
});

test('a title with nothing slug-able leaves the id to the entropy, and the typed title is kept', () => {
  assert.deepEqual(buildNewFunnelDefinition('###', 'z7'), { kind: 'funnel-definition', id: 'funnel:z7', title: '###', stages: [] });
  assert.equal(buildNewFunnelDefinition('', '').id, 'funnel:funnel');
  assert.equal('title' in buildNewFunnelDefinition('', 'q'), false);
});

test('appending a stage does not change the input, numbers stages and never collides with an address already taken', () => {
  const start = buildNewFunnelDefinition('Ladder', 'a1');
  const one = appendStage(start, ' Visit ');
  assert.equal(start.stages.length, 0);
  assert.deepEqual(one.stages, [{ stage_address: 'stage:ladder-a1:s1', title: 'Visit' }]);
  const taken = { ...one, stages: [{ stage_address: 'stage:ladder-a1:s2' }] };
  assert.equal(appendStage(taken, 'Next').stages[1].stage_address, 'stage:ladder-a1:s3');
  assert.equal('title' in appendStage(start, '  ').stages[0], false);
});

test('a drafted funnel reads back and resolves with its stage titles', () => {
  const { funnel } = draftAFunnel({ title: 'Spring loaf offers', stages: ['Visit', 'Order'], entropy: 'a1' });
  assert.equal(readFunnelDefinition(funnel).stages.length, 2);
  assert.deepEqual(resolveFunnelDefinition([funnel]).stages.map(stage => stage.title), ['Visit', 'Order']);
});

test('growing a funnel keeps every field of the record, including ones this tool does not read', () => {
  const mine = { kind: 'funnel-definition', id: 'funnel:mine', stages: [{ stage_address: 'stage:mine:s1', title: 'One', row_actions: [{ action_ref: 'x' }] }], saved_by: 'me' };
  const { funnel } = draftAFunnel({ add_to: mine, stages: ['Two'] });
  assert.equal(funnel.saved_by, 'me');
  assert.deepEqual(funnel.stages[0], mine.stages[0]);
  assert.equal(funnel.stages[1].stage_address, 'stage:mine:s2');
});

test('random entropy is used when none is given, and bad input is refused with every problem listed', () => {
  assert.match(draftAFunnel({ title: 'Ladder' }).funnel.id, /^funnel:ladder-[0-9a-f]{6}$/);
  assert.match(draftAFunnel({ title: 'Ladder' }, () => 'fixed').funnel.id, /ladder-fixed$/);
  assert.throws(() => draftAFunnel({ stages: [5] }), /stages must be a list of stage titles; a new funnel needs a title/);
  assert.throws(() => draftAFunnel({ add_to: { kind: 'x' } }), /add_to must be a funnel-definition record with an id; add_to needs the stage titles/);
  assert.throws(() => draftAFunnel(null), /Give \{ title \}/);
});

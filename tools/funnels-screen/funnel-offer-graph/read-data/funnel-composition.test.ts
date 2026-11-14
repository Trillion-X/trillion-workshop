// packages/funnel-offer-graph/read-data/funnel-composition.test.ts
//
// Covers the pure composition seams: folding choose-per-observer decisions into
// the live-variant map, mapping stage row_actions to generic target envelopes,
// and the additive in-UI variant upsert write.

import { describe, expect, it } from 'vitest';
import {
  buildStageActionRequest,
  buildVariantUpsertWrite,
  humanizeActionRef,
  liveVariantMapFromDecisions,
  stageRowActionSpecs,
} from './funnel-composition';

describe('liveVariantMapFromDecisions', () => {
  it('folds decisions into { surfaceId: winnerId } and ignores malformed rows', () => {
    const map = liveVariantMapFromDecisions([
      { surface_address: 'front-price', winner_id: 'b', hidden_ids: ['a'] },
      { surface_address: 'bump-price', winner_id: 'x' },
      // @ts-expect-error malformed row is ignored, not thrown
      { surface_address: 'bad' },
    ]);
    expect(map).toEqual({ 'front-price': 'b', 'bump-price': 'x' });
  });
});

describe('stageRowActionSpecs (workflow dispatch)', () => {
  it('maps action refs to execute_definition on the workflow slot, scoped to the stage', () => {
    const specs = stageRowActionSpecs({
      stage_address: 'stage:ladder:visit',
      row_actions: [
        { action_ref: 'action:message-visitor', label_ref: 'label:message' },
        { action_ref: 'ping', target: 'slot::notify', operation: 'invoke' },
      ],
    }, (ref, fb) => (ref === 'label:message' ? 'Message these visitors' : fb));
    expect(specs[0]).toEqual({
      id: 'stage:ladder:visit:action:message-visitor',
      label: 'Message these visitors',
      target: 'slot::workflow',
      operation: 'execute_definition',
      input: { stage_address: 'stage:ladder:visit' },
      definitionId: 'action:message-visitor',
    });
    // explicit target/operation override; non-definition → invoke, no definitionId
    expect(specs[1]).toMatchObject({ target: 'slot::notify', operation: 'invoke', label: 'Ping' });
    expect(specs[1]).not.toHaveProperty('definitionId');
  });

  it('humanizes an action ref into plain copy (no engine words)', () => {
    expect(humanizeActionRef('action:message-visitor')).toBe('Message visitor');
    expect(humanizeActionRef('run_followup')).toBe('Run followup');
  });

  it('builds the target envelope request locally for a dispatch row action', () => {
    const [spec] = stageRowActionSpecs({
      stage_address: 'stage:ladder:visit',
      row_actions: [{ action_ref: 'action:message-visitor', label_ref: 'label:message' }],
    }, (ref, fb) => (ref === 'label:message' ? 'Message these visitors' : fb));
    expect(buildStageActionRequest({
      action: spec!,
      projectionRevision: 'funnel',
    })).toEqual({
      target: 'slot::workflow',
      operation: 'execute_definition',
      input: {
        stage_address: 'stage:ladder:visit',
        projectionRevision: 'funnel',
        definitionId: 'action:message-visitor',
      },
      correlationId: 'stage:ladder:visit:action:message-visitor:funnel',
    });
  });

  it('maps placeable-surface DATA to the shared open-surface payload instead of a target envelope', () => {
    const [spec] = stageRowActionSpecs({
      stage_address: 'stage:ladder:visit',
      row_actions: [{
        action_ref: 'open:visitor-records',
        surface: {
          id: 'visitor-records',
          title: 'Open visitor records',
          material_target: 'component:visual-database',
          package_entry: { package_name: 'visual-database', entry_name: 'visual-database' },
          surface_input: { records: [], fields: { descriptors: [] }, views: { views: [] } },
        },
      }],
    });
    expect(spec).toMatchObject({
      id: 'stage:ladder:visit:open:visitor-records',
      label: 'Open visitor records',
      surface: {
        id: 'visitor-records',
        materialTarget: 'component:visual-database',
        packageEntry: { packageName: 'visual-database', entryName: 'visual-database' },
      },
    });
    expect(buildStageActionRequest({ action: spec!, projectionRevision: 'funnel' })).toBeNull();
  });
});

describe('buildVariantUpsertWrite (additive in-UI variant edit — no whole-surface rebuild)', () => {
  const surface = {
    id: 'front-price',
    entity_type: 'selection-surface',
    candidates: [
      { candidate_id: 'a', label: '$47', amount_cents: 4700 },
      { candidate_id: 'b', label: '$67', amount_cents: 6700 },
    ],
  };

  it('upserts one candidate by id, preserving the rest and the surface fields', () => {
    const write = buildVariantUpsertWrite('funnel::front-price', surface, {
      candidate_id: 'b',
      label: '$77',
      amount_cents: 7700,
    })!;
    expect(write.payload.operation_label).toBe('engine.operation.write-batch');
    const w = write.payload.writes[0];
    expect(w.address_label).toBe('funnel::front-price');
    const cands = (w.payload.candidates as Array<{ candidate_id: string; amount_cents?: number }>);
    // a preserved, b updated (not duplicated)
    expect(cands.map((c) => c.candidate_id)).toEqual(['a', 'b']);
    expect(cands.find((c) => c.candidate_id === 'b')?.amount_cents).toBe(7700);
    expect(w.payload.entity_type).toBe('selection-surface'); // surface fields kept
  });

  it('adds a brand-new candidate variant', () => {
    const write = buildVariantUpsertWrite('funnel::front-price', surface, {
      candidate_id: 'c',
      label: '$97',
      amount_cents: 9700,
    })!;
    const cands = write.payload.writes[0].payload.candidates as Array<{ candidate_id: string }>;
    expect(cands.map((c) => c.candidate_id)).toEqual(['a', 'b', 'c']);
  });

  it('fail-soft on a missing address or candidate id', () => {
    expect(buildVariantUpsertWrite('', surface, { candidate_id: 'c' })).toBeNull();
    expect(buildVariantUpsertWrite('addr', surface, { candidate_id: '' })).toBeNull();
  });
});

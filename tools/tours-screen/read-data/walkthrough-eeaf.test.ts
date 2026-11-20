// packages/guided-overlay/read-data/walkthrough-eeaf.test.ts

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import {
  foldWalkthroughRecords,
  foldWalkthroughProgress,
  selectWalkthroughForEvent,
  type WalkthroughRecord,
} from './walkthrough-eeaf.ts';

const bakeryTour = {
  kind: 'walkthrough-definition',
  id: 'wt:bakery-first-tour',
  title: 'Welcome to Example Bakery',
  progress_style: { style: 'bar' },
  entry_step: 'step:welcome',
  steps: [
    {
      id: 'step:welcome',
      target_ref: { from: 'node-ref', family: 'tab', parts: { surface: 'lessons', tab: 'new' } },
      cutout: { shapes: [{ shape: 'rounded-rect', padding: 8 }] },
      content: { content_kind: 'interactive-gate', payload: { title: 'Create', body: 'Tap.' } },
      advance_condition: { op: 'target-interacted' },
    },
    { id: 'step:done', content: { content_kind: 'outcome', payload: { title: 'Done' } } },
  ],
  triggers: [
    { reason: 'first-run', on_event: { event_kind: 'app-opened' }, once_key: 'wt:bakery-first-tour' },
  ],
};

function rec(value: unknown): WalkthroughRecord {
  return { address: `record:${(value as { id: string }).id ?? 'x'}`, value_json: value };
}

describe('walkthrough-eeaf — definition fold', () => {
  it('folds a record into an engine-ready definition (entry_step + step ids + triggers)', () => {
    const defs = foldWalkthroughRecords([rec(bakeryTour)]);
    const def = defs['wt:bakery-first-tour'];
    expect(def.entry_step).toBe('step:welcome');
    expect(def.steps.map((s) => s.id)).toEqual(['step:welcome', 'step:done']);
    expect(def.triggers).toHaveLength(1);
  });

  it('carries presentation fields through OPAQUE (decoder never inspects content_kind/op/shape)', () => {
    const ref = { owner: 'package::example::presentation::opaque' };
    const withPresentation = {
      ...bakeryTour,
      steps: [{ ...bakeryTour.steps[0], presentation_ref: ref }, bakeryTour.steps[1]],
    };
    const def = foldWalkthroughRecords([rec(withPresentation)])['wt:bakery-first-tour'];
    expect((def.steps[0].content as { content_kind: string }).content_kind).toBe('interactive-gate');
    expect((def.steps[0].advance_condition as { op: string }).op).toBe('target-interacted');
    expect((def.steps[0].cutout as { shapes: unknown[] }).shapes).toHaveLength(1);
    expect(def.steps[0].presentation_ref).toBe(ref);
  });

  it('accepts JSON-string values and defaults missing triggers to []', () => {
    const noTriggers = { kind: 'walkthrough-definition', id: 'wt:b', entry_step: 's1', steps: [{ id: 's1' }] };
    const defs = foldWalkthroughRecords([{ address: 'a', value_json: JSON.stringify(noTriggers) }]);
    expect(defs['wt:b'].triggers).toEqual([]);
  });

  it('tombstone removes the id (latest delete wins)', () => {
    const tomb = { id: 'wt:bakery-first-tour', status: 'deleted' };
    const defs = foldWalkthroughRecords([rec(bakeryTour), rec(tomb)]);
    expect(defs['wt:bakery-first-tour']).toBeUndefined();
  });

  it('a later valid record at the same id wins over an earlier one', () => {
    const v2 = { ...bakeryTour, title: 'Welcome v2' };
    const defs = foldWalkthroughRecords([rec(bakeryTour), rec(v2)]);
    expect(defs['wt:bakery-first-tour'].title).toBe('Welcome v2');
  });

  it('skips malformed records (missing entry_step or non-array steps)', () => {
    const bad1 = { kind: 'walkthrough-definition', id: 'wt:bad1', steps: [{ id: 's' }] }; // no entry_step
    const bad2 = { kind: 'walkthrough-definition', id: 'wt:bad2', entry_step: 's', steps: 'nope' };
    const defs = foldWalkthroughRecords([rec(bad1), rec(bad2)]);
    expect(Object.keys(defs)).toHaveLength(0);
  });

  it('emits an id-sorted map (deterministic)', () => {
    const a = { kind: 'walkthrough-definition', id: 'wt:a', entry_step: 's', steps: [{ id: 's' }] };
    const z = { kind: 'walkthrough-definition', id: 'wt:z', entry_step: 's', steps: [{ id: 's' }] };
    const defs = foldWalkthroughRecords([rec(z), rec(a)]);
    expect(Object.keys(defs)).toEqual(['wt:a', 'wt:z']);
  });
});

describe('walkthrough-eeaf — progress fold + host intake + write', () => {
  // The package kept one progress row per cursor, with an address built from scope, definition, revision and run
  // (walkthroughProgressAddress). The Workshop keeps ONE progress record whose `cursors` map holds every tour's
  // cursor (do-work/walkthrough-progress.ts), so the fold unions the consumed keys of every progress record it is
  // given, keeps each tour's latest cursor, and ignores a foreign record that carries consumed_once_keys.
  it('unions the consumed keys of every progress record, keeps each cursor, and ignores a foreign record', () => {
    const p = foldWalkthroughProgress([
      { address: 'legacy-progress-address', value_json: { kind: 'walkthrough-progress', consumed_once_keys: ['k1'] } },
      { address: 'other-address', value_json: { kind: 'something-else', consumed_once_keys: ['foreign'] } },
      { address: 'progress-address', value_json: { kind: 'walkthrough-progress', consumed_once_keys: ['k2'], consumed_at: { k2: '2026-01-09T00:00:00.000Z' }, cursors: { 'wt:a': { current_step_id: 's2', status: 'active', cursor_revision: 1, definition_revision: 1, run_id: 'run-1', history: ['s1'] } } } },
    ]);
    expect([...p.consumedOnceKeys].sort()).toEqual(['k1', 'k2']);
    expect(p.consumedAt.get('k2')).toBe('2026-01-09T00:00:00.000Z');
    expect(p.cursors['wt:a'].currentStepId).toBe('s2');
    expect(p.cursors['wt:a'].history).toEqual(['s1']);
    expect(p.cursors['wt:a'].runId).toBe('run-1');
  });

  it('selectWalkthroughForEvent routes an event to the tour whose trigger fires', () => {
    const defs = foldWalkthroughRecords([rec(bakeryTour)]);
    const hit = selectWalkthroughForEvent(defs, { event_kind: 'app-opened' });
    expect(hit?.definitionId).toBe('wt:bakery-first-tour');
    expect(hit?.trigger.reason).toBe('first-run');
  });

  it('a consumed once_key suppresses the tour (don\'t show again)', () => {
    const defs = foldWalkthroughRecords([rec(bakeryTour)]);
    const hit = selectWalkthroughForEvent(defs, { event_kind: 'app-opened' }, new Set(['wt:bakery-first-tour']));
    expect(hit).toBeNull();
  });

});

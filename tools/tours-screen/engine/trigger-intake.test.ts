// Old test: packages/guided-overlay/engine/trigger-intake.test.ts

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import {
  eventMatchesTrigger,
  shouldFireTrigger,
  selectTrigger,
  startEventForWalkthrough,
  suppressionKeyForEvent,
  requirementsMet,
  type Trigger,
} from './trigger-intake.ts';

const scopedStart: Trigger = {
  reason: 'scoped-start',
  on_event: { event_kind: 'app-opened' },
  once_key: 'tour.scoped-start',
};
const featureSpotlight: Trigger = {
  reason: 'feature-entered',
  on_event: { event_kind: 'surface-entered', match: { surface: 'roadmap' } },
  once_key: 'bakery.roadmap-spotlight',
};
const manualReplay: Trigger = {
  reason: 'manual',
  on_event: { event_kind: 'replay-requested', match: { walkthrough: 'tour-a' } },
  // no once_key — can fire every time
};

describe('trigger-intake (M7) — event matching', () => {
  it('matches on kind alone when no match params', () => {
    expect(eventMatchesTrigger(scopedStart, { event_kind: 'app-opened' })).toBe(true);
    expect(eventMatchesTrigger(scopedStart, { event_kind: 'other' })).toBe(false);
  });

  it('requires all match params to equal', () => {
    expect(eventMatchesTrigger(featureSpotlight, { event_kind: 'surface-entered', surface: 'roadmap' })).toBe(true);
    expect(eventMatchesTrigger(featureSpotlight, { event_kind: 'surface-entered', surface: 'inbox' })).toBe(false);
    expect(eventMatchesTrigger(featureSpotlight, { event_kind: 'surface-entered' })).toBe(false); // missing field
  });
});

describe('trigger-intake (M7) — suppression-key idempotency', () => {
  it('fires for a new scoped run and suppresses the consumed key', () => {
    const seenNone = new Set<string>();
    expect(shouldFireTrigger(scopedStart, { event_kind: 'app-opened' }, seenNone)).toBe(true);
    const seen = new Set(['tour.scoped-start']);
    expect(shouldFireTrigger(scopedStart, { event_kind: 'app-opened' }, seen)).toBe(false);
  });

  it('a trigger without once_key fires every time', () => {
    const consumed = new Set(['anything']);
    const ev = { event_kind: 'replay-requested', walkthrough: 'tour-a' };
    expect(shouldFireTrigger(manualReplay, ev, consumed)).toBe(true);
    expect(shouldFireTrigger(manualReplay, ev, new Set())).toBe(true);
  });

  it('scopes a once key by opaque event fields declared in DATA', () => {
    const scoped: Trigger = {
      reason: 'authenticated-scoped-start',
      on_event: { event_kind: 'account-session-readback' },
      once_key: 'tour',
      once_key_fields: ['account_ref', 'walkthrough_revision'],
    };
    const event = { event_kind: 'account-session-readback', account_ref: 'account-a', walkthrough_revision: 5 };
    expect(suppressionKeyForEvent(scoped, event)).toBe('tour::account_ref=account-a::walkthrough_revision=5');
    expect(shouldFireTrigger(scoped, event, new Set(['tour']))).toBe(true);
    expect(shouldFireTrigger(scoped, event, new Set(['tour::account_ref=account-a::walkthrough_revision=5']))).toBe(false);
    expect(selectTrigger([scoped], event)?.once_key).toBe('tour::account_ref=account-a::walkthrough_revision=5');
  });
});

describe('trigger-intake (M7) — selection', () => {
  const triggers = [scopedStart, featureSpotlight, manualReplay];

  it('picks the first declared trigger whose event matches and is allowed', () => {
    expect(selectTrigger(triggers, { event_kind: 'app-opened' })?.reason).toBe('scoped-start');
    expect(
      selectTrigger(triggers, { event_kind: 'surface-entered', surface: 'roadmap' })?.reason,
    ).toBe('feature-entered');
  });

  it('skips a consumed once-trigger and returns null when nothing else matches', () => {
    const seen = new Set(['tour.scoped-start']);
    expect(selectTrigger(triggers, { event_kind: 'app-opened' }, seen)).toBeNull();
  });

  it('returns null when no event matches', () => {
    expect(selectTrigger(triggers, { event_kind: 'nothing-bound' })).toBeNull();
  });

  it('the engine never enumerates reason — an unknown reason string flows through untouched', () => {
    const aiTour: Trigger = {
      reason: 'ai-initiated-because-user-struggled',
      on_event: { event_kind: 'ai-suggested-tour', match: { tour: 'serve-technique' } },
    };
    const picked = selectTrigger([aiTour], { event_kind: 'ai-suggested-tour', tour: 'serve-technique' });
    expect(picked?.reason).toBe('ai-initiated-because-user-struggled');
  });

  // The old suppressionKeyToConsume(trigger) is suppressionKeyForEvent(trigger, event) now: the same key, scoped by the event's fields when DATA names them.
  it('suppressionKeyForEvent returns the key to record (or null)', () => {
    expect(suppressionKeyForEvent(scopedStart, { event_kind: 'app-opened' })).toBe('tour.scoped-start');
    expect(suppressionKeyForEvent(manualReplay, { event_kind: 'replay-requested', walkthrough: 'tour-a' })).toBeNull();
  });

  // Added with the Workshop engine (not in the package's test): a trigger that waits for other keys, optionally consumed before an instant.
  it('a trigger waits until the keys it requires are consumed, and consumed before the instant it names', () => {
    const waiting: Trigger = {
      reason: 'after-first-tour',
      on_event: { event_kind: 'app-opened' },
      requires: [{ once_key: 'tour.first', consumed_before: '2026-01-10T00:00:00.000Z' }],
    };
    const ev = { event_kind: 'app-opened' };
    expect(shouldFireTrigger(waiting, ev, new Set())).toBe(false);
    expect(shouldFireTrigger(waiting, ev, new Set(['tour.first']))).toBe(false); // consumed at an unknown time never satisfies a dated requirement
    expect(shouldFireTrigger(waiting, ev, new Set(['tour.first']), new Map([['tour.first', '2026-01-09T00:00:00.000Z']]))).toBe(true);
    expect(shouldFireTrigger(waiting, ev, new Set(['tour.first']), new Map([['tour.first', '2026-01-11T00:00:00.000Z']]))).toBe(false);
    expect(requirementsMet(manualReplay, new Set())).toBe(true);
  });

  it('match_all needs every listed value to be in the event field', () => {
    const wants: Trigger = { reason: 'has-both', on_event: { event_kind: 'seen', match_all: { tags: ['a', 'b'] } } };
    expect(eventMatchesTrigger(wants, { event_kind: 'seen', tags: ['a', 'b', 'c'] })).toBe(true);
    expect(eventMatchesTrigger(wants, { event_kind: 'seen', tags: ['a'] })).toBe(false);
    expect(eventMatchesTrigger(wants, { event_kind: 'seen', tags: 'a' })).toBe(false);
  });

  it('builds Start from the repeatable walkthrough-specific trigger, not trigger zero', () => {
    const triggersForDefinition: Trigger[] = [
      {
        reason: 'onboarding-completed',
        on_event: { event_kind: 'onboarding-completed', match: { primary_interaction: 'chat' } },
        once_key: 'initial-tour',
      },
      {
        reason: 'replay',
        on_event: { event_kind: 'walkthrough-requested', match: { walkthrough_id: 'tour-a' } },
      },
    ];
    expect(startEventForWalkthrough(triggersForDefinition, 'tour-a')).toEqual({
      event_kind: 'walkthrough-requested',
      walkthrough_id: 'tour-a',
    });
  });
});

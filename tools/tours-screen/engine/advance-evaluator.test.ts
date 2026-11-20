// Old test: packages/guided-overlay/engine/advance-evaluator.test.ts

import { readFileSync } from 'node:fs';
import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { canAdvance, createAdvanceRegistry } from './advance-evaluator.ts';

describe('advance-evaluator (M4) — built-in ops', () => {
  it('tap-next / target-interacted / answer-given', () => {
    expect(canAdvance({ op: 'tap-next' }, { nextTapped: true })).toBe(true);
    expect(canAdvance({ op: 'tap-next' }, {})).toBe(false);
    expect(canAdvance({ op: 'target-interacted' }, { targetInteracted: true })).toBe(true);
    expect(canAdvance({ op: 'answer-given' }, { answer: 'pro' })).toBe(true);
    expect(canAdvance({ op: 'answer-given' }, { answer: '' })).toBe(false);
  });

  it('media-watched compares against the DATA threshold (default 1.0)', () => {
    expect(canAdvance({ op: 'media-watched', args: { min_ratio: 0.9 } }, { mediaRatio: 0.95 })).toBe(true);
    expect(canAdvance({ op: 'media-watched', args: { min_ratio: 0.9 } }, { mediaRatio: 0.5 })).toBe(false);
    expect(canAdvance({ op: 'media-watched' }, { mediaRatio: 0.99 })).toBe(false); // default needs full watch
  });

  it('timeout compares elapsed against the DATA ms', () => {
    expect(canAdvance({ op: 'timeout', args: { ms: 3000 } }, { elapsedMs: 3001 })).toBe(true);
    expect(canAdvance({ op: 'timeout', args: { ms: 3000 } }, { elapsedMs: 100 })).toBe(false);
  });

  it('unknown op → false (no auto-advance; nav buttons still work — never traps)', () => {
    expect(canAdvance({ op: 'telepathy-2099' }, { nextTapped: true })).toBe(false);
  });
});

describe('advance-evaluator (M4) — composition (L069 combinatorial)', () => {
  const watchedAndAnswered = {
    op: 'all-of',
    args: { of: [{ op: 'media-watched', args: { min_ratio: 0.9 } }, { op: 'answer-given' }] },
  };

  it('all-of requires every child', () => {
    expect(canAdvance(watchedAndAnswered, { mediaRatio: 0.95, answer: 'x' })).toBe(true);
    expect(canAdvance(watchedAndAnswered, { mediaRatio: 0.95 })).toBe(false); // no answer
    expect(canAdvance(watchedAndAnswered, { answer: 'x' })).toBe(false); // not watched
    expect(canAdvance({ op: 'all-of', args: { of: [] } }, {})).toBe(false); // empty all-of is vacuously false
  });

  it('any-of requires one child; nests arbitrarily', () => {
    const tappedOrTimedOut = { op: 'any-of', args: { of: [{ op: 'tap-next' }, { op: 'timeout', args: { ms: 5000 } }] } };
    expect(canAdvance(tappedOrTimedOut, { nextTapped: true })).toBe(true);
    expect(canAdvance(tappedOrTimedOut, { elapsedMs: 6000 })).toBe(true);
    expect(canAdvance(tappedOrTimedOut, {})).toBe(false);
    // deep nest: (tap OR (watched AND answered))
    const nested = { op: 'any-of', args: { of: [{ op: 'tap-next' }, watchedAndAnswered] } };
    expect(canAdvance(nested, { mediaRatio: 1, answer: 'y' })).toBe(true);
  });

  it('a new op registers and composes with the built-ins, zero evaluator change', () => {
    const reg = createAdvanceRegistry();
    reg.register('shook-device', (_a, s: { shaken?: boolean } & Record<string, unknown>) => s.shaken === true);
    const cond = { op: 'any-of', args: { of: [{ op: 'shook-device' }, { op: 'tap-next' }] } };
    expect(canAdvance(cond, { shaken: true } as never, reg)).toBe(true);
  });
});

describe('owner-readback advance op (OD-04/OD-05 dependency)', () => {
  it('advances only when the declared owner fact ref is resolved by the signal bridge', () => {
    const condition = {
      op: 'owner-readback',
      args: { owner: 'unseen-owner', readback_ref: 'package::unseen-owner::input::state' },
    };
    expect(canAdvance(condition, {})).toBe(false);
    expect(canAdvance(condition, { ownerReadbacks: {} })).toBe(false);
    expect(canAdvance(condition, { ownerReadbacks: { 'package::unseen-owner::input::state': { state: 'connected' } } })).toBe(true);
  });

  it('enforces required_answer_values on the resolved fact', () => {
    const condition = {
      op: 'owner-readback',
      args: {
        answer_fact_ref: 'package::unseen-owner::answer::form::respondent::question',
        required_answer_values: ['a-person', 'b-person'],
      },
    };
    expect(canAdvance(condition, { ownerReadbacks: { 'package::unseen-owner::answer::form::respondent::question': 'a-person' } })).toBe(true);
    expect(canAdvance(condition, { ownerReadbacks: { 'package::unseen-owner::answer::form::respondent::question': 'someone-else' } })).toBe(false);
    expect(canAdvance(condition, { ownerReadbacks: { 'other-ref': 'a-person' } })).toBe(false);
  });

  it('enforces required_nonempty on the resolved owner collection', () => {
    const condition = {
      op: 'owner-readback',
      args: { readback_ref: 'package::unseen-owner::input::recordings', required_nonempty: true },
    };
    expect(canAdvance(condition, { ownerReadbacks: { 'package::unseen-owner::input::recordings': [] } })).toBe(false);
    expect(canAdvance(condition, { ownerReadbacks: { 'package::unseen-owner::input::recordings': [{ storedFileRef: 'x' }] } })).toBe(true);
  });

  it('requires every declared value to be present in an owner collection', () => {
    const condition = {
      op: 'owner-readback',
      args: {
        readback_ref: 'account-access',
        required_values_present: ['access:sample-app'],
      },
    };
    expect(canAdvance(condition, { ownerReadbacks: { 'account-access': [] } })).toBe(false);
    expect(canAdvance(condition, {
      ownerReadbacks: { 'account-access': ['access:something-else'] },
    })).toBe(false);
    expect(canAdvance(condition, {
      ownerReadbacks: { 'account-access': ['access:something-else', 'access:sample-app'] },
    })).toBe(true);
  });

  it('enforces required_states against the decoded receipt state', () => {
    const condition = {
      op: 'owner-readback',
      args: { owner: 'unseen-owner', required_states: ['objective-claimed-owner-route-dispatch-pending'] },
    };
    expect(canAdvance(condition, {
      ownerReadbacks: { 'unresolved': { visible_state: 'objective-claimed-owner-route-dispatch-pending' } },
    })).toBe(false);
  });

  it('requires every declared ref when several are present', () => {
    const condition = {
      op: 'owner-readback',
      args: { readback_ref: 'r1', objective_answer_ref: 'r2' },
    };
    expect(canAdvance(condition, { ownerReadbacks: { r1: 'ok' } })).toBe(false);
    expect(canAdvance(condition, { ownerReadbacks: { r1: 'ok', r2: 'text' } })).toBe(true);
  });

  it('names no owner in the evaluator', () => {
    const source = readFileSync(new URL('./advance-evaluator.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/service-connections|selected-agent|record-audio|ai-work-control|ask-questions/);
  });
});

// Old test: packages/guided-overlay/engine/cursor-machine.test.ts

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { resolveBranch, type WalkthroughShape } from './branch-resolver.ts';
import {
  startWalkthrough,
  advance,
  retreat,
  jump,
  currentStep,
  type WalkthroughCursor,
} from './cursor-machine.ts';

const linear: WalkthroughShape = {
  entry_step: 's1',
  steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
};

const branched: WalkthroughShape = {
  entry_step: 'welcome',
  steps: [
    { id: 'welcome', branch_map: { by_answer: { beginner: 'basics', pro: 'advanced' }, default_next: 'basics' } },
    { id: 'basics' },
    { id: 'advanced' },
    { id: 'done' },
  ],
};

describe('branch-resolver (M8)', () => {
  it('routes by answer, then default_next, then ordered fallback', () => {
    const step = branched.steps[0];
    expect(resolveBranch(step, 'pro', 'basics')).toBe('advanced');
    expect(resolveBranch(step, 'unknown-answer', 'basics')).toBe('basics'); // default_next
    expect(resolveBranch({ id: 'x' }, undefined, 's2')).toBe('s2'); // no branch map → ordered
    expect(resolveBranch({ id: 'x' }, undefined, null)).toBeNull(); // end of linear
  });
});

describe('cursor-machine (M3) — linear', () => {
  it('starts at entry; advances through to completion', () => {
    let c = startWalkthrough(linear);
    expect(c).toEqual({ currentStepId: 's1', history: [], status: 'active' });
    c = advance(linear, c);
    expect(c.currentStepId).toBe('s2');
    expect(c.history).toEqual(['s1']);
    c = advance(linear, c);
    expect(c.currentStepId).toBe('s3');
    c = advance(linear, c); // past the last step
    expect(c.status).toBe('complete');
    expect(c.currentStepId).toBe('s3'); // stays on last visible step
  });

  it('advancing a completed cursor is a no-op', () => {
    let c: WalkthroughCursor = { currentStepId: 's3', history: ['s1', 's2'], status: 'complete' };
    expect(advance(linear, c)).toBe(c);
  });
});

describe('cursor-machine (M3) — branching', () => {
  it('an answer routes to the mapped step', () => {
    let c = startWalkthrough(branched);
    c = advance(branched, c, 'pro');
    expect(c.currentStepId).toBe('advanced');
    expect(currentStep(branched, c)?.id).toBe('advanced');
  });

  it('an unmatched answer falls back to default_next', () => {
    let c = startWalkthrough(branched);
    c = advance(branched, c, 'martian');
    expect(c.currentStepId).toBe('basics');
  });
});

describe('cursor-machine (M3) — retreat / jump / restart', () => {
  it('retreat pops history exactly, even across a branch', () => {
    let c = startWalkthrough(branched);
    c = advance(branched, c, 'pro'); // welcome → advanced
    expect(c.currentStepId).toBe('advanced');
    c = retreat(c); // back to welcome
    expect(c.currentStepId).toBe('welcome');
    expect(c.history).toEqual([]);
    expect(retreat(c)).toBe(c); // empty history → no-op
  });

  it('jump moves to a step and records history; ignores unknown steps', () => {
    let c = startWalkthrough(linear);
    c = jump(linear, c, 's3');
    expect(c.currentStepId).toBe('s3');
    expect(c.history).toEqual(['s1']);
    expect(jump(linear, c, 'nope')).toBe(c);
  });

  it('restart returns to entry with cleared history', () => {
    let c = startWalkthrough(branched);
    c = advance(branched, c, 'pro');
    c = startWalkthrough(branched); // restart is startWalkthrough again: the package's restart(def) is gone
    expect(c).toEqual({ currentStepId: 'welcome', history: [], status: 'active' });
  });
});

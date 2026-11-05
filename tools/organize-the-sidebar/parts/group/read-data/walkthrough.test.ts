// packages/group/read-data/walkthrough.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  clampIndex,
  isFirstStep,
  isLastStep,
  nextIndex,
  prevIndex,
  stepAt,
  tourProgressLabel,
  type Tour,
} from '../../../read-data/walkthrough.ts';

const tour: Tour = {
  id: 't1',
  name: 'Board basics',
  steps: [
    { id: 's1', target: 'n1', title: 'Your first card', body: 'This is an idea card.' },
    { id: 's2', target: 'toolbar.share', title: 'Share it', body: 'Share the board as a link.' },
    { id: 's3', title: 'That is it', body: 'You are ready.' },
  ],
};

describe('stepAt', () => {
  it('returns the step or null out of range', () => {
    expect(stepAt(tour, 0)?.id).toBe('s1');
    expect(stepAt(tour, 2)?.title).toBe('That is it');
    expect(stepAt(tour, 3)).toBeNull();
    expect(stepAt(tour, -1)).toBeNull();
  });
});

describe('navigation (clamped)', () => {
  it('clampIndex bounds into range', () => {
    expect(clampIndex(tour, -5)).toBe(0);
    expect(clampIndex(tour, 99)).toBe(2);
    expect(clampIndex({ id: 'e', name: 'e', steps: [] }, 3)).toBe(0);
  });

  it('next/prev never leave the valid range', () => {
    expect(nextIndex(tour, 0)).toBe(1);
    expect(nextIndex(tour, 2)).toBe(2); // already last
    expect(prevIndex(tour, 0)).toBe(0); // already first
    expect(prevIndex(tour, 2)).toBe(1);
  });
});

describe('boundaries + progress', () => {
  it('isFirst / isLast', () => {
    expect(isFirstStep(0)).toBe(true);
    expect(isFirstStep(1)).toBe(false);
    expect(isLastStep(tour, 2)).toBe(true);
    expect(isLastStep(tour, 1)).toBe(false);
    expect(isLastStep({ id: 'e', name: 'e', steps: [] }, 0)).toBe(true);
  });

  it('tourProgressLabel reads "N of M"', () => {
    expect(tourProgressLabel(0, 3)).toBe('1 of 3');
    expect(tourProgressLabel(2, 3)).toBe('3 of 3');
    expect(tourProgressLabel(0, 0)).toBe('');
  });
});

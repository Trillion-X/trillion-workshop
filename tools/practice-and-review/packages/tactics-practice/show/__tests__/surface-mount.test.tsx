import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The surface reads live rows through the runtime-kit react hook. For a mount
// test we feed it a controllable row set; an empty set proves the assembled
// screen composes and shows its human starter states across all three surfaces.
const rowsRef: { current: unknown[] } = { current: [] };
vi.mock('@bitfield/runtime-kit/react', () => ({
  useBitfieldData: () => rowsRef.current,
}));

import { TacticsPracticeSurface } from '@/packages/tactics-practice/show/TacticsPracticeSurface';

afterEach(cleanup);

describe('TacticsPracticeSurface (assembled)', () => {
  it('empty state mounts and shows the three human starter states', () => {
    rowsRef.current = [];
    const { container } = render(<TacticsPracticeSurface userId="player:ada" />);
    const text = container.textContent ?? '';
    expect(text).toContain('Tactics Tactics Practice');
    expect(text).toContain('Open the daily tactic');
    expect(text).toContain('One-on-one contest is not open yet');
    expect(text).toContain('Season tournament is waiting for a season');
    // backend vocabulary must never reach the assembled screen
    for (const word of ['envelope', 'payload', 'workflow', 'descriptor', 'runtime', 'mobbin']) {
      expect(text.toLowerCase().includes(word)).toBe(false);
    }
  });
});

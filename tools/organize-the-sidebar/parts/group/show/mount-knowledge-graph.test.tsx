import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { readInputs } from '../../../show/mount-knowledge-graph.tsx';

describe('mount-knowledge-graph shell', () => {
  it('resolves records_input from surfaceInput, else a safe fallback (never empty)', () => {
    expect(readInputs({ surfaceInput: { records_input: 'recs' } })).toEqual({ recordsInput: 'recs' });
    expect(readInputs({ records_input: 'top' }).recordsInput).toBe('top');
    expect(readInputs({})).toEqual({ recordsInput: 'knowledge-graph-records' });
    expect(readInputs({ surfaceInput: { records_input: '' } }).recordsInput).toBe('knowledge-graph-records');
  });
});

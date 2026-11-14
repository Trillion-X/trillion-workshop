import { describe, it, expect } from 'vitest';
import { toPublishedRecords, readAgentId } from './mount-agent-card';

describe('toPublishedRecords', () => {
  it('passes a bare array through', () => {
    const a = [{ payload: { id: 'x' } }];
    expect(toPublishedRecords(a)).toBe(a);
  });

  it('unwraps records/items/value/published carriers', () => {
    expect(toPublishedRecords({ records: [1] })).toEqual([1]);
    expect(toPublishedRecords({ items: [2] })).toEqual([2]);
    expect(toPublishedRecords({ value: [3] })).toEqual([3]);
    expect(toPublishedRecords({ published: [4] })).toEqual([4]);
  });

  it('returns [] for null/undefined/non-array shapes (never throws)', () => {
    expect(toPublishedRecords(null)).toEqual([]);
    expect(toPublishedRecords(undefined)).toEqual([]);
    expect(toPublishedRecords({ nope: 1 })).toEqual([]);
    expect(toPublishedRecords(42)).toEqual([]);
  });
});

describe('readAgentId', () => {
  it('extracts a non-empty agentId from surfaceInput', () => {
    expect(readAgentId({ agentId: 'a1' })).toBe('a1');
  });

  it('returns null for missing/empty/non-string/array inputs', () => {
    expect(readAgentId({ agentId: '' })).toBeNull();
    expect(readAgentId({ agentId: '   ' })).toBeNull();
    expect(readAgentId({ agentId: 5 })).toBeNull();
    expect(readAgentId(null)).toBeNull();
    expect(readAgentId([{ agentId: 'a' }])).toBeNull();
    expect(readAgentId('a1')).toBeNull();
  });
});

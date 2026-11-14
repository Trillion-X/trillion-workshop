import { describe, expect, it } from 'vitest';

import { decodePublishedRecordRows } from '../AgentsHubSurface';

// L126 scoped-feed compatibility: agents-hub's `published-records` input can be
// repointed from the global aggregate (rows shaped {address, payload}) to a scoped
// `record_from_matching_records` json_array feed (rows shaped {record:{address,
// source_package}, payload}). decodePublishedRecordRows must yield the SAME
// {address, payload} rows from BOTH shapes so cards + their sourceAddress (delete)
// keep working after the repoint.
describe('decodePublishedRecordRows', () => {
  it('decodes aggregate rows with a TOP-LEVEL address (unchanged behaviour)', () => {
    expect(decodePublishedRecordRows([
      { address: 'pkg::agents-hub::a', payload: { kind: 'ai-agent-profile', id: 'a' } },
    ])).toEqual([
      { address: 'pkg::agents-hub::a', payload: { kind: 'ai-agent-profile', id: 'a' } },
    ]);
  });

  it('decodes scoped-feed rows with a NESTED record.address', () => {
    expect(decodePublishedRecordRows([
      { record: { address: 'pkg::agents-hub::b', source_package: 'agents-hub' }, payload: { kind: 'ai-model-descriptor', id: 'b' } },
    ])).toEqual([
      { address: 'pkg::agents-hub::b', payload: { kind: 'ai-model-descriptor', id: 'b' } },
    ]);
  });

  it('still yields the payload when no address is present anywhere', () => {
    expect(decodePublishedRecordRows([
      { payload: { kind: 'ai-tool-descriptor' } },
    ])).toEqual([
      { payload: { kind: 'ai-tool-descriptor' } },
    ]);
  });

  it('ignores non-array input and non-object / array entries', () => {
    expect(decodePublishedRecordRows(null)).toEqual([]);
    expect(decodePublishedRecordRows(undefined)).toEqual([]);
    expect(decodePublishedRecordRows([null, 'x', 42, []])).toEqual([]);
  });
});

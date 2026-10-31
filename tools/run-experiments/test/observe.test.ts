// tools/run-experiments/test/observe.test.ts
//
// Purpose: Unit tests for the pure half of observe.ts (buildObservationRecord,
// observationAddress, buildWriteBatchEntry) plus a read-back contract test
// for appendObservation using a stub engineWriteBatch.
//
// The live I/O path (real engine write-batch) is not tested here — that
// belongs in integration tests in T5/T8. This file proves:
//   1. Record shape is correct (all required fields, correct entity_type, etc.)
//   2. Address format is correct (observer::<id>::<path segments>)
//   3. Append-only: the write-batch entry never sets remove:true
//   4. Trust_ref is stored verbatim (open DATA, not coerced to an enum)
//   5. Path is stored as a string[] (not dot-encoded)
//   6. Invalid inputs throw with descriptive messages
//   7. Read-back contract: appendObservation calls the engine writer exactly
//      once with the correctly shaped entry, and returns the address

import { describe, expect, it, vi } from '../../../test-helpers/vitest-shim.mjs';
import {
  appendObservation,
  buildObservationRecord,
  buildWriteBatchEntry,
  observationAddress,
  type WriteBatchEntry,
} from '../do-work/observe.ts';

// ---------------------------------------------------------------------------
// observationAddress
// ---------------------------------------------------------------------------

describe('observationAddress', () => {
  it('formats address as observer::<id>::<path segments joined by ::>', () => {
    const addr = observationAddress('obs-123', ['observer', 'signal', 'source']);
    expect(addr).toBe('observer::obs-123::observer::signal::source');
  });

  it('handles single-segment path', () => {
    const addr = observationAddress('obs-abc', ['page-view']);
    expect(addr).toBe('observer::obs-abc::page-view');
  });

  it('handles deep path', () => {
    const addr = observationAddress('u1', ['a', 'b', 'c', 'd']);
    expect(addr).toBe('observer::u1::a::b::c::d');
  });
});

// ---------------------------------------------------------------------------
// buildObservationRecord — shape correctness
// ---------------------------------------------------------------------------

describe('buildObservationRecord — shape', () => {
  it('produces entity_type "observation"', () => {
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['observer', 'signal', 'source'],
      value: 'youtube',
    });
    expect(record.entity_type).toBe('observation');
  });

  it('copies observer_id, trust_ref, path, value verbatim', () => {
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-xyz',
      trustRef: 'trust:derived',
      path: ['observer', 'signal', 'source'],
      value: 'google',
    });
    expect(record.observer_id).toBe('obs-xyz');
    expect(record.trust_ref).toBe('trust:derived');
    expect(record.path).toEqual(['observer', 'signal', 'source']);
    expect(record.value).toBe('google');
  });

  it('stores path as string[] not a dot-encoded string', () => {
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['a', 'b', 'c'],
      value: 42,
    });
    expect(Array.isArray(record.path)).toBe(true);
    expect(record.path).toEqual(['a', 'b', 'c']);
  });

  it('refuses missing observation time instead of reading a hidden clock', () => {
    expect(() => buildObservationRecord({ observerId: 'obs-1', trustRef: 'trust:observer-supplied', path: ['x'], value: 1,
      at: undefined })).toThrow('Observation time');
  });

  it('uses provided at timestamp verbatim', () => {
    const ts = '2026-06-26T12:00:00.000Z';
    const { record } = buildObservationRecord({
      observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['x'],
      value: 'v',
      at: ts,
    });
    expect(record.at).toBe(ts);
  });

  it('sets basis when provided', () => {
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['x'],
      value: 'v',
      basis: 'transcript:abc123',
    });
    expect(record.basis).toBe('transcript:abc123');
  });

  it('omits basis key when not provided', () => {
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['x'],
      value: 'v',
    });
    expect('basis' in record).toBe(false);
  });

  it('stores null value (null is a valid fact value, absence = fact not existing)', () => {
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['x'],
      value: null,
    });
    expect(record.value).toBeNull();
  });

  it('stores boolean value', () => {
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['x'],
      value: false,
    });
    expect(record.value).toBe(false);
  });

  it('stores object value', () => {
    const obj = { utm_source: 'youtube', utm_medium: 'cpc' };
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['x'],
      value: obj,
    });
    expect(record.value).toEqual(obj);
  });

  it('returns the correct address alongside the record', () => {
    const { address } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-42',
      trustRef: 'trust:observer-supplied',
      path: ['observer', 'signal', 'source'],
      value: 'yt',
    });
    expect(address).toBe('observer::obs-42::observer::signal::source');
  });

  it('trust_ref is stored verbatim — open DATA string, not coerced', () => {
    const customTrust = 'trust:attested-by-clearbit';
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: customTrust,
      path: ['x'],
      value: 'v',
    });
    expect(record.trust_ref).toBe(customTrust);
  });

  it('defensive copy: mutating path after build does not mutate the record', () => {
    const path = ['observer', 'signal', 'source'];
    const { record } = buildObservationRecord({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path,
      value: 'v',
    });
    path.push('extra');
    expect(record.path).toHaveLength(3);
    expect(record.path[3]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildObservationRecord — invalid input throws
// ---------------------------------------------------------------------------

describe('buildObservationRecord — validation throws', () => {
  it('throws on empty observerId', () => {
    expect(() =>
      buildObservationRecord({ at: '2026-09-13T00:00:00.000Z', observerId: '', trustRef: 'trust:x', path: ['x'], value: 1 }),
    ).toThrow('observerId');
  });

  it('throws on whitespace-only observerId', () => {
    expect(() =>
      buildObservationRecord({ at: '2026-09-13T00:00:00.000Z', observerId: '   ', trustRef: 'trust:x', path: ['x'], value: 1 }),
    ).toThrow('observerId');
  });

  it('throws on empty trustRef', () => {
    expect(() =>
      buildObservationRecord({ at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1', trustRef: '', path: ['x'], value: 1 }),
    ).toThrow('trustRef');
  });

  it('throws on empty path array', () => {
    expect(() =>
      buildObservationRecord({ at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1', trustRef: 'trust:x', path: [], value: 1 }),
    ).toThrow('path');
  });

  it('throws on non-array path', () => {
    expect(() =>
      buildObservationRecord({
        at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
        trustRef: 'trust:x',
        path: 'a.b.c' as unknown as string[],
        value: 1,
      }),
    ).toThrow('path');
  });

  it('throws on path with empty segment', () => {
    expect(() =>
      buildObservationRecord({
        at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
        trustRef: 'trust:x',
        path: ['observer', '', 'source'],
        value: 1,
      }),
    ).toThrow('path[1]');
  });
});

// ---------------------------------------------------------------------------
// buildWriteBatchEntry — append-only contract
// ---------------------------------------------------------------------------

describe('buildWriteBatchEntry — append-only', () => {
  it('sets remove: false (never remove, never update — append only)', () => {
    const entry = buildWriteBatchEntry({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['observer', 'signal', 'source'],
      value: 'youtube',
    });
    expect(entry.remove).toBe(false);
  });

  it('sets address to the correct observer address', () => {
    const entry = buildWriteBatchEntry({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-99',
      trustRef: 'trust:observer-supplied',
      path: ['observer', 'signal', 'source'],
      value: 'yt',
    });
    expect(entry.address).toBe('observer::obs-99::observer::signal::source');
  });

  it('sets log path as ["observer", observerId, ...path]', () => {
    const entry = buildWriteBatchEntry({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:observer-supplied',
      path: ['signal', 'source'],
      value: 'yt',
    });
    expect(entry.path).toEqual(['observer', 'obs-1', 'signal', 'source']);
  });

  it('payload is the ObservationRecord', () => {
    const entry = buildWriteBatchEntry({
      at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
      trustRef: 'trust:derived',
      path: ['x'],
      value: 42,
    });
    const payload = entry.payload as Record<string, unknown>;
    expect(payload['entity_type']).toBe('observation');
    expect(payload['observer_id']).toBe('obs-1');
    expect(payload['trust_ref']).toBe('trust:derived');
    expect(payload['value']).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// appendObservation — read-back contract (stub engine)
// ---------------------------------------------------------------------------

describe('appendObservation — read-back contract', () => {
  it('calls engineWriteBatch exactly once with the correctly shaped entry', async () => {
    const captured: WriteBatchEntry[][] = [];
    const stubWriter = vi.fn(async (entries: WriteBatchEntry[]) => {
      captured.push(entries);
    });

    const { address } = await appendObservation(
      {
        at: '2026-09-13T00:00:00.000Z', observerId: 'obs-rbc',
        trustRef: 'trust:observer-supplied',
        path: ['observer', 'signal', 'source'],
        value: 'youtube',
        basis: 'request:req-001',
      },
      stubWriter,
    );

    expect(stubWriter).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);

    const entry = captured[0][0];
    expect(entry.address).toBe(address);
    expect(entry.remove).toBe(false);

    const payload = entry.payload as Record<string, unknown>;
    expect(payload['entity_type']).toBe('observation');
    expect(payload['observer_id']).toBe('obs-rbc');
    expect(payload['trust_ref']).toBe('trust:observer-supplied');
    expect((payload['path'] as string[])).toEqual(['observer', 'signal', 'source']);
    expect(payload['value']).toBe('youtube');
    expect(payload['basis']).toBe('request:req-001');
  });

  it('returns the correct address', async () => {
    const stubWriter = vi.fn(async () => {});
    const { address } = await appendObservation(
      {
        at: '2026-09-13T00:00:00.000Z', observerId: 'obs-addr',
        trustRef: 'trust:observer-supplied',
        path: ['observer', 'signal', 'source'],
        value: 'yt',
      },
      stubWriter,
    );
    expect(address).toBe('observer::obs-addr::observer::signal::source');
  });

  it('appends with a custom trust:* descriptor (open DATA — no coercion)', async () => {
    const captured: WriteBatchEntry[][] = [];
    const stubWriter = vi.fn(async (entries: WriteBatchEntry[]) => { captured.push(entries); });

    await appendObservation(
      {
        at: '2026-09-13T00:00:00.000Z', observerId: 'obs-1',
        trustRef: 'trust:attested-by-clearbit',
        path: ['enriched', 'company_size'],
        value: 'enterprise',
      },
      stubWriter,
    );

    const payload = captured[0][0].payload as Record<string, unknown>;
    expect(payload['trust_ref']).toBe('trust:attested-by-clearbit');
  });
});

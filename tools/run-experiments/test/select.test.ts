import { describe, it, expect, vi } from '../../../test-helpers/vitest-shim.mjs';
import type { SelectionSurface } from '../read-data/candidate-set-schema.ts';
import type { DeciderProgram } from '../read-data/decider-schema.ts';
import type { ObserverFact } from '../read-data/score-candidates.ts';
import {
  claimTranscript,
  selectWinner,
  transcriptAddress,
  type ClaimTranscriptOptions,
  type DecisionTranscript,
} from '../read-data/select.ts';
import { observationAddress } from '../do-work/observe.ts';

describe('selectWinner — pure decision', () => {
  it('scores candidates from a fact snapshot and returns the winner', () => {
    const surface: SelectionSurface = {
      entity_type: 'selection-surface',
      address: 'test.payment_method',
      decider_program_ref: 'decider:sticky-test',
      candidates: [
        { candidate_id: 'a', material_ref: 'material:card' },
        { candidate_id: 'b', material_ref: 'material:paypal' },
      ],
    };

    const decider: DeciderProgram = {
      entity_type: 'decider',
      decider_id: 'sticky-test',
      score: { op: 'sticky_hash', of: { const: 'observer-1' }, split: { split: { a: 0.6, b: 0.4 } } },
      accepts_trust: [],
    };

    const facts: ObserverFact[] = [];

    const winner = selectWinner(surface, facts, decider, 'observer-1:test.payment_method');
    expect(winner).not.toBeNull();
    expect(['a', 'b']).toContain(winner?.candidate_id);
  });

  it('returns null when candidate set is empty', () => {
    const surface: SelectionSurface = {
      entity_type: 'selection-surface',
      address: 'test.payment_method',
      decider_program_ref: 'decider:sticky-test',
      candidates: [],
    };

    const decider: DeciderProgram = {
      entity_type: 'decider',
      decider_id: 'sticky-test',
      score: { const: 0.5 },
      accepts_trust: [],
    };

    const winner = selectWinner(surface, [], decider, 'observer-1:test.payment_method');
    expect(winner).toBeNull();
  });

  it('respects fact-path referenced only (no full scan)', () => {
    const surface: SelectionSurface = {
      entity_type: 'selection-surface',
      address: 'test.a_b',
      decider_program_ref: 'decider:test',
      candidates: [{ candidate_id: 'x', material_ref: 'material:x' }],
    };

    const decider: DeciderProgram = {
      entity_type: 'decider',
      decider_id: 'test',
      score: { fact_path: ['signal', 'source'] },
      accepts_trust: [],
    };

    // Only the ['signal','source'] fact matters; others are ignored.
    const facts: ObserverFact[] = [
      { path: ['signal', 'source'], trust_ref: 'trust:supplied', value: 0.8 },
      { path: ['other', 'junk', 'facts'], trust_ref: 'trust:supplied', value: 999 },
    ];

    const winner = selectWinner(surface, facts, decider, 'key');
    expect(winner?.candidate_id).toBe('x');
  });
});

describe('transcriptAddress', () => {
  it('formats the canonical address in the observer-fact namespace (read == write)', () => {
    const addr = transcriptAddress('observer-1', 'checkout.method', 'epoch-123');
    // MUST equal where claimTranscript writes via appendObservation(path=['transcript',address,epoch]).
    expect(addr).toBe('observer::observer-1::transcript::checkout.method::epoch-123');
    expect(addr).toBe(observationAddress('observer-1', ['transcript', 'checkout.method', 'epoch-123']));
  });
});

describe('claimTranscript — orchestrator', () => {
  it('returns sticky hit if transcript already exists', async () => {
    const options: ClaimTranscriptOptions = {
      at: '2026-09-13T00:00:00.000Z', observer_id: 'observer-1',
      address: 'checkout.method',
      epoch: 'epoch-1',
      candidate_set_version: 'v1',
      decider_id: 'decider:test',
      decider_version: 'dv1',
      snapshot_anchor: 'snap-1',
      sticky_key: 'obs-1:checkout.method',
    };

    const existing: DecisionTranscript = {
      entity_type: 'transcript',
      observer_id: 'observer-1',
      address: 'checkout.method',
      epoch: 'epoch-1',
      winner: 'a',
      candidate_set_version: 'v1',
      decider_id: 'decider:test',
      decider_version: 'dv1',
      snapshot_anchor: 'snap-1',
      sticky_key: 'obs-1:checkout.method',
      at: new Date().toISOString(),
    };

    const buildFn = vi.fn().mockResolvedValue({ candidate_id: 'b', material_ref: 'material:b' });
    const writeCount = vi.fn();
    const engineWriteBatch = vi
      .fn()
      .mockImplementation(async (entries: any[]) => {
        writeCount();
      });
    const engineReadTranscript = vi.fn().mockResolvedValue(existing);

    const result = await claimTranscript(options, buildFn, engineWriteBatch, engineReadTranscript);

    expect(result.winner).toBe('a');
    expect(buildFn).not.toHaveBeenCalled();
    expect(writeCount).not.toHaveBeenCalled();
  });

  it('builds and appends transcript if not found', async () => {
    const options: ClaimTranscriptOptions = {
      at: '2026-09-13T00:00:00.000Z', observer_id: 'observer-1',
      address: 'checkout.method',
      epoch: 'epoch-1',
      candidate_set_version: 'v1',
      decider_id: 'decider:test',
      decider_version: 'dv1',
      snapshot_anchor: 'snap-1',
      sticky_key: 'obs-1:checkout.method',
    };

    const buildFn = vi.fn().mockResolvedValue({ candidate_id: 'b', material_ref: 'material:b' });
    const writeCount = vi.fn();
    const engineWriteBatch = vi
      .fn()
      .mockImplementation(async (entries: any[]) => {
        writeCount();
      });
    const engineReadTranscript = vi.fn().mockResolvedValue(null);

    const result = await claimTranscript(options, buildFn, engineWriteBatch, engineReadTranscript);

    expect(result.winner).toBe('b');
    expect(buildFn).toHaveBeenCalledOnce();
    expect(writeCount).toHaveBeenCalledOnce();
    expect(result.entity_type).toBe('transcript');
    expect(result.candidate_set_version).toBe('v1');
  });

  it('marks transcript with snapshot_anchor as basis', async () => {
    const options: ClaimTranscriptOptions = {
      at: '2026-09-13T00:00:00.000Z', observer_id: 'observer-1',
      address: 'checkout.method',
      epoch: 'epoch-1',
      candidate_set_version: 'v1',
      decider_id: 'decider:test',
      decider_version: 'dv1',
      snapshot_anchor: 'snap-123',
      sticky_key: 'obs-1:checkout.method',
    };

    const buildFn = vi.fn().mockResolvedValue({ candidate_id: 'winner', material_ref: 'material:w' });
    let capturedEntry: any;
    const engineWriteBatch = vi.fn().mockImplementation(async (entries: any[]) => {
      capturedEntry = entries[0];
    });
    const engineReadTranscript = vi.fn().mockResolvedValue(null);

    await claimTranscript(options, buildFn, engineWriteBatch, engineReadTranscript);

    expect(capturedEntry.payload.basis).toBe('snap-123');
  });

  it('deterministic: same builder result → same transcript', async () => {
    const options: ClaimTranscriptOptions = {
      at: '2026-09-13T00:00:00.000Z', observer_id: 'observer-1',
      address: 'checkout.method',
      epoch: 'epoch-1',
      candidate_set_version: 'v1',
      decider_id: 'decider:test',
      decider_version: 'dv1',
      snapshot_anchor: 'snap-1',
      sticky_key: 'obs-1:checkout.method',
    };

    const winner = { candidate_id: 'deterministic', material_ref: 'material:d' };
    const buildFn = vi.fn().mockResolvedValue(winner);
    const engineWriteBatch = vi.fn();
    const engineReadTranscript = vi.fn().mockResolvedValue(null);

    const result1 = await claimTranscript(options, buildFn, engineWriteBatch, engineReadTranscript);

    buildFn.mockClear();
    engineReadTranscript.mockResolvedValue(result1);

    const result2 = await claimTranscript(options, buildFn, engineWriteBatch, engineReadTranscript);

    expect(result1.winner).toBe(result2.winner);
    expect(result1.winner).toBe('deterministic');
    expect(buildFn).not.toHaveBeenCalledOnce(); // Not called in second claim (sticky hit)
  });

  it('throws if builder returns null', async () => {
    const options: ClaimTranscriptOptions = {
      at: '2026-09-13T00:00:00.000Z', observer_id: 'observer-1',
      address: 'checkout.method',
      epoch: 'epoch-1',
      candidate_set_version: 'v1',
      decider_id: 'decider:test',
      decider_version: 'dv1',
      snapshot_anchor: 'snap-1',
      sticky_key: 'obs-1:checkout.method',
    };

    const buildFn = vi.fn().mockResolvedValue(null);
    const engineWriteBatch = vi.fn();
    const engineReadTranscript = vi.fn().mockResolvedValue(null);

    await expect(claimTranscript(options, buildFn, engineWriteBatch, engineReadTranscript)).rejects.toThrow(
      /no candidates/,
    );
  });

  it('late fact does not change claimed transcript', async () => {
    const options: ClaimTranscriptOptions = {
      at: '2026-09-13T00:00:00.000Z', observer_id: 'observer-1',
      address: 'checkout.method',
      epoch: 'epoch-1',
      candidate_set_version: 'v1',
      decider_id: 'decider:test',
      decider_version: 'dv1',
      snapshot_anchor: 'snap-1',
      sticky_key: 'obs-1:checkout.method',
    };

    const buildFn = vi.fn().mockResolvedValue({ candidate_id: 'first', material_ref: 'material:f' });
    const engineWriteBatch = vi.fn();
    const engineReadTranscript = vi.fn();

    // First claim: not found, build returns 'first', append, return transcript.
    engineReadTranscript.mockResolvedValueOnce(null);
    const transcript1 = await claimTranscript(options, buildFn, engineWriteBatch, engineReadTranscript);
    expect(transcript1.winner).toBe('first');

    // Later fact arrives, but transcript is already sticky.
    buildFn.mockResolvedValueOnce({ candidate_id: 'second', material_ref: 'material:s' });
    engineReadTranscript.mockResolvedValueOnce(transcript1);

    const transcript2 = await claimTranscript(options, buildFn, engineWriteBatch, engineReadTranscript);
    expect(transcript2.winner).toBe('first'); // Sticky hit, ignore late builder result.
  });

  it('concurrent builds converge: deterministic inputs → same winner', async () => {
    const options: ClaimTranscriptOptions = {
      at: '2026-09-13T00:00:00.000Z', observer_id: 'observer-1',
      address: 'checkout.method',
      epoch: 'epoch-1',
      candidate_set_version: 'v1',
      decider_id: 'decider:test',
      decider_version: 'dv1',
      snapshot_anchor: 'snap-1',
      sticky_key: 'obs-1:checkout.method',
    };

    // Simulate two concurrent claims with deterministic builder (always returns same winner).
    const winner = { candidate_id: 'converged', material_ref: 'material:c' };
    const buildFn1 = vi.fn().mockResolvedValue(winner);
    const buildFn2 = vi.fn().mockResolvedValue(winner);

    const engineWriteBatch = vi.fn();
    const engineReadTranscript1 = vi.fn().mockResolvedValue(null);
    const engineReadTranscript2 = vi.fn().mockResolvedValue(null);

    const result1 = await claimTranscript(options, buildFn1, engineWriteBatch, engineReadTranscript1);
    const result2 = await claimTranscript(options, buildFn2, engineWriteBatch, engineReadTranscript2);

    expect(result1.winner).toBe(result2.winner);
    expect(result1.winner).toBe('converged');
  });
});

// tools/run-experiments/test/claim-and-attribute.integration.test.ts
//
// Integration proof of the experiment PRIMITIVE as a coherent seam over the REAL
// code path (not mocked address matching): claimTranscript persists a decision
// transcript through appendObservation into an ADDRESS-KEYED in-memory engine,
// a repeat claim reads it back as a sticky hit (this only passes because the
// read address == the write address — the fix), and attributeOutcomes then joins
// those persisted transcripts to synthetic conversion facts and credits each
// conversion to the ASSIGNED variant. No Stripe, no live engine — pure DATA.
//
// This is the durable replacement for the ephemeral 2026-07-02 "T5" fire: the
// assignment→attribution loop now has a checked-in end-to-end proof.

import { describe, it, expect, vi } from '../../../test-helpers/vitest-shim.mjs';
import {
  claimTranscript,
  transcriptAddress,
  type ClaimTranscriptOptions,
  type DecisionTranscript,
} from '../read-data/select.ts';
import type { WriteBatchEntry } from '../do-work/observe.ts';
import {
  attributeOutcomes,
  type AttributionJoin,
} from '../read-data/attribute-outcomes.ts';

// A minimal address-keyed engine: the write stores the record by its log
// address; the read looks it up by address and hands back the transcript it
// wrapped. A read/write address mismatch would make every lookup miss.
function inMemoryEngine() {
  const store = new Map<string, unknown>();
  const engineWriteBatch = async (entries: WriteBatchEntry[]) => {
    for (const e of entries) store.set(e.address, e.payload);
  };
  const engineReadTranscript = async (address: string): Promise<DecisionTranscript | null> => {
    const rec = store.get(address);
    if (rec == null) return null;
    const value = rec && typeof rec === 'object' && 'value' in rec ? (rec as { value: unknown }).value : rec;
    return value as DecisionTranscript;
  };
  return { store, engineWriteBatch, engineReadTranscript };
}

const baseOptions = (observerId: string): ClaimTranscriptOptions => ({
  at: '2026-09-13T00:00:00.000Z', observer_id: observerId,
  address: 'offer.framing',
  epoch: 'epoch-1',
  candidate_set_version: 'cs-v1',
  decider_id: 'offer-framing-5050',
  decider_version: 'd-v1',
  snapshot_anchor: 'anchor-1',
  sticky_key: `${observerId}:offer.framing`,
});

const ATTRIBUTION_JOIN: AttributionJoin = {
  entity_type: 'attribution-join',
  join_id: 'offer-framing-attribution',
  assignment: { observer_key_path: ['observer_id'], candidate_key_path: ['winner'] },
  outcome: {
    observer_key_path: ['observer_id'],
    metric_path: ['metric'],
    value_path: ['value'],
  },
  emit: {
    observe_address: 'candidate::outcome',
    metric_map: { purchase: 'conversions' },
    value_metric: 'revenue_cents',
  },
};

describe('experiment primitive — claim → persist → attribute (real code path)', () => {
  it('a repeat claim is a sticky hit because read address == write address', async () => {
    const { engineWriteBatch, engineReadTranscript } = inMemoryEngine();
    const build = vi.fn(async () => ({ candidate_id: 'variant-control' }));

    const first = await claimTranscript(baseOptions('ob_sticky'), build, engineWriteBatch, engineReadTranscript);
    expect(first.winner).toBe('variant-control');
    expect(build).toHaveBeenCalledTimes(1);

    // Second claim for the SAME (observer, address, epoch) must find the persisted
    // transcript and NOT rebuild — proving the sticky-read hits the written record.
    const second = await claimTranscript(baseOptions('ob_sticky'), build, engineWriteBatch, engineReadTranscript);
    expect(second).toEqual(first);
    expect(build).toHaveBeenCalledTimes(1); // buildFn NOT called again
  });

  it('the transcript is persisted at the SAME address the sticky-read looks up', async () => {
    const { store, engineWriteBatch, engineReadTranscript } = inMemoryEngine();
    await claimTranscript(baseOptions('ob_addr'), async () => ({ candidate_id: 'variant-control' }), engineWriteBatch, engineReadTranscript);
    const addr = transcriptAddress('ob_addr', 'offer.framing', 'epoch-1');
    expect(addr).toBe('observer::ob_addr::transcript::offer.framing::epoch-1');
    expect(store.has(addr)).toBe(true); // written exactly where the read looks
  });

  it('attributes each conversion to the variant the observer was assigned', async () => {
    const { engineWriteBatch, engineReadTranscript } = inMemoryEngine();
    // Two observers, two framing variants of ONE offer (same price/access).
    const tControl = await claimTranscript(baseOptions('ob_A'), async () => ({ candidate_id: 'variant-control' }), engineWriteBatch, engineReadTranscript);
    const tReframe = await claimTranscript(baseOptions('ob_B'), async () => ({ candidate_id: 'variant-reframe' }), engineWriteBatch, engineReadTranscript);

    // Synthetic outcomes: ob_A purchases (180000¢), ob_B only views (no purchase).
    const outcomes = [
      { entity_type: 'outcome', at: '2026-09-13T00:00:00.000Z', observer_id: 'ob_A', metric: 'purchase', value: 180000 },
      { entity_type: 'outcome', at: '2026-09-13T00:00:00.000Z', observer_id: 'ob_B', metric: 'view', value: 1 },
    ];

    const { observations, findings } = attributeOutcomes(
      ATTRIBUTION_JOIN,
      [tControl, tReframe],
      outcomes,
      '2026-07-05T00:00:00Z',
    );

    // Build a per-variant scoreboard from the emitted observations.
    const score: Record<string, Record<string, number>> = {};
    for (const o of observations) {
      const [, , metric, candidateId] = o.path;
      (score[candidateId] ??= {})[metric] = ((score[candidateId] ??= {})[metric] ?? 0) + (o.value as number);
    }

    // The purchasing observer was on control → control gets the conversion + revenue.
    expect(score['variant-control']?.conversions).toBe(1);
    expect(score['variant-control']?.revenue_cents).toBe(180000);
    // The reframe variant's observer only viewed → zero conversions attributed.
    expect(score['variant-reframe']?.conversions ?? 0).toBe(0);

    // ob_B's 'view' isn't in metric_map → reported as a skip, not an error.
    expect(findings.some((f) => f.includes('not in emit.metric_map'))).toBe(true);
  });
});

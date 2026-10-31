// tools/run-experiments/test/scope-records.test.ts

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { scopeRecordsForObserver } from '../read-data/scope-records.ts';

function record(id: string) {
  return { id, label: id };
}

const RECORDS = [record('offer:control'), record('offer:variant'), record('offer:other')];

const OBSERVER_SOURCE = { entity_type: 'observer-source', cookie_name: 'bf_observer' };

const SURFACE = {
  entity_type: 'selection-surface',
  address: 'offer:framing',
  decider_program_ref: 'decider:framing-5050',
  candidates: [
    { candidate_id: 'offer:control', material_ref: 'offer:control' },
    { candidate_id: 'offer:variant', material_ref: 'offer:variant' },
  ],
};

const DECIDER = {
  entity_type: 'decider',
  decider_id: 'framing-5050',
  accepts_trust: ['trust:observer-supplied', 'trust:derived'],
  score: {
    op: 'sticky_hash',
    of: { fact_path: ['observer', 'id'] },
    split: { split: { 'offer:control': 0.5, 'offer:variant': 0.5 } },
  },
};

const PROJECTION = { records: [OBSERVER_SOURCE, SURFACE, DECIDER] };

describe('scopeRecordsForObserver', () => {
  it('hides exactly one candidate per observer, keeps unrelated records', () => {
    const { records, decisions, observer_id } = scopeRecordsForObserver(RECORDS, PROJECTION, 'bf_observer=ob_1');
    expect(observer_id).toBe('ob_1');
    expect(records).toHaveLength(2);
    expect(records.some((r) => r.id === 'offer:other')).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].hidden_ids).toHaveLength(1);
    const shown = records.find((r) => r.id !== 'offer:other')!.id;
    expect(shown).toBe(decisions[0].winner_id);
  });

  it('is sticky for the same observer and differs across observers', () => {
    const winnerOf = (id: string) =>
      scopeRecordsForObserver(RECORDS, PROJECTION, `bf_observer=${id}`).decisions[0].winner_id;
    const first = winnerOf('ob_A');
    for (let i = 0; i < 5; i++) expect(winnerOf('ob_A')).toBe(first);
    const winners = new Set<string>();
    for (let i = 0; i < 64 && winners.size < 2; i++) winners.add(winnerOf(`ob_${i}`));
    expect(winners.size).toBe(2);
  });

  it('returns records unchanged when the cookie is absent', () => {
    const { records, decisions, observer_id } = scopeRecordsForObserver(RECORDS, PROJECTION, 'other=x');
    expect(observer_id).toBe('');
    expect(records).toHaveLength(3);
    expect(decisions).toHaveLength(0);
  });

  it('returns records unchanged when the projection has no observer-source row', () => {
    const { records, observer_id } = scopeRecordsForObserver(
      RECORDS,
      { records: [SURFACE, DECIDER] },
      'bf_observer=ob_1',
    );
    expect(observer_id).toBe('');
    expect(records).toHaveLength(3);
  });

  it('the observer cookie NAME is data — a different observer-source row works unchanged', () => {
    const projection = { records: [{ entity_type: 'observer-source', cookie_name: 'visitor_key' }, SURFACE, DECIDER] };
    const { decisions } = scopeRecordsForObserver(RECORDS, projection, 'visitor_key=ob_1');
    expect(decisions).toHaveLength(1);
  });

  it('ignores surfaces whose candidates are not all present in the record list', () => {
    const pageSurface = { ...SURFACE, address: 'page:/x', candidates: [
      { candidate_id: 'page:a', material_ref: 'page:a' },
      { candidate_id: 'page:b', material_ref: 'page:b' },
    ] };
    const { records } = scopeRecordsForObserver(
      RECORDS,
      { records: [OBSERVER_SOURCE, pageSurface, DECIDER] },
      'bf_observer=ob_1',
    );
    expect(records).toHaveLength(3);
  });

  it('ignores a surface whose decider is missing', () => {
    const { records } = scopeRecordsForObserver(
      RECORDS,
      { records: [OBSERVER_SOURCE, SURFACE] },
      'bf_observer=ob_1',
    );
    expect(records).toHaveLength(3);
  });

  it('matches decider refs with or without the decider: prefix', () => {
    const prefixed = { records: [OBSERVER_SOURCE, SURFACE, { ...DECIDER, decider_id: 'decider:framing-5050' }] };
    const { decisions } = scopeRecordsForObserver(RECORDS, prefixed, 'bf_observer=ob_1');
    expect(decisions).toHaveLength(1);
  });

  it('handles empty/undefined cookie string and empty projection', () => {
    expect(scopeRecordsForObserver(RECORDS, undefined, undefined).records).toHaveLength(3);
    expect(scopeRecordsForObserver(RECORDS, PROJECTION, undefined).records).toHaveLength(3);
  });

  it('scopes ANY record family — non-offer ids work identically (deletion test)', () => {
    const thumbs = [record('thumb:red'), record('thumb:blue')];
    const projection = { records: [OBSERVER_SOURCE,
      { ...SURFACE, address: 'video:thumb', candidates: [
        { candidate_id: 'thumb:red', material_ref: 'thumb:red' },
        { candidate_id: 'thumb:blue', material_ref: 'thumb:blue' },
      ] },
      { ...DECIDER, score: { ...DECIDER.score, split: { split: { 'thumb:red': 0.5, 'thumb:blue': 0.5 } } } },
    ] };
    const { records, decisions } = scopeRecordsForObserver(thumbs, projection, 'bf_observer=v1');
    expect(records).toHaveLength(1);
    expect(decisions[0].winner_id).toBe(records[0].id);
  });
});

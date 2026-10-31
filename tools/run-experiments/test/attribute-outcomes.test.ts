// tools/run-experiments/test/attribute-outcomes.test.ts

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  attributeOutcomes,
  readAtPath,
  validateAttributionJoin,
  type AttributionJoin,
} from '../read-data/attribute-outcomes.ts';

const AT = '2026-07-02T00:00:00Z';

function baseConfig(overrides: Partial<AttributionJoin> = {}): AttributionJoin {
  return {
    entity_type: 'attribution-join',
    join_id: 'join:test',
    assignment: {
      observer_key_path: ['observer_id'],
      candidate_key_path: ['winner'],
    },
    outcome: {
      observer_key_path: ['observer_id'],
      metric_path: ['metric'],
      value_path: ['value'],
    },
    emit: {
      observe_address: 'surface:test',
      metric_map: { Purchases: 'converted' },
      value_metric: 'revenue_cents',
    },
    ...overrides,
  };
}

const assignA = { observer_id: 'ob_1', winner: 'cand-a', address: 'surface:test' };
const assignB = { observer_id: 'ob_2', winner: 'cand-b', address: 'surface:test' };

describe('validateAttributionJoin', () => {
  it('accepts a complete config', () => {
    expect(validateAttributionJoin(baseConfig()).valid).toBe(true);
  });

  it('rejects a non-object', () => {
    const result = validateAttributionJoin(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('rejects a wrong entity_type', () => {
    const result = validateAttributionJoin({ ...baseConfig(), entity_type: 'decider' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('entity_type');
  });

  it('rejects a missing join_id', () => {
    const result = validateAttributionJoin({ ...baseConfig(), join_id: '  ' });
    expect(result.errors.join(' ')).toContain('join_id');
  });

  it('rejects bad key paths on both sides, listing every error', () => {
    const result = validateAttributionJoin({
      ...baseConfig(),
      assignment: { observer_key_path: [], candidate_key_path: ['x'] },
      outcome: { observer_key_path: ['x'], metric_path: [''] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects malformed where filters', () => {
    const bad = baseConfig();
    (bad.assignment as Record<string, unknown>).where = { path: [], equals: 1 };
    const result = validateAttributionJoin(bad);
    expect(result.errors.join(' ')).toContain('assignment.where');
  });

  it('rejects a metric_map with non-string values', () => {
    const bad = baseConfig();
    (bad.emit.metric_map as Record<string, unknown>).Leads = 7;
    expect(validateAttributionJoin(bad).valid).toBe(false);
  });

  it('rejects an empty observe_address and empty value_metric', () => {
    const bad = baseConfig();
    bad.emit.observe_address = '';
    (bad.emit as Record<string, unknown>).value_metric = '';
    const result = validateAttributionJoin(bad);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('readAtPath', () => {
  it('walks nested records and arrays', () => {
    const record = { decision: { winners: [{ id: 'cand-a' }] } };
    expect(readAtPath(record, ['decision', 'winners', '0', 'id'])).toBe('cand-a');
  });

  it('returns undefined on any miss', () => {
    expect(readAtPath({ a: 1 }, ['a', 'b'])).toBeUndefined();
    expect(readAtPath(null, ['a'])).toBeUndefined();
    expect(readAtPath([1], ['x'])).toBeUndefined();
  });
});

describe('attributeOutcomes', () => {
  it('joins outcomes to assigned candidates and counts mapped metrics', () => {
    const result = attributeOutcomes(
      baseConfig(),
      [assignA, assignB],
      [
        { observer_id: 'ob_1', metric: 'Purchases', value: 250000 },
        { observer_id: 'ob_2', metric: 'Purchases' },
      ],
      AT,
    );
    const byPath = new Map(result.observations.map((o) => [o.path.join('/'), o]));
    expect(byPath.get('candidate/outcome/converted/cand-a')?.value).toBe(1);
    expect(byPath.get('candidate/outcome/converted/cand-b')?.value).toBe(1);
    expect(byPath.get('candidate/outcome/revenue_cents/cand-a')?.value).toBe(250000);
    expect(byPath.has('candidate/outcome/revenue_cents/cand-b')).toBe(false);
    for (const o of result.observations) {
      expect(o.basis).toBe('join:test');
      expect(o.at).toBe(AT);
      expect(o.trustRef).toBe('trust:derived');
    }
  });

  it('sums repeated outcomes per (observer, metric, candidate) — convergent re-projection', () => {
    const outcomes = [
      { observer_id: 'ob_1', metric: 'Purchases', value: 100 },
      { observer_id: 'ob_1', metric: 'Purchases', value: 150 },
    ];
    const first = attributeOutcomes(baseConfig(), [assignA], outcomes, AT);
    const second = attributeOutcomes(baseConfig(), [assignA], outcomes, AT);
    expect(first.observations).toEqual(second.observations);
    const revenue = first.observations.find((o) => o.path[2] === 'revenue_cents');
    const count = first.observations.find((o) => o.path[2] === 'converted');
    expect(revenue?.value).toBe(250);
    expect(count?.value).toBe(2);
    expect(first.observations).toHaveLength(2);
  });

  it('applies where filters on both families', () => {
    const config = baseConfig();
    config.assignment.where = { path: ['address'], equals: 'surface:test' };
    config.outcome.where = { path: ['project'], equals: 'p1' };
    const result = attributeOutcomes(
      config,
      [assignA, { observer_id: 'ob_9', winner: 'cand-z', address: 'surface:OTHER' }],
      [
        { observer_id: 'ob_1', metric: 'Purchases', project: 'p1' },
        { observer_id: 'ob_1', metric: 'Purchases', project: 'p2' },
      ],
      AT,
    );
    const count = result.observations.find((o) => o.path[2] === 'converted');
    expect(count?.value).toBe(1);
    expect(result.observations.some((o) => o.path[3] === 'cand-z')).toBe(false);
  });

  it('reports and skips outcomes with no assignment', () => {
    const result = attributeOutcomes(baseConfig(), [assignA], [{ observer_id: 'ob_x', metric: 'Purchases' }], AT);
    expect(result.observations).toHaveLength(0);
    expect(result.findings.join(' ')).toContain('no assignment');
  });

  it('reports and skips unmapped metrics', () => {
    const result = attributeOutcomes(baseConfig(), [assignA], [{ observer_id: 'ob_1', metric: 'PageView' }], AT);
    expect(result.observations).toHaveLength(0);
    expect(result.findings.join(' ')).toContain('not in emit.metric_map');
  });

  it('reports and skips records with missing keys or metric', () => {
    const result = attributeOutcomes(
      baseConfig(),
      [{ winner: 'cand-a' }, { observer_id: 'ob_1' }, assignA],
      [{ metric: 'Purchases' }, { observer_id: 'ob_1' }],
      AT,
    );
    expect(result.observations).toHaveLength(0);
    expect(result.findings.length).toBe(4);
  });

  it('keeps the first assignment and reports conflicts', () => {
    const result = attributeOutcomes(
      baseConfig(),
      [assignA, { observer_id: 'ob_1', winner: 'cand-b' }],
      [{ observer_id: 'ob_1', metric: 'Purchases' }],
      AT,
    );
    expect(result.observations[0]?.path[3]).toBe('cand-a');
    expect(result.findings.join(' ')).toContain('conflicting');
  });

  it('ignores a duplicate identical assignment without a finding', () => {
    const result = attributeOutcomes(baseConfig(), [assignA, { ...assignA }], [{ observer_id: 'ob_1', metric: 'Purchases' }], AT);
    expect(result.findings).toHaveLength(0);
    expect(result.observations.find((o) => o.path[2] === 'converted')?.value).toBe(1);
  });

  it('counts an outcome with absent value without a finding, and skips non-numeric values with one', () => {
    const result = attributeOutcomes(
      baseConfig(),
      [assignA],
      [
        { observer_id: 'ob_1', metric: 'Purchases' },
        { observer_id: 'ob_1', metric: 'Purchases', value: 'USD 25' },
        { observer_id: 'ob_1', metric: 'Purchases', value: Number.NaN },
      ],
      AT,
    );
    expect(result.observations.find((o) => o.path[2] === 'converted')?.value).toBe(3);
    expect(result.observations.some((o) => o.path[2] === 'revenue_cents')).toBe(false);
    expect(result.findings.filter((f) => f.includes('not a finite number'))).toHaveLength(2);
  });

  it('omits value emission entirely when value_metric is not configured', () => {
    const config = baseConfig();
    delete (config.emit as Record<string, unknown>).value_metric;
    const result = attributeOutcomes(config, [assignA], [{ observer_id: 'ob_1', metric: 'Purchases', value: 99 }], AT);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.path[2]).toBe('converted');
  });

  it('returns config errors as findings and emits nothing on an invalid config', () => {
    const bad = { ...baseConfig(), join_id: '' };
    const result = attributeOutcomes(bad, [assignA], [{ observer_id: 'ob_1', metric: 'Purchases' }], AT);
    expect(result.observations).toHaveLength(0);
    expect(result.findings[0]).toContain('config:');
  });

  it('handles empty inputs', () => {
    const empty = attributeOutcomes(baseConfig(), [], [], AT);
    expect(empty.observations).toHaveLength(0);
    expect(empty.findings).toHaveLength(0);
  });

  it('supports transcript-shaped assignments via nested paths', () => {
    const config = baseConfig();
    config.assignment.observer_key_path = ['observer_id'];
    config.assignment.candidate_key_path = ['winner'];
    config.assignment.where = { path: ['address'], equals: 'offer:framing' };
    const transcript = {
      entity_type: 'transcript',
      observer_id: 'ob_7',
      address: 'offer:framing',
      winner: 'offer:variant-b',
      epoch: 'e1',
    };
    const result = attributeOutcomes(config, [transcript], [{ observer_id: 'ob_7', metric: 'Purchases', value: 250000 }], AT);
    expect(result.observations.find((o) => o.path[2] === 'converted')?.path[3]).toBe('offer:variant-b');
    expect(result.observations.find((o) => o.path[2] === 'revenue_cents')?.value).toBe(250000);
  });

  it('runs a different record family with a different config and zero code change', () => {
    const config: AttributionJoin = {
      entity_type: 'attribution-join',
      join_id: 'join:thumbnail-watch',
      assignment: {
        observer_key_path: ['viewer', 'id'],
        candidate_key_path: ['shown', 'thumbnail_id'],
      },
      outcome: {
        observer_key_path: ['session', 'viewer_id'],
        metric_path: ['event'],
        value_path: ['seconds_watched'],
      },
      emit: {
        observe_address: 'video:intro-thumbnail',
        metric_map: { watched: 'views' },
        value_metric: 'seconds',
        trust_ref: 'trust:playback',
      },
    };
    const result = attributeOutcomes(
      config,
      [{ viewer: { id: 'v1' }, shown: { thumbnail_id: 'thumb-red' } }],
      [{ session: { viewer_id: 'v1' }, event: 'watched', seconds_watched: 42 }],
      AT,
    );
    expect(result.observations.find((o) => o.path[2] === 'views')?.path[3]).toBe('thumb-red');
    expect(result.observations.find((o) => o.path[2] === 'seconds')?.value).toBe(42);
    expect(result.observations[0]?.trustRef).toBe('trust:playback');
  });

  it('supports the same observer in independent joins without interference', () => {
    const configA = baseConfig();
    const configB = baseConfig();
    configB.join_id = 'join:other';
    configB.emit.metric_map = { Leads: 'leads' };
    const assignments = [assignA];
    const resultA = attributeOutcomes(configA, assignments, [{ observer_id: 'ob_1', metric: 'Purchases' }], AT);
    const resultB = attributeOutcomes(configB, assignments, [{ observer_id: 'ob_1', metric: 'Leads' }], AT);
    expect(resultA.observations[0]?.path[2]).toBe('converted');
    expect(resultB.observations[0]?.path[2]).toBe('leads');
    expect(resultB.observations[0]?.basis).toBe('join:other');
  });

  it('folds 10k records linearly', () => {
    const assignments = Array.from({ length: 5000 }, (_, i) => ({ observer_id: `ob_${i}`, winner: i % 2 ? 'cand-a' : 'cand-b' }));
    const outcomes = Array.from({ length: 10000 }, (_, i) => ({ observer_id: `ob_${i % 5000}`, metric: 'Purchases', value: 10 }));
    const start = performance.now();
    const result = attributeOutcomes(baseConfig(), assignments, outcomes, AT);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
    const totalConverted = result.observations
      .filter((o) => o.path[2] === 'converted')
      .reduce((sum, o) => sum + (o.value as number), 0);
    expect(totalConverted).toBe(10000);
  });
});

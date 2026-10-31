import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import type { ObserverFact } from '../read-data/score-candidates.ts';
import {
  aggregateOutcomes,
  readOutcome,
  computeRate,
  type Scoreboard,
} from '../read-data/scoreboard.ts';

describe('aggregateOutcomes — O(facts at address)', () => {
  it('counts per-candidate metrics from outcome facts', () => {
    const facts: ObserverFact[] = [
      {
        path: ['candidate', 'outcome', 'views', 'a'],
        trust_ref: 'trust:derived',
        value: 10,
      },
      {
        path: ['candidate', 'outcome', 'clicks', 'a'],
        trust_ref: 'trust:derived',
        value: 2,
      },
      {
        path: ['candidate', 'outcome', 'views', 'b'],
        trust_ref: 'trust:derived',
        value: 8,
      },
      {
        path: ['candidate', 'outcome', 'converted', 'b'],
        trust_ref: 'trust:derived',
        value: 1,
      },
    ];

    const scoreboard = aggregateOutcomes('test.address', facts);

    expect(scoreboard.address).toBe('test.address');
    expect(scoreboard.total_events).toBe(4);
    expect(scoreboard.candidates['a'].views).toBe(10);
    expect(scoreboard.candidates['a'].clicks).toBe(2);
    expect(scoreboard.candidates['b'].views).toBe(8);
    expect(scoreboard.candidates['b'].converted).toBe(1);
  });

  it('sums numeric values for the same candidate + metric', () => {
    const facts: ObserverFact[] = [
      { path: ['candidate', 'outcome', 'views', 'x'], trust_ref: 'trust:derived', value: 5 },
      { path: ['candidate', 'outcome', 'views', 'x'], trust_ref: 'trust:derived', value: 3 },
      { path: ['candidate', 'outcome', 'views', 'x'], trust_ref: 'trust:derived', value: 2 },
    ];

    const scoreboard = aggregateOutcomes('test.address', facts);

    expect(scoreboard.candidates['x'].views).toBe(10);
    expect(scoreboard.total_events).toBe(3);
  });

  it('ignores non-outcome facts (different path shape)', () => {
    const facts: ObserverFact[] = [
      {
        path: ['candidate', 'outcome', 'views', 'a'],
        trust_ref: 'trust:derived',
        value: 10,
      },
      {
        path: ['signal', 'source'], // not a candidate outcome fact
        trust_ref: 'trust:supplied',
        value: 'google',
      },
      {
        path: ['candidate', 'outcome', 'views', 'b'],
        trust_ref: 'trust:derived',
        value: 5,
      },
    ];

    const scoreboard = aggregateOutcomes('test.address', facts);

    expect(Object.keys(scoreboard.candidates)).toEqual(['a', 'b']);
    expect(scoreboard.total_events).toBe(2);
  });

  it('handles non-numeric values (last-write-wins)', () => {
    const facts: ObserverFact[] = [
      {
        path: ['candidate', 'outcome', 'status', 'a'],
        trust_ref: 'trust:derived',
        value: 'active',
      },
      {
        path: ['candidate', 'outcome', 'status', 'a'],
        trust_ref: 'trust:derived',
        value: 'archived',
      },
    ];

    const scoreboard = aggregateOutcomes('test.address', facts);

    expect(scoreboard.candidates['a'].status).toBe('archived');
  });

  it('handles mixed numeric and non-numeric (no accumulation)', () => {
    const facts: ObserverFact[] = [
      {
        path: ['candidate', 'outcome', 'mixed', 'a'],
        trust_ref: 'trust:derived',
        value: 10,
      },
      {
        path: ['candidate', 'outcome', 'mixed', 'a'],
        trust_ref: 'trust:derived',
        value: 'string-value',
      },
    ];

    const scoreboard = aggregateOutcomes('test.address', facts);

    // Numeric first, then non-numeric overwrites
    expect(typeof scoreboard.candidates['a'].mixed).toBe('string');
    expect(scoreboard.candidates['a'].mixed).toBe('string-value');
  });

  it('empty facts → empty candidates', () => {
    const scoreboard = aggregateOutcomes('test.address', []);

    expect(scoreboard.address).toBe('test.address');
    expect(Object.keys(scoreboard.candidates)).toHaveLength(0);
    expect(scoreboard.total_events).toBe(0);
  });

  it('multiple candidates aggregated into single scoreboard', () => {
    const facts: ObserverFact[] = [
      {
        path: ['candidate', 'outcome', 'views', 'a'],
        trust_ref: 'trust:derived',
        value: 100,
      },
      {
        path: ['candidate', 'outcome', 'views', 'b'],
        trust_ref: 'trust:derived',
        value: 80,
      },
      {
        path: ['candidate', 'outcome', 'views', 'c'],
        trust_ref: 'trust:derived',
        value: 60,
      },
    ];

    const scoreboard = aggregateOutcomes('test.address', facts);

    expect(Object.keys(scoreboard.candidates)).toHaveLength(3);
    expect(scoreboard.candidates['a'].views).toBe(100);
    expect(scoreboard.candidates['b'].views).toBe(80);
    expect(scoreboard.candidates['c'].views).toBe(60);
  });

  it('records as_timestamp', () => {
    const facts: ObserverFact[] = [];
    const scoreboard = aggregateOutcomes('test.address', facts);

    expect(scoreboard.as_timestamp).toBeDefined();
    expect(typeof scoreboard.as_timestamp).toBe('string');
  });
});

describe('readOutcome — typed lookup', () => {
  it('returns outcome metric for a candidate', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: {
        a: { candidate_id: 'a', views: 10, clicks: 2 },
        b: { candidate_id: 'b', views: 8, clicks: 1 },
      },
      total_events: 4,
      as_timestamp: new Date().toISOString(),
    };

    const views_a = readOutcome(scoreboard, 'a', 'views');
    const clicks_b = readOutcome(scoreboard, 'b', 'clicks');

    expect(views_a).toBe(10);
    expect(clicks_b).toBe(1);
  });

  it('returns undefined if candidate absent', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: { a: { candidate_id: 'a', views: 10 } },
      total_events: 1,
      as_timestamp: new Date().toISOString(),
    };

    const outcome = readOutcome(scoreboard, 'missing', 'views');

    expect(outcome).toBeUndefined();
  });

  it('returns undefined if metric absent', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: { a: { candidate_id: 'a', views: 10 } },
      total_events: 1,
      as_timestamp: new Date().toISOString(),
    };

    const outcome = readOutcome(scoreboard, 'a', 'missing_metric');

    expect(outcome).toBeUndefined();
  });

  it('returns undefined if metric is non-numeric', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: {
        a: { candidate_id: 'a', status: 'active', views: 10 },
      },
      total_events: 1,
      as_timestamp: new Date().toISOString(),
    };

    const outcome = readOutcome(scoreboard, 'a', 'status');

    expect(outcome).toBeUndefined();
  });
});

describe('computeRate — derived metric', () => {
  it('computes rate = numerator / denominator', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: {
        a: { candidate_id: 'a', converted: 2, views: 10 },
        b: { candidate_id: 'b', converted: 1, views: 5 },
      },
      total_events: 4,
      as_timestamp: new Date().toISOString(),
    };

    const rate_a = computeRate(scoreboard, 'a', 'converted', 'views');
    const rate_b = computeRate(scoreboard, 'b', 'converted', 'views');

    expect(rate_a).toBeCloseTo(0.2);
    expect(rate_b).toBeCloseTo(0.2);
  });

  it('returns undefined if numerator absent', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: {
        a: { candidate_id: 'a', views: 10 },
      },
      total_events: 1,
      as_timestamp: new Date().toISOString(),
    };

    const rate = computeRate(scoreboard, 'a', 'converted', 'views');

    expect(rate).toBeUndefined();
  });

  it('returns undefined if denominator absent', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: {
        a: { candidate_id: 'a', converted: 2 },
      },
      total_events: 1,
      as_timestamp: new Date().toISOString(),
    };

    const rate = computeRate(scoreboard, 'a', 'converted', 'views');

    expect(rate).toBeUndefined();
  });

  it('returns undefined if denominator is zero', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: {
        a: { candidate_id: 'a', converted: 2, views: 0 },
      },
      total_events: 1,
      as_timestamp: new Date().toISOString(),
    };

    const rate = computeRate(scoreboard, 'a', 'converted', 'views');

    expect(rate).toBeUndefined();
  });

  it('handles different metric names flexibly', () => {
    const scoreboard: Scoreboard = {
      address: 'test.address',
      candidates: {
        a: { candidate_id: 'a', clicks: 3, impressions: 30 },
      },
      total_events: 1,
      as_timestamp: new Date().toISOString(),
    };

    const ctr = computeRate(scoreboard, 'a', 'clicks', 'impressions');

    expect(ctr).toBeCloseTo(0.1);
  });
});

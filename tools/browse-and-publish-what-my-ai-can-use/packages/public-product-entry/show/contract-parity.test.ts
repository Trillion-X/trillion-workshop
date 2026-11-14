import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeSemanticSurface, semanticFingerprint } from './contract-model';

const root = join(__dirname, '..');

describe('public product entry browser generic contract parity', () => {
  const fixture = JSON.parse(
    readFileSync(join(root, 'test-fixtures/generic-record-work-surface-states.json'), 'utf8'),
  ) as { states: Array<Record<string, unknown> & { name: string }> };

  it('materializes every state through the same generic surface contract', () => {
    expect(fixture.states.map((state) => state.name)).toEqual([
      'empty',
      'sparse',
      'dense',
      'loading',
      'error',
      'adversarial-non-product',
    ]);

    for (const state of fixture.states) {
      const materialized = materializeSemanticSurface(state);
      expect(semanticFingerprint(materialized)).toMatchObject({
        state: state.state,
      });
    }
  });

  it('keeps non-product examples in data values, not code branches', () => {
    const adversarial = fixture.states.find((state) => state.name === 'adversarial-non-product');
    const materialized = materializeSemanticSurface(adversarial ?? {});
    expect(materialized.records.map((record) => record.label)).toEqual([
      'Lead follow-up',
      'Calendar event',
    ]);
  });
});

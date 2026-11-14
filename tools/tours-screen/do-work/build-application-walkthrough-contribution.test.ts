import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

import { buildApplicationWalkthroughContributionTarget } from './build-application-walkthrough-contribution.ts';

const operation = {
  operation: 'upsert',
  composition_id: 'sample/app',
  contribution_id: 'sample-walkthrough',
  owner_ref: 'package::guided-overlay::application-contribution::walkthrough-definition',
  state_epoch: 1,
  config: {
    definition: {
      kind: 'walkthrough-definition',
      id: 'sample/guide',
      entry_step: 'start',
      steps: [{ id: 'start', content: { content_kind: 'text', payload: { title: 'Start' } } }],
    },
  },
};

describe('guided overlay application walkthrough target', () => {
  it('returns compiler-bound derivation variables and the owner record path', () => {
    expect(buildApplicationWalkthroughContributionTarget(operation)).toMatchObject({
      kind: 'package-target-prepared-write',
      record_address: 'package::guided-overlay::walkthrough-definition::sample%2Fapp::sample%2Fguide',
      derivation: 'application-walkthrough-definition',
      address_variables: {
        composition_id: 'sample/app',
        definition_id: 'sample/guide',
      },
      path_labels: ['current-item', 'published-record'],
    });
  });

  it('returns a derived-record write envelope without caller prefix authority', () => {
    const prepared = buildApplicationWalkthroughContributionTarget(operation);
    const result = buildApplicationWalkthroughContributionTarget({
      intent: 'apply',
      prepared,
      expected_current: { state: 'absent' },
    }) as { writes: unknown[] };

    expect(result.writes).toEqual([expect.objectContaining({
      record_address: 'package::guided-overlay::walkthrough-definition::sample%2Fapp::sample%2Fguide',
      derivation: 'application-walkthrough-definition',
      address_variables: {
        composition_id: 'sample/app',
        definition_id: 'sample/guide',
      },
      path_labels: ['current-item', 'published-record'],
      expected_current: { state: 'absent' },
    })]);
  });

  it('rejects a prepared result that changes the compiler derivation', () => {
    const prepared = buildApplicationWalkthroughContributionTarget(operation) as Record<string, unknown>;
    expect(() => buildApplicationWalkthroughContributionTarget({
      intent: 'apply',
      prepared: { ...prepared, derivation: 'application-board-surface' },
      expected_current: { state: 'absent' },
    })).toThrow('prepared walkthrough destination');
  });
});


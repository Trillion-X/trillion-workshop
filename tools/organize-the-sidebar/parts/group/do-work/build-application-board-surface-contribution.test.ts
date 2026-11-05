import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';

import { buildApplicationBoardSurfaceContributionTarget } from '../../../do-work/build-application-board-surface-contribution.ts';

const operation = {
  operation: 'upsert',
  composition_id: 'sample/app',
  contribution_id: 'sample-board',
  owner_ref: 'package::group::application-contribution::board-surface',
  state_epoch: 1,
  config: {
    surface_id: 'sample/board',
    order_key: '0001:sample-board',
    label: 'Sample board',
    placement_labels: ['sample-workspace'],
    surface_input: { partition_label: 'sample', board_id: 'sample.board' },
  },
};

describe('group application board target', () => {
  it('returns compiler-bound derivation variables and the owner record path', () => {
    expect(buildApplicationBoardSurfaceContributionTarget(operation)).toMatchObject({
      kind: 'package-target-prepared-write',
      record_address: 'package::group::placeable-surface::sample%2Fapp::sample%2Fboard',
      derivation: 'application-board-surface',
      address_variables: {
        composition_id: 'sample/app',
        surface_id: 'sample/board',
      },
      path_labels: ['current-item', 'published-record'],
    });
  });

  it('returns a derived-record write envelope without caller prefix authority', () => {
    const prepared = buildApplicationBoardSurfaceContributionTarget(operation);
    const result = buildApplicationBoardSurfaceContributionTarget({
      intent: 'apply',
      prepared,
      expected_current: { state: 'absent' },
    }) as { writes: unknown[] };

    expect(result.writes).toEqual([expect.objectContaining({
      record_address: 'package::group::placeable-surface::sample%2Fapp::sample%2Fboard',
      derivation: 'application-board-surface',
      address_variables: {
        composition_id: 'sample/app',
        surface_id: 'sample/board',
      },
      path_labels: ['current-item', 'published-record'],
      expected_current: { state: 'absent' },
    })]);
  });

  it('rejects a prepared result that changes the compiler derivation', () => {
    const prepared = buildApplicationBoardSurfaceContributionTarget(operation) as Record<string, unknown>;
    expect(() => buildApplicationBoardSurfaceContributionTarget({
      intent: 'apply',
      prepared: { ...prepared, derivation: 'application-walkthrough-definition' },
      expected_current: { state: 'absent' },
    })).toThrow('prepared board destination');
  });
});


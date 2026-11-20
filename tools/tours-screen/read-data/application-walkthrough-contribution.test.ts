// The package's test of the walkthrough contribution. Its fourth case read the package boundary file things-to-store-and-run.json (the retired package runtime's list of entries); that file is not carried, so that case is not ported.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

import { buildApplicationWalkthroughContribution } from './application-walkthrough-contribution.ts';

const operation = {
  operation: 'upsert',
  composition_id: 'sample-app',
  contribution_id: 'sample-walkthrough',
  owner_ref: 'package::guided-overlay::application-contribution::walkthrough-definition',
  state_epoch: 1,
  config: {
    definition: {
      kind: 'walkthrough-definition',
      id: 'sample-guide',
      entry_step: 'start',
      steps: [{ id: 'start', content: { content_kind: 'text', payload: { title: 'Start' } } }],
    },
  },
};

describe('guided overlay application contribution', () => {
  it('materializes definition DATA in the guided-overlay owner namespace', () => {
    expect(buildApplicationWalkthroughContribution(operation)).toMatchObject({
      write_set: {
        upserts: [{
          address: 'package::guided-overlay::walkthrough-definition::sample-app::sample-guide',
          payload: {
            kind: 'walkthrough-definition',
            id: 'sample-guide',
            application_composition_ref: {
              composition_id: 'sample-app', contribution_id: 'sample-walkthrough', state_epoch: 1,
            },
          },
        }],
        retractions: [],
      },
    });
  });

  it('emits a payload-omitting retraction', () => {
    const result = buildApplicationWalkthroughContribution({ ...operation, operation: 'retract' });
    expect(result.write_set.retractions[0]).not.toHaveProperty('payload');
    expect(result.write_set.retractions[0]).toMatchObject({ remove: true });
  });

  it('prevents cross-application definition address collisions and requires lifecycle identity', () => {
    const other = buildApplicationWalkthroughContribution({ ...operation, composition_id: 'other-app' });
    expect(other.write_set.upserts[0]?.address).toBe(
      'package::guided-overlay::walkthrough-definition::other-app::sample-guide',
    );
    const { contribution_id: _removed, ...withoutContribution } = operation;
    expect(() => buildApplicationWalkthroughContribution(withoutContribution)).toThrow('contribution_id');
  });
});

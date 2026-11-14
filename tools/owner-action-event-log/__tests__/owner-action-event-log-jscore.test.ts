import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { projectOwnerActionEventLogForJscore } from '../ios-jscore/owner-action-event-log-jscore.ts';
import { projectUniversalActionEvents } from '../read-data/project-universal-action-events.ts';
import { fixtureDescriptors, fixtureRecords } from '../read-data/universal-action-event-fixtures.ts';

describe('owner action event JSCore projection', () => {
  it('matches the shared projection contract', () => {
    const expected = projectUniversalActionEvents({ records: fixtureRecords, descriptors: fixtureDescriptors, selectedId: 'record:1' });
    const actual = projectOwnerActionEventLogForJscore({ records: fixtureRecords, descriptors: fixtureDescriptors, selectedId: 'record:1' });
    expect(actual).toEqual(expected);
  });
});

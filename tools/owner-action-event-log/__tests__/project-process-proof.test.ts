import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { projectProcessProof } from '../read-data/project-process-proof.ts';
import { fixtureRecords } from '../read-data/universal-action-event-fixtures.ts';

describe('projectProcessProof', () => {
  it('maps declared process/session evidence into a generic proof row', () => {
    const proof = projectProcessProof({
      record: { ...fixtureRecords[0], processSessionRefs: ['session:1'], payload: { eventFeedRef: 'feed:1' } },
      feed: { summary: { text: 'Completed' } },
      descriptor: {
        id: 'process-proof',
        label: 'Run proof',
        eventFeedRefPath: ['payload', 'eventFeedRef'],
        summaryPaths: [['summary', 'text']],
      },
    });
    expect(proof.sessionRef).toBe('session:1');
    expect(proof.eventFeedRef).toBe('feed:1');
    expect(proof.summary).toBe('Completed');
  });

  it('keeps malformed proof safe and visible', () => {
    const proof = projectProcessProof({ record: fixtureRecords[0], descriptor: { id: 'process-proof' } });
    expect(proof.error).toBe('Proof is not available.');
  });
});

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { decodeUniversalActionEventDescriptors, decodeUniversalActionEventRecords } from '../read-data/decode-universal-action-event-inputs.ts';
import { fixtureDescriptors, fixtureRecords } from '../read-data/universal-action-event-fixtures.ts';

describe('universal action event contracts', () => {
  it('decodes open descriptors and records', () => {
    const descriptors = decodeUniversalActionEventDescriptors(fixtureDescriptors);
    const records = decodeUniversalActionEventRecords(fixtureRecords);
    expect(descriptors.domainOptions?.map((entry) => entry.id)).toContain('descriptor:follow-up');
    expect(records).toHaveLength(2);
  });

  it('rejects malformed descriptor ids', () => {
    expect(() => decodeUniversalActionEventDescriptors({ fields: [{ label: 'No id' }] })).toThrow(/field descriptor/);
  });
});

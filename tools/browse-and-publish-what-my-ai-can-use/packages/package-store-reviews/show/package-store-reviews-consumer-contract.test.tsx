import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { GenericRecordContracts } from '../read-data/descriptor-contracts';
import { readGenericRecordProjection } from '../read-data/read-generic-record-projection';

const root = join(process.cwd(), 'packages/package-store-reviews');
const contracts = JSON.parse(readFileSync(join(root, 'data/generic-record-contracts.json'), 'utf8')) as GenericRecordContracts;
const fixtures = JSON.parse(readFileSync(join(root, '__tests__/fixtures/generic-record-events.json'), 'utf8')) as Record<string, unknown[]>;

function consumeBrowserReaderOutput(value: ReturnType<typeof readGenericRecordProjection>) {
  return {
    state: value.state,
    summaryCount: value.summary?.count ?? 0,
    actionRefs: value.actions?.map((action) => action.id) ?? [],
    itemIds: value.items?.map((item) => item.id) ?? [],
  };
}

describe('browser consumer contract', () => {
  it('consumes reader output without computing owner meaning locally', () => {
    const projection = readGenericRecordProjection({ contracts, reader_id: 'package-page', events: fixtures.sparse });
    expect(consumeBrowserReaderOutput(projection)).toEqual({
      state: 'sparse',
      summaryCount: 2,
      actionRefs: ['append-statement', 'append-response', 'append-concern', 'append-signal', 'run-external-check'],
      itemIds: ['entry-1', 'entry-2'],
    });
  });
});

// Synthetic consumer, never packed by an active row. Only a made-up test account is handed on descriptor 3.
import { accountToolSourcesFromDoor } from '../do-work/sources.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
export const config = {
  kinds: { openapi: { label: 'An API', becomes: 'tool', source: { kind: 'tool-row-source', list: { openapi: {} } } } },
  sources: [],
};
export async function boundSource(input, { door }) {
  // This fake HTTP door predates native root stamps. Content stamps suffice only for this non-concurrent example;
  // the separate ABA control uses monotonic stamps, as native root_identity does.
  const readRecord = async (...args) => {
    const row = await door.readRecord(...args);
    return row && { ...row, identity: makeHashCodeHexFromJson(row.value) };
  };
  return accountToolSourcesFromDoor(input, {
    door: { ...door, readRecord },
    sourceConfig: { config: async () => structuredClone(config), reads: async own => own.map(row => ({ source_id: row.id, scope: 'account', state: 'pending', tools: [] })) },
  });
}

// tools/build-and-send-a-sales-contract/do-work/sales-contract-actions.mjs
//
// The save, list and read actions for sales contracts, run by the workflow host (fn(input, host)). Each contract is a record of
// the person's own store (type `sales-contract`), read and written through the records door with host.operation. The rules
// are the store's (sales-contract-records.mjs): this file only loads the person's contracts into it and writes back what it
// saved. Nothing here fixes a price, a term or a billing period.
import { makeSalesContracts } from './sales-contract-records.mjs';

export const CONTRACT_TYPE = 'sales-contract';
const PAGE_LIMIT = 100;
const MOST_PAGES = 1000;

/** Every contract of the person, as { id, value } rows, read a page at a time through the records door. */
async function loadContracts(host) {
  const rows = new Map();
  let after = null;
  for (let page = 0; page < MOST_PAGES; page++) {
    const answer = await host.operation('records:list', { type: CONTRACT_TYPE, limit: PAGE_LIMIT, ...(after ? { after } : {}) });
    if (!Array.isArray(answer?.records)) throw new Error('The records door did not return the sales contracts.');
    for (const row of answer.records) rows.set(row.id, row.value);
    if (!answer.next) return rows;
    after = answer.next;
  }
  throw new Error('There are more sales contracts than this action reads at once.');
}

/** The store the contract rules run over: a snapshot of the loaded rows, with the rows a save puts kept for writing back. */
function snapshotStore(rows) {
  const written = new Map();
  return {
    written,
    list: () => [...rows.values()],
    put: (id, row) => { rows.set(id, row); written.set(id, row); },
  };
}

/** save: { contract, contract_id? } → the saved contract record. */
export async function saveSalesContract(input, host) {
  const store = snapshotStore(await loadContracts(host));
  const saved = makeSalesContracts({ store }).save(input);
  if (store.written.size) {
    await host.operation('records:write', { records: [...store.written].map(([id, value]) => ({ id, type: CONTRACT_TYPE, value })) });
  }
  return saved;
}

/** list: {} → { contracts, count }, newest first. */
export async function listSalesContracts(input, host) {
  return makeSalesContracts({ store: snapshotStore(await loadContracts(host)) }).list();
}

/** read: { contract_id } → the contract record, or a refusal that it is not in this account. */
export async function readSalesContract(input, host) {
  return makeSalesContracts({ store: snapshotStore(await loadContracts(host)) }).read(input?.contract_id);
}

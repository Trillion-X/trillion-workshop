// Sales contracts in an account: the rows that are contract records and not removed, newest first.
// Port of the list rule in the old sales-contracts owner (src/sales-contracts.mjs at 5dc302be). Storage-free: the caller
// passes the stored rows. The shared row checks and the contract error class also live here, so every module in this
// folder reads and refuses the same way.
import data from './list-contract-records.json' with { type: 'json' };

export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = value => typeof value === 'string' && value.trim().length > 0;

export class SalesContractRuleError extends Error {}

/** The stored rows that are contract records (an id, not removed). */
export function currentContractRows(rows) {
  return rows.filter(row => object(row) && text(row.id) && !row[data.removed_field]);
}

/** → { contracts, count } with the newest first by the sort field. */
export function listContractRecords(rows) {
  const contracts = currentContractRows(rows).sort((a, b) => String(b[data.sort_field]).localeCompare(String(a[data.sort_field])));
  return { contracts, count: contracts.length };
}

// Reading one sales contract by its id, or refusing with the old owner's words.
// Port of the read rule in the old sales-contracts owner (src/sales-contracts.mjs at 5dc302be). Storage-free: the caller
// passes the stored rows.
import data from './read-contract-record.json' with { type: 'json' };
import { currentContractRows, SalesContractRuleError } from './list-contract-records.mjs';

/** → the current contract row with this id; refuses when there is none. */
export function readContractRecord(rows, contractId) {
  const contract = currentContractRows(rows).find(row => row.id === contractId);
  if (!contract) {
    throw new SalesContractRuleError(data.messages.not_found.replace('{id}', () => contractId || data.messages.no_id));
  }
  return contract;
}

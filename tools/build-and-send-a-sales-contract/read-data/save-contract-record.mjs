// Saving a sales contract as its stored record: the checks on the terms and the record's fields.
// Port of the save rule in the old sales-contracts owner (src/sales-contracts.mjs at 5dc302be). Storage-free: the caller
// passes the stored rows and writes the record this returns under its id.
import data from './save-contract-record.json' with { type: 'json' };
import { currentContractRows, object, SalesContractRuleError, text } from './list-contract-records.mjs';

function cleanContract(value) {
  if (!object(value)) throw new SalesContractRuleError(data.messages.terms_not_object);
  const contract = structuredClone(value);
  if (!text(contract.name)) throw new SalesContractRuleError(data.messages.no_name);
  if (contract.primitives !== undefined && !Array.isArray(contract.primitives)) throw new SalesContractRuleError(data.messages.primitives_not_list);
  return contract;
}

/**
 * input: the save request as sent ({ contract, contract_id? }); rows: every stored row; at: ISO timestamp;
 * newId: () => string. → { id, record }. A removed row is not an earlier version, so its created_at is not kept.
 */
export function saveContractRecord({ input = {}, rows, at, newId }) {
  if (!object(input)) throw new SalesContractRuleError(data.messages.not_object);
  const contract = cleanContract(input.contract);
  const id = text(input.contract_id) ? input.contract_id : `${data.id_prefix}${newId()}`;
  const earlier = currentContractRows(rows).find(row => row.id === id);
  const record = {
    id,
    kind: data.kind,
    status: data.status,
    name: contract.name.trim(),
    contract,
    created_at: earlier?.created_at ?? at,
    updated_at: at,
    ...(text(earlier?.share_id) ? { share_id: earlier.share_id } : {}),
  };
  return { id, record };
}

// Sales contracts as records in the person's own Trillion account.
// The Workshop is the AI entry point; the existing contract-builder screen is the human entry point.
// Contract terms are caller supplied data. This owner deliberately has no default price or fixed billing period.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

export class SalesContractsError extends Error {}

function cleanContract(value) {
  if (!object(value)) throw new SalesContractsError('Give the contract terms as an object.');
  const contract = structuredClone(value);
  if (!text(contract.name)) throw new SalesContractsError('Give the contract a name.');
  if (contract.primitives !== undefined && !Array.isArray(contract.primitives)) {
    throw new SalesContractsError('Contract primitives must be a list.');
  }
  return contract;
}

/** store: { list(): ContractRecord[], put(id, value) }; now(): ISO timestamp */
export function makeSalesContracts({ store, now = () => new Date().toISOString(), id = () => crypto.randomUUID() }) {
  if (!store || typeof store.list !== 'function' || typeof store.put !== 'function') {
    throw new TypeError('Sales contracts need the account store that owns their records.');
  }
  const current = () => store.list().filter(row => object(row) && text(row.id) && !row.removed_at);

  function list() {
    const contracts = current().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return { contracts, count: contracts.length };
  }

  function read(contractId) {
    const contract = current().find(row => row.id === contractId);
    if (!contract) throw new SalesContractsError(`There is no sales contract ${contractId || 'with no id'} in this account.`);
    return contract;
  }

  function save(input = {}) {
    if (!object(input)) throw new SalesContractsError('Give { contract } to save a sales contract.');
    const contract = cleanContract(input.contract);
    const contractId = text(input.contract_id) ? input.contract_id : `sales-contract:${id()}`;
    const earlier = current().find(row => row.id === contractId);
    const at = now();
    const record = {
      id: contractId,
      kind: 'sales-contract',
      status: 'draft',
      name: contract.name.trim(),
      contract,
      created_at: earlier?.created_at ?? at,
      updated_at: at,
      ...(text(earlier?.share_id) ? { share_id: earlier.share_id } : {}),
    };
    store.put(contractId, record);
    return record;
  }

  return { list, read, save };
}

// The account store the sales contracts sit in: their values are read by the contract key prefix and written by id.
// Port of the store adapter in the old native commercial owner (src/native-commercial-domain.mjs at 3b7063d6f3). The
// account functions are passed in by the caller, so this module holds no storage of its own.
import data from './contract-store-adapter.json' with { type: 'json' };

/** → { list(), put(id, value) } for makeSalesContracts-style callers. */
export function makeContractStoreAdapter({ readValuesWithPrefix, writeValue }) {
  if (typeof readValuesWithPrefix !== 'function' || typeof writeValue !== 'function') {
    throw new TypeError(data.messages.no_store);
  }
  return {
    list: () => readValuesWithPrefix(data.prefix),
    put: (id, value) => writeValue(id, value),
  };
}

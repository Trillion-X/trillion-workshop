//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Input name constants that bind this package's UI to the live log addresses.
// The surface calls useBitfieldData(inputName) — the runtime resolves
// inputName → bitfield-input-descriptor → value_address_label → log read.
//
// NON-NEGOTIABLE: input names must match the "input_name" field in the
// bitfield-input-descriptor records declared in ../things-to-store-and-run.json
// (the manifest is the only place they are declared; no delivery script exists).
// =============================================================================

/** Live gamma.markets array from the most recent discover-markets run. */
export const polymarketMarketsInput = {
  inputName: 'polymarket-markets',
  bridgeAddressLabel: 'polymarket:gamma.markets',
} as const;

/** Live clob.book object from the most recent scan-order-book run. */
export const polymarketBookInput = {
  inputName: 'polymarket-book',
  bridgeAddressLabel: 'polymarket:clob.book',
} as const;

/** Live market list descriptor fields record. */
export const polymarketMarketFieldsInput = {
  inputName: 'polymarket-market-fields',
  bridgeAddressLabel: 'polymarket:market-board.fields',
} as const;

/** Live market list descriptor views record. */
export const polymarketMarketViewsInput = {
  inputName: 'polymarket-market-views',
  bridgeAddressLabel: 'polymarket:market-board.views',
} as const;

/** Live order book descriptor fields record. */
export const polymarketBookFieldsInput = {
  inputName: 'polymarket-book-fields',
  bridgeAddressLabel: 'polymarket:book-board.fields',
} as const;

/** Live order book descriptor views record. */
export const polymarketBookViewsInput = {
  inputName: 'polymarket-book-views',
  bridgeAddressLabel: 'polymarket:book-board.views',
} as const;

/** Live polymarket capability record — used to show connection state + actions. */
export const polymarketCapabilityInput = {
  inputName: 'polymarket-capability',
  bridgeAddressLabel: 'polymarket:market-capability.latest',
} as const;

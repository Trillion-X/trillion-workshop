import type { AddressRef } from '../../ui/show/visual-layer-stack'

/** Serialize a region AddressRef for the `data-node-ref` stamp without loading menus or stores. */
export function nodeRefAttr(ref: AddressRef): string { return JSON.stringify(ref) }

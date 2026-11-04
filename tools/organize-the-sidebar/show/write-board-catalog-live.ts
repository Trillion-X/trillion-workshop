// packages/group/show/write-board-catalog-live.ts
//
// Publish a USER-CREATED catalog item (a custom stamp glyph, a custom note colour, …) to
// the LIVE log as a one-item published-record — the SAVE side of the mergeCatalog seams
// that already READ these catalogs (readStampCatalog / readFillSwatchCatalog / …). a user's
// "I still can't add any infinite custom stamps" (R44): the DATA seam existed but had no
// write, so the picker only ever showed the built-ins.
//
// GENERIC (L069/L090): this writer never names a specific catalog. It is handed a catalog
// DESCRIPTOR (kind + arrayKey + address prefix) plus the item to append, and writes the exact
// `{kind, [arrayKey]:[item]}` shape mergeCatalog merges by `kind` — so a written stamp/colour
// round-trips into its picker with ZERO redeploy. Adding a NEW user-extensible catalog is one
// descriptor, zero writer edits. The write goes through engine.operation.write-batch (the
// post-log-ownership front door). The `sender` is injectable for studio-independent unit tests.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import { buildEngineWriteBatchRequestFromLabels } from '#workspace-records';
import { writeCountOf } from '../read-data/write-count';

const textEncoder = new TextEncoder();

/** A user-extensible board catalog's published-record identity — everything the generic
 *  writer needs to append one item, all DATA (no per-catalog code). */
export interface BoardCatalogDescriptor {
  /** The `payload.kind` mergeCatalog matches on (e.g. 'stamp-catalog'). */
  readonly kind: string;
  /** The payload array field the catalog rows live under (e.g. 'stamps'). */
  readonly arrayKey: string;
  /** Stable, unique published-record address prefix for this catalog family. */
  readonly addressPrefix: string;
}

/** kebab-case a free-text value into a stable, readable address segment (empty → 'item'). */
function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 40) || 'item';
}

export interface BoardCatalogWriteItem {
  readonly address: string;
  readonly path: readonly string[];
  readonly payload: unknown;
}

/** Build the live-write item: a one-row `{kind, [arrayKey]:[item]}` published-record — the
 *  EXACT shape the matching mergeCatalog reader merges, so the new row appears in its picker. */
export function buildBoardCatalogWriteItem(
  descriptor: BoardCatalogDescriptor,
  item: { readonly id: string } & Record<string, unknown>,
): BoardCatalogWriteItem {
  return {
    address: `${descriptor.addressPrefix}${slugify(item.id)}`,
    path: ['current-item', 'published-record'],
    payload: { kind: descriptor.kind, [descriptor.arrayKey]: [item] },
  };
}

export type BitfieldRequestSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

/**
 * Persist a captured catalog item to the live log. Returns the written address on success;
 * throws when the engine rejects the single write (so the caller can show an error notice).
 */
export async function writeBoardCatalogItemLive(
  descriptor: BoardCatalogDescriptor,
  item: { readonly id: string } & Record<string, unknown>,
  partitionLabel: string,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<string> {
  const writeItem = buildBoardCatalogWriteItem(descriptor, item);
  const reply = await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel: writeItem.address,
    pathLabels: [...writeItem.path],
    payloadBytes: textEncoder.encode(JSON.stringify(writeItem.payload)),
  }]) as { target: string; payload: unknown });
  if (writeCountOf(reply) !== 1) {
    throw new Error('This could not be saved.');
  }
  return writeItem.address;
}

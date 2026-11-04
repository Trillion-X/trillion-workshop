// packages/group/read-data/read-producer-status.ts
//
// The generic producer→board status read seam. A producer (single-artifact or
// multi-item) writes a result or error record at addresses IT owns; the board
// reads them and reflects done(src|items) / error(message) / pending on the
// matching item. The board is BLIND to the producer — it does NOT construct or
// know the producer's addresses. The producer hands the board its status
// addresses as DATA (carried in the item's `presentation.extra.statusAddresses`),
// and this reader consults exactly those. Naming any producer package address in
// here would be a Society leak — so the addresses arrive as DATA, never hardcoded.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '#workspace-records';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Where a producer wrote this item's result/error — supplied by the producer as DATA. */
export interface ProducerStatusAddresses {
  /** Address of the producer's success record (carries a servable `src`). */
  readonly resultAddress: string;
  /** Address of the producer's honest error record (carries a `message`). */
  readonly errorAddress: string;
  /** How those addresses were written (default label-hash). */
  readonly addressMode?: 'label-hash' | 'identity-text';
  /** The partition to poll for result/error. When set, overrides the caller-supplied
   *  board partition — required when the producer's workflow writes to a different
   *  partition than the board (e.g. workflow partition_key:"runtime-partition" vs the
   *  board's own partition, whatever app it is installed in). Absent → caller's
   *  partition is used.
   *
   *  The example named "bitfield-studio" until 2026-09-03. That app is retired, and
   *  this package names no app by design. */
  readonly resultPartitionLabel?: string;
}

/** One item a producer returns. Two producer shapes reuse this ONE result item (L069):
 *
 *  - GENERATIVE (remote / source pull): carries `text`/`src`/`extra` and NO `memberId`.
 *    The board lays these out in a grid as NEW members (the trigger is replaced).
 *  - IDENTITY-PRESERVING (enrichment): carries the EXISTING `memberId` + a full
 *    `presentation` patch. The board merges the patch onto that member IN PLACE via
 *    applyProducerOutput's merge-by-identity branch (no layout, no new ids, no
 *    trigger removal). This is how a link card's bare-domain title flips to the real
 *    page title once an OG fetch lands — the card stays put, only its DATA grows.
 *
 *  Opaque-ish throughout: the board writes the producer's fields verbatim (L090). */
export interface ProducerResultItem {
  readonly kind?: string;
  readonly text?: string;
  readonly src?: string;
  readonly contentType?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  /** IDENTITY-PRESERVING: the existing member this result patches in place. */
  readonly memberId?: string;
  /** The member's node address (used only when INSERTing; ignored on a merge). */
  readonly nodeRef?: string;
  /** A full presentation patch, merged verbatim over the member (identity path). */
  readonly presentation?: Readonly<Record<string, unknown>>;
}

export type ProducerStatus =
  | { readonly state: 'pending' }
  // Single-artifact producer: the result fills `src` on the existing item.
  | { readonly state: 'done'; readonly src: string; readonly contentType?: string }
  // Multi-item producer: the result is MANY items the board materializes via
  // applyProducerOutput (the trigger item is replaced by the produced items).
  | { readonly state: 'done'; readonly items: readonly ProducerResultItem[]; readonly incomplete?: true }
  | { readonly state: 'error'; readonly code?: string; readonly message: string };

export type ProducerStatusSender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

function payloadBytesFromReply(reply: unknown): Uint8Array | null {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (typeof reply === 'string') return textEncoder.encode(reply);
  if (reply && typeof reply === 'object') {
    const payload = (reply as { payload?: unknown }).payload;
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (typeof payload === 'string') return textEncoder.encode(payload);
  }
  return null;
}

async function readRecord(
  sender: ProducerStatusSender,
  partition: string,
  address: string,
  addressMode?: string,
): Promise<Record<string, unknown> | null> {
  const request = addressMode
    ? buildEngineReadCurrentRequestFromLabels(partition, address, { addressMode })
    : buildEngineReadCurrentRequestFromLabels(partition, address);
  const reply = await sender(request);
  const bytes = payloadBytesFromReply(reply);
  if (!bytes) return null;
  const current = decodeEngineReadCurrentReply(bytes);
  if (!current.found) return null;
  try {
    const value = JSON.parse(textDecoder.decode(current.payload));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A producer result is UNTRUSTED (read from an engine record a remote/possibly-hostile producer
 *  wrote) — cap the item count so a runaway result can't make the board materialize unbounded members
 *  (OOM/hang). No real multi-item producer emits anywhere near this in one result. */
const MAX_PRODUCER_ITEMS = 1000;

/** A MULTI-item producer result carries an `items` array; validate + normalize it.
 *  Exported for unit coverage — the multi-item discriminator of the status read. */
export function itemsFromResult(value: unknown): readonly ProducerResultItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: ProducerResultItem[] = [];
  for (const raw of value.slice(0, MAX_PRODUCER_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const item: ProducerResultItem = {
      kind: typeof r.kind === 'string' ? r.kind : undefined,
      text: typeof r.text === 'string' ? r.text : undefined,
      src: typeof r.src === 'string' ? r.src : undefined,
      contentType: typeof r.contentType === 'string' ? r.contentType : undefined,
      extra: r.extra && typeof r.extra === 'object' ? (r.extra as Record<string, unknown>) : undefined,
      memberId: typeof r.memberId === 'string' ? r.memberId : undefined,
      nodeRef: typeof r.nodeRef === 'string' ? r.nodeRef : undefined,
      presentation:
        r.presentation && typeof r.presentation === 'object' ? (r.presentation as Record<string, unknown>) : undefined,
    };
    // Keep an item that materializes something: a NEW item (text|src) OR an
    // IDENTITY-PRESERVING patch (memberId). An identity patch legitimately carries
    // neither text nor src — its whole payload is the presentation merge.
    if (item.memberId !== undefined || item.text !== undefined || item.src !== undefined) items.push(item);
  }
  return items.length ? items : undefined;
}

/** Filtered or capped results cannot authorize removal of omitted board members. */
export function itemResultStatus(value: unknown): Extract<ProducerStatus, { items: readonly ProducerResultItem[] }> | undefined {
  const items = itemsFromResult(value);
  if (!items) return undefined;
  return { state: 'done', items, ...(Array.isArray(value) && items.length !== value.length ? { incomplete: true as const } : {}) };
}

/** Pull a servable src out of artifact refs (cas_address|src|url) if present. */
function srcFromArtifacts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const ref of value) {
    if (ref && typeof ref === 'object') {
      const r = ref as Record<string, unknown>;
      const src = r.cas_address ?? r.src ?? r.url;
      if (typeof src === 'string' && src) return src;
    }
  }
  return undefined;
}

/**
 * Read a producer's status for one item from the DATA addresses the producer
 * supplied: result(src) → done, else error(message) → error, else pending. The
 * board passes `item.extra.statusAddresses`; this reader never derives them.
 */
export async function readProducerStatus(
  partition: string,
  addresses: ProducerStatusAddresses,
  sender: ProducerStatusSender = sendRequestToBitfieldTarget as ProducerStatusSender,
): Promise<ProducerStatus> {
  // Use the producer's own partition when it differs from the board's partition.
  // This is the DATA override: a producer whose workflow writes to "runtime-partition"
  // sets resultPartitionLabel so the board polls the right partition, not its own.
  const pollPartition = addresses.resultPartitionLabel ?? partition;
  const result = await readRecord(sender, pollPartition, addresses.resultAddress, addresses.addressMode);
  if (result) {
    // Multi-item producer: the result is MANY items → materialize them via applyProducerOutput.
    const itemStatus = itemResultStatus(result.items);
    if (itemStatus) return itemStatus;
    // Single-artifact producer (image): the result carries one servable `src`.
    const src = typeof result.src === 'string' ? result.src : srcFromArtifacts(result.output_artifact_refs);
    if (src) {
      const contentType = typeof result.format === 'string' ? result.format : undefined;
      return { state: 'done', src, contentType };
    }
  }

  const error = await readRecord(sender, pollPartition, addresses.errorAddress, addresses.addressMode);
  if (error) {
    return {
      state: 'error',
      code: typeof error.code === 'string' ? error.code : undefined,
      // The producer's error record always supplies `message`; '' is the last-resort
      // neutral fallback — the board never authors domain-specific failure copy.
      message: typeof error.message === 'string' ? error.message : '',
    };
  }

  return { state: 'pending' };
}

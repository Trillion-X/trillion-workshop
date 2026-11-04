// Bounded blank-palette listing. Text discovery belongs to descriptor-selected
// ranking owners; this boundary is deliberately never used for nonblank input.

import { sendRequestToBitfieldTarget } from '#workspace-records';

const CURRENT_ITEMS_TARGET = 'slot::find-current-items';
const PUBLISHED_RECORD_SOURCE = 'published-record';

export interface PaletteQueryReply {
  target: string;
  recordId: string;
  sourcePath: string;
  publishedRecord: unknown;
  durationMs: number;
  reply: unknown;
  error: string | null;
  /** The source still searches the listed places; the current rows are provisional. */
  stillLooking?: boolean;
}

export interface ListCurrentItemsRequest {
  operation: 'find-current-items';
  in: typeof PUBLISHED_RECORD_SOURCE;
  limit: number;
}

export function makeListCurrentItemsRequest(maxResults: number): ListCurrentItemsRequest {
  return { operation: 'find-current-items', in: PUBLISHED_RECORD_SOURCE, limit: maxResults };
}

export async function askCurrentItemsForBlankPalette(
  maxResults: number,
  signal?: AbortSignal,
): Promise<PaletteQueryReply> {
  const startedAt = performance.now();
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: CURRENT_ITEMS_TARGET,
      payload: makeListCurrentItemsRequest(maxResults),
    }, signal);
    return {
      target: CURRENT_ITEMS_TARGET,
      recordId: PUBLISHED_RECORD_SOURCE,
      sourcePath: 'find-current-items.items',
      publishedRecord: null,
      durationMs: performance.now() - startedAt,
      reply,
      error: null,
    };
  } catch (rawError: unknown) {
    return {
      target: CURRENT_ITEMS_TARGET,
      recordId: PUBLISHED_RECORD_SOURCE,
      sourcePath: 'find-current-items.items',
      publishedRecord: null,
      durationMs: performance.now() - startedAt,
      reply: null,
      error: rawError instanceof Error ? rawError.message : String(rawError),
    };
  }
}

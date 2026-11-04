// packages/group/show/write-focus-view-live.ts
//
// Persist a NAMED SAVED FOCUS VIEW to the LIVE log as a `focus-view-catalog` published-record —
// the SAVE side of the saved-view round-trip (apply is just setting the panel's focus state;
// `readFocusViews` merges the record back into the Views list with ZERO redeploy). Mirrors the
// proven `write-appearance-preset-live.ts` (and the action-affordance writer): the write goes
// through `engine.operation.write-batch` (the post-log-ownership front door — folder edits are
// proposals, never live truth), and the `sender` is INJECTABLE so the builder + write shape are
// unit-testable studio-independently (a fake sender asserts the exact bytes).

import { sendRequestToBitfieldTarget } from '#workspace-records';
import { buildEngineWriteBatchRequestFromLabels } from '#workspace-records';
import { writeCountOf } from '../read-data/write-count';
import { FOCUS_VIEW_CATALOG_KIND, FOCUS_VIEW_SCHEMA_VERSION, focusViewSlug, type FocusView } from './focus-view';

const textEncoder = new TextEncoder();

/** The per-record published-record address family for saved focus views. The catalog READ matches
 *  by `payload.kind` (not address), so the address only needs to be unique+stable per saved view —
 *  keyed on the view id (name slug) so re-saving the same name OVERWRITES the same record. */
export const FOCUS_VIEW_ADDRESS_PREFIX = 'package::group::published-record::focus-view::';

/** One prebuilt live write: a published-record address + path + payload. */
export interface FocusViewWriteItem {
  readonly address: string;
  readonly path: readonly string[];
  readonly payload: unknown;
}

/**
 * Build the live-write item for a saved view. The payload is a one-view `focus-view-catalog`
 * record — the EXACT shape `readFocusViews` merges (`{kind, views:[…]}`), so a written view
 * round-trips into the Views list with no other change. Address keyed on the view id (so a
 * same-name re-save overwrites in place, mirroring `mergeCatalog`'s override-by-id).
 */
export function buildFocusViewWriteItem(view: FocusView): FocusViewWriteItem {
  return {
    address: `${FOCUS_VIEW_ADDRESS_PREFIX}${view.id || focusViewSlug(view.name)}`,
    path: ['current-item', 'published-record'],
    payload: { kind: FOCUS_VIEW_CATALOG_KIND, version: FOCUS_VIEW_SCHEMA_VERSION, views: [view] },
  };
}

export type BitfieldRequestSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

/**
 * Persist a saved focus view to the live log. Returns the written address on success; throws when
 * the engine rejects the single write (so the caller can show an error notice).
 */
export async function writeFocusViewLive(
  view: FocusView,
  partitionLabel: string,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<string> {
  const item = buildFocusViewWriteItem(view);
  const reply = await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel: item.address,
    pathLabels: [...item.path],
    payloadBytes: textEncoder.encode(JSON.stringify(item.payload)),
  }]) as { target: string; payload: unknown });
  if (writeCountOf(reply) !== 1) {
    throw new Error('This view could not be saved.');
  }
  return item.address;
}

// packages/group/show/write-appearance-preset-live.ts
//
// Publish a USER-CAPTURED board look (an AppearancePreset) to the LIVE log as an
// `appearance-preset-catalog` published-record — the SAVE side of the appearance-preset
// round-trip (apply already exists via AppearancePresetControl; makeAppearancePreset captured
// the profile but had no persistence). Mirrors the proven action-affordance live-write: the
// record streams back through `published-records`, so the saved look appears in the "Board look"
// list with ZERO redeploy (readAppearancePresetCatalog merges it by `kind`, any address).
//
// The write goes through engine.operation.write-batch (the post-log-ownership front door — folder
// edits are proposals, never live truth). The `sender` is INJECTABLE so the builder + write shape
// are unit-testable studio-independently (a fake sender asserts the exact bytes).

import { sendRequestToBitfieldTarget } from '#workspace-records';
import { buildEngineWriteBatchRequestFromLabels } from '#workspace-records';
import type { AppearancePreset } from './appearance-presets.ts';
import { APPEARANCE_PRESET_CATALOG_KIND } from './appearance-preset-catalog.ts';
import { writeCountOf } from '../read-data/write-count.ts';

const textEncoder = new TextEncoder();

/** The per-record published-record address family for user-saved looks. The catalog READ matches by
 *  `payload.kind` (not address), so the address only needs to be unique+stable per saved look. */
export const APPEARANCE_PRESET_ADDRESS_PREFIX = 'package::group::published-record::appearance-preset::';

/** kebab-case a look name for a readable, stable address segment (empty → 'look'). */
function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'look';
}

/** One prebuilt live write: a published-record address + path + payload. */
export interface AppearancePresetWriteItem {
  readonly address: string;
  readonly path: readonly string[];
  readonly payload: unknown;
}

/**
 * Build the live-write item for a saved look. The payload is a one-preset
 * `appearance-preset-catalog` record — the EXACT shape `readAppearancePresetCatalog` merges
 * (`{kind, presets:[…]}`), so a written look round-trips into the picker with no other change.
 */
export function buildAppearancePresetWriteItem(preset: AppearancePreset): AppearancePresetWriteItem {
  return {
    address: `${APPEARANCE_PRESET_ADDRESS_PREFIX}${slugify(preset.name)}-${preset.id}`,
    path: ['current-item', 'published-record'],
    payload: { kind: APPEARANCE_PRESET_CATALOG_KIND, presets: [preset] },
  };
}

export type BitfieldRequestSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

/**
 * Persist a captured board look to the live log. Returns the written address on success; throws
 * when the engine rejects the single write (so the caller can show an error notice).
 */
export async function writeAppearancePresetLive(
  preset: AppearancePreset,
  partitionLabel: string,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<string> {
  const item = buildAppearancePresetWriteItem(preset);
  const reply = await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel: item.address,
    pathLabels: [...item.path],
    payloadBytes: textEncoder.encode(JSON.stringify(item.payload)),
  }]) as { target: string; payload: unknown });
  if (writeCountOf(reply) !== 1) {
    throw new Error('This look could not be saved.');
  }
  return item.address;
}

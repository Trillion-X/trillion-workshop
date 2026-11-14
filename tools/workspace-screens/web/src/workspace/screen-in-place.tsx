// src/workspace/screen-in-place.tsx
//
// PURPOSE
//   One of the page's screens drawn in place inside another screen, mounted the way every pane mounts a screen (the
//   page's screen runner, by the screen's entry), so the screen that holds it never loads the other screen's code. The
//   held thing on the waiting screen draws the place it is done in this way (its `does_in`), and a guide step draws its
//   own screen under it (Get started's notification settings, AI setup and Automations while the setup gate is locked).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: an address or an entry comes in, a mounted screen goes out; nothing here names a screen.
//   2. An address that opens none of the page's screens draws nothing (null), never a guess.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { SourceBytesScreenMount } from '../../parts/ui/show/source-bytes-screen-mount';
import { placeOfAddress } from './addresses.mjs';
import surfaces from './screens.mjs';

const entryLabel = (entry: string) => `package::${String(surfaces.address_label).split('::').at(-1)}::entry-bytes::${entry}`;

/** A screen by its entry, shown in place with the given input. */
export function PlaceInPlace({ entry, input, placeKey, className, onChanged }: { entry: string; input: Record<string, unknown>; placeKey: string; className: string; onChanged?: () => void }) {
  const latestChanged = React.useRef(onChanged);
  latestChanged.current = onChanged;
  const changed = React.useCallback(() => latestChanged.current?.(), []);
  return (
    <SourceBytesScreenMount className={className} sourceBytes={{ address_label: entryLabel(entry) }} sourceKey={placeKey} mountProps={{ surfaceInput: input, inPlace: true, onChanged: changed }} />
  );
}

/** The screen an address of this page opens, narrowed to what the address names and shown in place; null when the
 *  address opens none of the page's screens. */
export function ScreenInPlace({ address, className, onChanged }: { address: string; className: string; onChanged?: () => void }) {
  const place = placeOfAddress(surfaces.surfaces, address, location.origin) as { row: { package_entry?: { entry_name?: string } }; input: Record<string, unknown> } | null;
  const entry = place?.row.package_entry?.entry_name;
  if (!place || !entry) return null;
  return <PlaceInPlace className={className} entry={entry} input={place.input} placeKey={`in-place:${address}`} onChanged={onChanged} />;
}

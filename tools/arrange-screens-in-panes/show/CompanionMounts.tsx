// packages/screen-arrangement/show/CompanionMounts.tsx
//
// Generic headless co-mount of N companion surfaces. Given a DATA list of package
// entry references, mount each one's ENTRY BYTES via the shared SourceBytesScreenMount
// runtime — for its on-mount EFFECT, not its visuals. A companion surface renders
// nothing (e.g. a traffic-capture beacon, a measurement beacon, a consent init); this
// host mounts it so its effect runs while the page shows its primary surface.
//
// Generic + agnostic: names no package, no app, no domain. Companions are
// PackageEntryReference DATA (the same shape ComponentMaterialSurface mounts), supplied
// by the caller (typically from a route plan). Any app's boot/entry component composes
// this with its own companion list — adding/removing a companion is a DATA change.
//
// Headless by construction: SourceBytesScreenMount is given empty status text and the
// companion renders nothing, so the mounts contribute no visible content — only their
// on-mount effects run (effects fire regardless of visibility). This is the headless
// sibling of ComponentMaterialSurface (which mounts ONE visible surface).

'use client';

import React from 'react';
import { lazyPart } from '../../ui/show/load-later/later';
// The mount that runs a companion's entry bytes is fetched with the first companion, after the page draws.
const SourceBytesScreenMount = lazyPart(() => import('../../ui/show/source-bytes-screen-mount'), module => module.SourceBytesScreenMount);
import { packageEntryBytesAddressLabel } from '../../ui/show/placeable-surface-host';
import type { PackageEntryReference } from '../read-data/layout-types';

/** Mount one companion entry's bytes (headless).
 *
 *  Mounts by LIVE-SOURCE POINTER (`{ address_label }`), NOT by resolving the bytes
 *  inline. A companion bundle routinely exceeds SourceBytesScreenMount's 1MB inline
 *  transfer limit (for example the ~1.27MB supabase-sign-in magic-link COMPLETION
 *  companion, or the ~1.29MB traffic-capture beacon). Passing a resolved Uint8Array
 *  over that limit is REJECTED ("caller must pass a live-source pointer"), so the
 *  companion never mounts and its on-mount effect never runs. That is the exact cause
 *  of the magic-link login LOOP: the completion companion could not mount, so the
 *  token was never exchanged. The pointer path is size-agnostic (the painter streams
 *  the bytes from CAS by address) and avoids loading a headless companion's full bytes
 *  into the React tree. Same by-address seam the visible primary surface uses through
 *  ComponentMaterialSurface and PlaceableSurfaceHost. */
function CompanionMount({ entry }: { entry: PackageEntryReference }): React.ReactElement {
  const addressLabel = React.useMemo(
    () => packageEntryBytesAddressLabel(entry.packageName, entry.entryName),
    [entry.packageName, entry.entryName],
  );
  const sourcePointer = React.useMemo(
    () => ({ address_label: addressLabel }),
    [addressLabel],
  );
  return (
    <React.Suspense fallback={null}>
    <SourceBytesScreenMount
      sourceBytes={sourcePointer}
      sourceKey={addressLabel}
      loadingText=""
      unavailableText=""
      runtimeUnavailableText=""
      dataAttributes={{
        companionMount: 'true',
        packageName: entry.packageName,
        packageEntryName: entry.entryName,
      }}
    />
    </React.Suspense>
  );
}

/** Mount every companion in the list (headless). Renders null when there are none. */
export function CompanionMounts({
  companions,
}: {
  companions: readonly PackageEntryReference[];
}): React.ReactElement | null {
  if (!companions || companions.length === 0) return null;
  return (
    <>
      {companions.map((c) => (
        <CompanionMount key={`${c.packageName} ${c.entryName}`} entry={c} />
      ))}
    </>
  );
}

// packages/ui/show/placeable-surface-host/PlaceableSurfaceHost.tsx

'use client';

import React from 'react';
import { later } from '../load-later/later';

// A side screen's mount arrives when the first one is placed, not with the page (../load-later/later.ts).
const SourceBytesScreenMount = later(() => import('../source-bytes-screen-mount/SourceBytesScreenMount'), module => module.SourceBytesScreenMount);

export function packageEntryBytesAddressLabel(packageName: string, entryName: string): string {
  return `package::${packageName}::entry-bytes::${entryName}`;
}

/** Warm one entry program through the page-owned painter. Idempotent at the
 * runtime owner: repeated calls join the same address resolution and the same
 * content-identity module derivation. Best effort: a cold open still works. */
export function prewarmPackageEntryBytes(
  packageName: string,
  entryName: string,
): void {
  if (typeof window === 'undefined') return;
  const runtime = (window as unknown as {
    __THINGS_TO_PUT_ON_SCREEN__?: {
      prewarmSourceBytes?: (source: { address_label: string }) => unknown;
    };
  }).__THINGS_TO_PUT_ON_SCREEN__;
  if (runtime && typeof runtime.prewarmSourceBytes === 'function') {
    void runtime.prewarmSourceBytes({
      address_label: packageEntryBytesAddressLabel(packageName, entryName),
    });
  }
}

/** Ancestor chain of entry-bytes addresses already mounted above this host in
 *  the SAME React tree. Cheap same-root cycle path. */
const MountChainContext = React.createContext<readonly string[]>([]);

/** Cross-root cycle probe: the painter mounts each embedded surface as its own
 *  module mount (separate React root), so context cannot see through an embed
 *  boundary — but the DOM can. Every mount stamps
 *  `data-package-entry-address-label`; an ANCESTOR element already carrying
 *  this host's address = a mount cycle at any depth (a board embedding itself
 *  through any chain of embeds). Identity match only — unrelated deep nesting
 *  is untouched. */
function ancestorHasCycleIdentity(el: HTMLElement, cycleIdentity: string): boolean {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(cycleIdentity)
      : cycleIdentity.replace(/["\\]/g, '\\$&');
  return Boolean(el.parentElement?.closest(`[data-placeable-surface-cycle-identity="${escaped}"]`));
}

export function canonicalInvocationInputIdentity(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalInvocationInputIdentity).join(',')}]`;
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalInvocationInputIdentity(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export interface PlaceableSurfaceHostProps {
  readonly packageName: string;
  readonly entryName: string;
  readonly target?: string | null;
  readonly materialTarget?: string | null;
  readonly surfaceInput?: Record<string, unknown>;
  readonly fill?: boolean;
  readonly interactive?: boolean;
  readonly unavailableText?: string;
  readonly runtimeUnavailableText?: string;
}

export function PlaceableSurfaceHost({
  packageName,
  entryName,
  target = null,
  materialTarget = null,
  surfaceInput,
  fill = false,
  interactive = true,
  unavailableText = "This isn't available right now.",
  runtimeUnavailableText = "This can't be shown here.",
}: PlaceableSurfaceHostProps) {
  const mountClassName =
    [fill ? 'h-full min-h-0 w-full overflow-y-auto overscroll-contain' : '', interactive ? '' : 'pointer-events-none']
      .filter(Boolean)
      .join(' ') || undefined;
  const addressLabel = React.useMemo(
    () => packageEntryBytesAddressLabel(packageName, entryName),
    [packageName, entryName],
  );
  const cycleIdentity = React.useMemo(
    () => `${addressLabel}::${canonicalInvocationInputIdentity(surfaceInput ?? {})}`,
    [addressLabel, surfaceInput],
  );
  // Deliver a live-source POINTER, not the program bytes. The painter resolves
  // this address against the stone and subscribes to it directly — fetching the
  // program by content identity from CAS (/cas/<content_hash>) instead of
  // shipping the multi-MB payload through the data path on every open. Liveness
  // is unchanged: the painter re-materializes on each byte delta at this address.
  // (Single-app runtime → the label reads on the runner's default partition,
  // the same partition the data path used.)
  const sourceBytes = React.useMemo(
    () => ({ address_label: addressLabel }),
    [addressLabel],
  );
  const frameMode = React.useMemo(() => {
    const fit = surfaceInput?.frame_fit;
    if (fit === 'fill' || fit === 'fixed') return fit;
    return fill ? 'fill' : 'inline';
  }, [fill, surfaceInput]);
  const mountProps = React.useMemo(
    () => ({ floating_frame: { mode: frameMode }, materialTarget, surfaceInput: surfaceInput ?? {}, target }),
    [frameMode, materialTarget, surfaceInput, target],
  );
  const mountChain = React.useContext(MountChainContext);
  const childChain = React.useMemo(() => [...mountChain, cycleIdentity], [mountChain, cycleIdentity]);
  const probeRef = React.useRef<HTMLDivElement | null>(null);
  // null = not probed yet (first paint); DOM ancestors are only knowable post-mount.
  const [domCycle, setDomCycle] = React.useState<boolean | null>(null);
  React.useLayoutEffect(() => {
    const el = probeRef.current;
    if (el) setDomCycle(ancestorHasCycleIdentity(el, cycleIdentity));
  }, [cycleIdentity]);

  const sameRootCycle = mountChain.includes(cycleIdentity);
  if (sameRootCycle || domCycle === true) {
    return (
      <div
        data-placeable-surface-cycle={cycleIdentity}
        className="flex h-full w-full items-center justify-center text-xs opacity-60"
      >
        {`↻ ${packageName} · ${entryName}`}
      </div>
    );
  }
  // Probe pass: render only the marker until the ancestor check resolves —
  // prevents even one recursive frame from mounting.
  if (domCycle === null) {
    return <div ref={probeRef} data-placeable-surface-probe={addressLabel} />;
  }

  return (
    <MountChainContext.Provider value={childChain}>
    <SourceBytesScreenMount
      sourceBytes={sourceBytes}
      sourceKey={addressLabel}
      className={mountClassName}
      mountProps={mountProps}
      surfaceDataAttributes={{ screenArrangementMaterialScrollViewport: 'true' }}
      dataAttributes={{
        packageName,
        packageEntryName: entryName,
        packageEntryAddressLabel: addressLabel,
        placeableSurfaceCycleIdentity: cycleIdentity,
        placeableSurfaceMount: 'true',
      }}
      unavailableText={unavailableText}
      runtimeUnavailableText={runtimeUnavailableText}
    />
    </MountChainContext.Provider>
  );
}

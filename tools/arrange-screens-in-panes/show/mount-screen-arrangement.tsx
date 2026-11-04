// packages/screen-arrangement/show/mount-screen-arrangement.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Composition Engine mount adapter for component:screen-arrangement.
// This file receives owner material as a raw DOM element and delegates only
// React root lifecycle to the pure browser-local mount primitive. It mounts only
// the screen-arrangement owner root.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No feature renderer registry
// 2. No BrowserShell import or coordination
// 3. No sidebar or producer package awareness
// 4. Screen-arrangement arranges generic surfaces only
//
// =============================================================================

import React from 'react';
import { useBitfieldData } from '#workspace-records';
import { ErrorBoundary } from '../../ui/show/error-boundary';
import { mountReactSurface } from '../../ui/show/react-surface-mount';
import {
  readVisiblePlaceableSurfaceIds,
  useBrowsingSurfacePresentationValue,
} from '../../ui/show/browsing-surface-presentation-value/browsing-surface-presentation-value';
import {
  isBrowserLocalLayoutStatePersistence,
  TOP_LEVEL_LAYOUT_STATE_PERSISTENCE,
  type LayoutStatePersistence,
} from '../do-work/save-layout-state';
import LayoutEngine from './LayoutEngine';
import { EmbeddedScreenArrangement } from './EmbeddedScreenArrangement';
import { readStarterLayouts } from '../read-data/starter-layouts';
import type { ChromeVisibilityMap } from '../read-data/chrome-visibility';
import { createBrowserLocalDestinationRef } from './surface-intent-destination-ref';
import { readSurfaceIntentReaderConfig, ViewerAccessRefsProvider } from '../../ui/show/placeable-surface-intent';
import { ArrangementHostDataContext, LayoutOwnerProviderView, type ArrangementHostData } from './screen-arrangement-context';
import { CompanionMounts } from './CompanionMounts';
import { readAlwaysMountCompanions } from '../read-data/always-mount-companions';
import { validateApplicationLayoutState } from '../read-data/application-layout-state-contribution';
import type { LayoutState } from '../read-data/layout-types';
import { provideFloatingPanelOpener } from '../../ui/show/floating-panel-opener';
import { mountFloatingPanel } from './mount-floating-panel';
import { installTouchEquivalence } from '../../ui/show/touch-equivalence/touch-equivalence';
import { bindVisibleViewport } from '../../ui/show/visible-viewport/bind-visible-viewport';
import {
  EmptyContainerSourcesContext,
  readCollectionsSource,
  readRawStartSurfaceIds,
  readStartSurfaceIds,
} from './empty-container-sources';
import type { SurfaceCollectionsSource } from '../../sidebar/show/use-surface-collections';

type MountArgs = {
  el: HTMLElement;
  props?: {
    placeableSurfaceListAddressLabel?: unknown;
    visiblePlaceableSurfaceIds?: unknown;
    applicationRef?: unknown;
    application_ref?: unknown;
    /** A layout store the embedding app owns (see readPersistence). */
    persistence?: unknown;
    persistenceMode?: unknown;
    persistence_mode?: unknown;
    initialLayoutState?: unknown;
    initial_layout_state?: unknown;
    surfaceInput?: unknown;
    surface_intent_reader?: unknown;
    surface_intent_destination_ref?: unknown;
    empty_container_surface_ids?: unknown;
    surface_collections_scope?: unknown;
    surface_collections_graph?: unknown;
    persist_collection_edits?: unknown;
    tabsOutsideCatalog?: unknown;
    catalogStateAddressLabel?: unknown;
    starterLayouts?: unknown;
  };
};

function readPlaceableSurfaceListAddressLabel(props: MountArgs['props']): string | undefined {
  return readString(props?.placeableSurfaceListAddressLabel)
    ?? readString((props?.surfaceInput as Record<string, unknown> | undefined)?.placeableSurfaceListAddressLabel)
    ?? readString((props?.surfaceInput as Record<string, unknown> | undefined)?.placeable_surface_list_address_label);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readApplicationRef(props: MountArgs['props']): string | undefined {
  const surfaceInput = props?.surfaceInput && typeof props.surfaceInput === 'object'
    ? props.surfaceInput as Record<string, unknown>
    : undefined;
  return readString(surfaceInput?.application_ref)
    ?? readString(surfaceInput?.applicationRef)
    ?? readString(props?.application_ref)
    ?? readString(props?.applicationRef)
    ?? readString(globalThis.location?.origin);
}

// Where the layout is kept. An app that owns its layout store hands it in as
// `persistence` and nothing waits on the account or the engine to paint; the
// 'shared-engine' mode keeps it in the records; otherwise the arrangement keeps
// it in this browser.
function readPersistence(props: MountArgs['props']): LayoutStatePersistence | undefined {
  const supplied = props?.persistence as LayoutStatePersistence | undefined;
  if (isBrowserLocalLayoutStatePersistence(supplied)) return supplied;
  return usesSharedEnginePersistence(props) ? TOP_LEVEL_LAYOUT_STATE_PERSISTENCE : undefined;
}

function usesSharedEnginePersistence(props: MountArgs['props']): boolean {
  const surfaceInput = props?.surfaceInput && typeof props.surfaceInput === 'object'
    ? props.surfaceInput as Record<string, unknown>
    : undefined;
  return (surfaceInput?.persistence_mode ?? surfaceInput?.persistenceMode ?? props?.persistence_mode ?? props?.persistenceMode) === 'shared-engine';
}

function readInitialLayoutState(props: MountArgs['props']): LayoutState | undefined {
  const surfaceInput = props?.surfaceInput && typeof props.surfaceInput === 'object'
    ? props.surfaceInput as Record<string, unknown>
    : undefined;
  const value = surfaceInput?.initial_layout_state ?? surfaceInput?.initialLayoutState
    ?? props?.initial_layout_state ?? props?.initialLayoutState;
  return value === undefined ? undefined : validateApplicationLayoutState(value);
}

/**
 * Read the optional always-mount-companions DATA list + headless-mount each companion
 * at the workspace ROOT. This is the GENERIC seam (L069) that gives ANY workspace app
 * cross-cutting beacons (traffic-capture, analytics, consent) via ONE DATA record —
 * zero per-app source edit. Absent/empty record → CompanionMounts renders null → the
 * root is byte-identical to before (additive, no regression for apps without the
 * record). Wrapped in its own ErrorBoundary so a malformed record can NEVER break the
 * LayoutEngine workspace.
 */
function CompanionsFromData(): React.ReactElement | null {
  // useBitfieldData THROWS if an app has not admitted the 'always-mount-companions'
  // input descriptor into its read scope. That throw MUST be caught (see the
  // ErrorBoundary wrapper below) so an app without the seam's input degrades to
  // "no companions" instead of crashing the workspace — the additive guarantee.
  const raw = useBitfieldData('always-mount-companions');
  const companions = React.useMemo(() => readAlwaysMountCompanions(raw), [raw]);
  if (companions.length === 0) return null;
  return <CompanionMounts companions={companions} />;
}

export function AlwaysMountCompanions(): React.ReactElement {
  return (
    <div
      data-screen-arrangement-companion-host
      aria-hidden="true"
      style={{
        position: 'absolute',
        width: 0,
        height: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <ErrorBoundary zoneName="screen-arrangement companions" fallback={() => null}>
        <CompanionsFromData />
      </ErrorBoundary>
    </div>
  );
}

function ScreenArrangementRoot({ applicationRef, persistence, initialLayoutState, placeableSurfaceListAddressLabel, visiblePlaceableSurfaceIds, surfaceIntentReader, surfaceIntentDestinationRef, emptyContainerSurfaceIds, surfaceCollections, hostData }: {
  applicationRef?: string;
  persistence?: LayoutStatePersistence;
  initialLayoutState?: LayoutState;
  placeableSurfaceListAddressLabel?: string;
  visiblePlaceableSurfaceIds?: unknown;
  surfaceIntentReader?: ReturnType<typeof readSurfaceIntentReaderConfig>;
  surfaceIntentDestinationRef?: string;
  /** DATA: ordered surface ids an empty pane shows (may be a presentation value). */
  emptyContainerSurfaceIds?: unknown;
  /** DATA: the lists source, the same arguments the app hands its sidebar. */
  surfaceCollections?: SurfaceCollectionsSource;
  /** DATA: what the host says about its own arrangement (screen-arrangement-context.tsx ArrangementHostData). */
  hostData: ArrangementHostData;
}) {
  const layoutEntry = useBitfieldData('layout-state')
  const resolvedStartSurfaceIds = useBrowsingSurfacePresentationValue(emptyContainerSurfaceIds)
  const startSurfaceIdsKey = JSON.stringify(readStartSurfaceIds(resolvedStartSurfaceIds))
  const emptyContainerSources = React.useMemo(() => ({
    startSurfaceIds: JSON.parse(startSurfaceIdsKey) as string[],
    collections: surfaceCollections ?? {},
  }), [startSurfaceIdsKey, surfaceCollections])
  const resolvedVisiblePlaceableSurfaceIds = useBrowsingSurfacePresentationValue(visiblePlaceableSurfaceIds)
  const visibleSurfaceIds = readVisiblePlaceableSurfaceIds(resolvedVisiblePlaceableSurfaceIds)
  const generatedDestinationRef = React.useRef<string | null>(null)
  if (!generatedDestinationRef.current) generatedDestinationRef.current = createBrowserLocalDestinationRef()
  const destinationRef = surfaceIntentDestinationRef?.trim() || generatedDestinationRef.current
  return (
    <div
      data-screen-arrangement-root
      role="main"
      aria-label="Workspace"
      style={{
        position: 'fixed',
        top: 'var(--stage-inset-top, 0px)',
        right: 'var(--stage-inset-right, 0px)',
        // Floating controls and notifications are overlays above this stage;
        // they never take its height.
        bottom: 'var(--stage-inset-bottom, 0px)',
        left: 'var(--stage-inset-left, 0px)',
        zIndex: 20,
        display: 'flex',
        width: 'auto',
        height: 'auto',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        pointerEvents: 'auto',
        transition: 'var(--stage-inset-transition, none)',
      }}
    >
      <ErrorBoundary zoneName="screen-arrangement root">
        <ViewerAccessRefsProvider>
          <LayoutOwnerProviderView
            layoutEntry={layoutEntry}
            initialState={initialLayoutState}
            applicationRef={applicationRef}
            persistence={persistence}
            placeableSurfaceListAddressLabel={placeableSurfaceListAddressLabel}
            visiblePlaceableSurfaceIds={visibleSurfaceIds}
          >
            <EmptyContainerSourcesContext.Provider value={emptyContainerSources}>
              <ArrangementHostDataContext.Provider value={hostData}>
                <LayoutEngine surfaceIntentReader={surfaceIntentReader} surfaceIntentDestinationRef={destinationRef} />
              </ArrangementHostDataContext.Provider>
            </EmptyContainerSourcesContext.Provider>
          </LayoutOwnerProviderView>
        </ViewerAccessRefsProvider>
      </ErrorBoundary>
      {/* Headless companions mount OUTSIDE the LayoutEngine ErrorBoundary on purpose:
          their on-mount EFFECTS (traffic-capture beacon, analytics, consent) must run
          even if the workspace itself fails to render. They have their own boundary. */}
      <AlwaysMountCompanions />
    </div>
  );
}

// The host's arrangement DATA from its mount props: `tabsOutsideCatalog` ('close' | 'keep', default 'keep') and
// `starterLayouts` (decoded where it is used, read-data/starter-layouts.ts).
function readArrangementHostData(props: MountArgs['props']): ArrangementHostData {
  return {
    tabsOutsideCatalog: props?.tabsOutsideCatalog === 'close' ? 'close' : 'keep',
    ...(typeof props?.catalogStateAddressLabel === 'string' && props.catalogStateAddressLabel
      ? { catalogStateAddressLabel: props.catalogStateAddressLabel } : {}),
    starterLayouts: props?.starterLayouts ?? [],
    ...(props?.stackRowsThatDoNotFit === true ? { stackRowsThatDoNotFit: true } : {}),
  };
}

export default function mount({ el, props = {} }: MountArgs) {
  // The arrangement draws the one shared floating panel; anything unpinned
  // (a sidebar list, a control group) opens through this seam.
  provideFloatingPanelOpener(mountFloatingPanel)
  // The stage works the same under a finger as under a mouse (a tap points, a long press is a right click, a double tap
  // a double click) and holds exactly the area a person can see while a phone keyboard is open. Both are page-wide and
  // install once, whichever page mounts the stage.
  installTouchEquivalence(el.ownerDocument)
  bindVisibleViewport(el.ownerDocument)
  return mountReactSurface(
    el,
    React.createElement(ScreenArrangementRoot, {
      applicationRef: readApplicationRef(props),
      persistence: readPersistence(props),
      initialLayoutState: readInitialLayoutState(props),
      placeableSurfaceListAddressLabel: readPlaceableSurfaceListAddressLabel(props),
      visiblePlaceableSurfaceIds: props.visiblePlaceableSurfaceIds,
      emptyContainerSurfaceIds: readRawStartSurfaceIds(props as Record<string, unknown>),
      surfaceCollections: readCollectionsSource(props as Record<string, unknown>),
      hostData: readArrangementHostData(props),
      surfaceIntentReader: readSurfaceIntentReaderConfig((props.surfaceInput as Record<string, unknown> | undefined)?.surface_intent_reader ?? props.surface_intent_reader),
      surfaceIntentDestinationRef: typeof ((props.surfaceInput as Record<string, unknown> | undefined)?.surface_intent_destination_ref ?? props.surface_intent_destination_ref) === 'string'
        ? String((props.surfaceInput as Record<string, unknown> | undefined)?.surface_intent_destination_ref ?? props.surface_intent_destination_ref)
        : undefined,
    }),
  );
}

/** A nested arrangement's own props beside the top level's: where it is kept, what it opens on, its chrome. */
type NestedArrangementProps = MountArgs['props'] & {
  /** The record label it is kept at, per person (a screen's own arrangement, a recording's page). */
  keptAt?: unknown;
  /** The arrangement it opens on when nothing is kept (read-data/starter-layouts.ts short shape). */
  starter?: unknown;
  /** Which chrome zones show (read-data/chrome-visibility.ts), layered over what is kept. */
  chrome?: unknown;
};

function NestedScreenArrangement({ props }: { props: NestedArrangementProps }) {
  const keptAt = typeof props.keptAt === 'string' ? props.keptAt : ''
  const resolvedStartSurfaceIds = useBrowsingSurfacePresentationValue(readRawStartSurfaceIds(props as Record<string, unknown>))
  const startSurfaceIdsKey = JSON.stringify(readStartSurfaceIds(resolvedStartSurfaceIds))
  const collections = React.useMemo(() => readCollectionsSource(props as Record<string, unknown>), [props])
  const host = React.useMemo(() => ({
    emptyContainerSources: { startSurfaceIds: JSON.parse(startSurfaceIdsKey) as string[], collections },
    hostData: readArrangementHostData(props),
  }), [startSurfaceIdsKey, collections, props])
  const [starter] = readStarterLayouts([{ id: keptAt, name: keptAt, arrangement: props.starter }])
  const label = readPlaceableSurfaceListAddressLabel(props)
  return (
    <EmbeddedScreenArrangement
      applicationRef={`nested:${keptAt}`}
      initialState={{}}
      starter={starter ?? null}
      layoutEntryInput={{ input: 'layout-state-by-address-label', params: { addressLabel: keptAt } }}
      persistence={{ valueAddressLabel: keptAt }}
      placeableSurfaceListAddressLabel={label}
      chrome={props.chrome && typeof props.chrome === 'object' ? props.chrome as ChromeVisibilityMap : undefined}
      host={host}
    />
  )
}

/**
 * The same arrangement as the top level, nested in an element (a pane's screen, a piece of a screen) and kept at its
 * own record: every pane feature at every depth. Takes the top level's mount props plus `keptAt`, `starter`, `chrome`.
 */
export function mountNestedScreenArrangement({ el, props = {} }: { el: HTMLElement; props?: NestedArrangementProps }) {
  if (typeof props.keptAt !== 'string' || !props.keptAt) throw new TypeError('A nested arrangement needs keptAt, the record it is kept at.')
  return mountReactSurface(el, <NestedScreenArrangement props={props} />)
}

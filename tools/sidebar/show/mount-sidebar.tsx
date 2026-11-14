// =============================================================================
// PURPOSE
// =============================================================================
//
// Composition Engine mount adapter for component:sidebar.
// This file receives owner material as a raw DOM element and delegates only
// React root lifecycle to the pure browser-local mount primitive. It mounts only
// the sidebar owner root.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No screen-arrangement imports
// 2. No BrowserShell import or coordination
// 3. No feature list or setup-definition registry
// 4. Sidebar may publish generic drag bytes but must not create tabs directly
//
// =============================================================================

import React from 'react';
import { ErrorBoundary, mountReactSurface } from '../../ui';
import { useBrowsingSurfacePresentationValue } from '../../ui/show/browsing-surface-presentation-value/browsing-surface-presentation-value';
import { ViewerAccessRefsProvider } from '../../ui/show/placeable-surface-intent';
import { AppSidebar, type AppSidebarProps } from './AppSidebar';
import { CONTENT_HOST_ATTRIBUTE } from './content-host';
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of';

/** The element a panel at the top of the sidebar mounts into (the app's `header_content_host`): the control
 *  `sidebar.content.<host>`, as every list's hosted panel is (AppSidebar.tsx placeContentHosts). */
function HeaderContentHost({ host }: { host: string }) {
  useShowChange();
  return controlShown(`sidebar.content.${host}`) ? <div {...{ [CONTENT_HOST_ATTRIBUTE]: host }} /> : null;
}
import { readSidebarSettings, type SidebarSettings } from '../read-data/sidebar-settings';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function readScope(props: Record<string, unknown>): string | undefined {
  const surfaceInput = props.surfaceInput;
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return undefined;
  const scope = (surfaceInput as Record<string, unknown>).scope;
  return typeof scope === 'string' && scope.length > 0 ? scope : undefined;
}

function readBooleanSurfaceInputField(props: Record<string, unknown>, field: string): boolean | undefined {
  const surfaceInput = props.surfaceInput;
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return undefined;
  const value = (surfaceInput as Record<string, unknown>)[field];
  return typeof value === 'boolean' ? value : undefined;
}

function readDestinationRef(props: Record<string, unknown>): string | undefined {
  const surfaceInput = props.surfaceInput;
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return undefined;
  const value = (surfaceInput as Record<string, unknown>).surface_intent_destination_ref;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPlaceableSurfaceListAddressLabel(props: Record<string, unknown>): unknown {
  const surfaceInput = props.surfaceInput;
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return undefined;
  return (surfaceInput as Record<string, unknown>).placeable_surface_list_address_label;
}

function readVisiblePlaceableSurfaceIdsValue(props: Record<string, unknown>): unknown {
  const surfaceInput = props.surfaceInput;
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return undefined;
  return (surfaceInput as Record<string, unknown>).visible_placeable_surface_ids;
}

function readPartitionLabel(props: Record<string, unknown>): string | undefined {
  const surfaceInput = props.surfaceInput;
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return undefined;
  const value = (surfaceInput as Record<string, unknown>).partition_label;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSurfaceCollectionsGraph(props: Record<string, unknown>): unknown {
  const surfaceInput = props.surfaceInput;
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return undefined;
  return (surfaceInput as Record<string, unknown>).surface_collections_graph;
}

function readSidebarSettingsInput(props: Record<string, unknown>) {
  const surfaceInput = props.surfaceInput;
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return undefined;
  return readSidebarSettings((surfaceInput as Record<string, unknown>).sidebar_settings);
}

function SidebarRoot({
  scope,
  showCollectionManager,
  persistCollectionEdits,
  surfaceIntentDestinationRef,
  placeableSurfaceListAddressLabel,
  visiblePlaceableSurfaceIds,
  knownPlaceableSurfaces,
  partitionLabel,
  surfaceCollectionsGraph,
  sidebarSettings,
  instanceId,
  capabilities,
  sections,
  arrangementNavigatorHost,
  headerContentHost,
  contentHostBySectionId,
  sceneMountToken,
}: {
  scope?: string;
  showCollectionManager?: boolean;
  persistCollectionEdits?: boolean;
  surfaceIntentDestinationRef?: string;
  placeableSurfaceListAddressLabel?: unknown;
  visiblePlaceableSurfaceIds?: unknown;
  knownPlaceableSurfaces?: unknown;
  partitionLabel?: string;
  surfaceCollectionsGraph?: unknown;
  sidebarSettings?: SidebarSettings;
  instanceId?: string;
  capabilities?: AppSidebarProps['capabilities'];
  sections?: AppSidebarProps['sections'];
  arrangementNavigatorHost?: boolean;
  /** A shared panel the app fills at the top of the rail, above every list (a workspace switcher). */
  headerContentHost?: string;
  contentHostBySectionId?: AppSidebarProps['contentHostBySectionId'];
  sceneMountToken?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const contained = Boolean(instanceId);
  const resolvedPlaceableSurfaceListAddressLabel = useBrowsingSurfacePresentationValue(placeableSurfaceListAddressLabel);
  const catalogAddressLabel = typeof resolvedPlaceableSurfaceListAddressLabel === 'string'
    && resolvedPlaceableSurfaceListAddressLabel.trim().length > 0
    ? resolvedPlaceableSurfaceListAddressLabel.trim()
    : undefined;
  // Same DATA seam as the catalog address above: the value says which surfaces
  // this browsing surface offers, and an app that says nothing offers all.
  const resolvedVisiblePlaceableSurfaceIds = useBrowsingSurfacePresentationValue(visiblePlaceableSurfaceIds);
  return (
    <div
      ref={containerRef}
      data-sidebar-root
      style={contained ? {
        position: 'relative', width: '100%', height: '100%', overflow: 'hidden',
      } : {
        position: 'static',
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
    >
      <style>
        {'[data-sidebar-root] aside,[data-sidebar-root] button,[data-sidebar-root] [role="button"]{pointer-events:auto;}'}
      </style>
      <ErrorBoundary zoneName="sidebar root">
        {/*
          Who is looking decides which surfaces are OFFERED here. The provider
          reads it from DATA and resolves to "nobody said" when the app does not
          declare it, which leaves every surface offered and is what every app
          without the declaration does today.

          It is mounted HERE rather than inherited, because the sidebar is the
          rail: it mounts at the app root, outside the arrangement that carries
          this context for every other catalog reader. Relying on inheritance
          would have left the gate reading "nobody said" forever, which is the
          failure that stays invisible, since an unrestricted catalog looks
          exactly like a working one.
        */}
        <ViewerAccessRefsProvider>
        <AppSidebar
          instanceId={instanceId}
          containerRef={contained ? containerRef : undefined}
          presentation={contained ? 'embedded' : 'app-rail'}
          capabilities={capabilities}
          sections={sections}
          contentHostBySectionId={contentHostBySectionId}
          headerContent={arrangementNavigatorHost || headerContentHost ? (
            <>
              {headerContentHost ? <HeaderContentHost host={headerContentHost} /> : null}
              {arrangementNavigatorHost ? <div data-arrangement-navigator-host /> : null}
            </>
          ) : undefined}
          scope={scope}
          showCollectionManager={showCollectionManager}
          persistCollectionEdits={persistCollectionEdits}
          surfaceIntentDestinationRef={surfaceIntentDestinationRef}
          placeableSurfaceListAddressLabel={catalogAddressLabel}
          visiblePlaceableSurfaceIds={
            Array.isArray(resolvedVisiblePlaceableSurfaceIds)
              ? resolvedVisiblePlaceableSurfaceIds as readonly string[]
              : null
          }
          knownPlaceableSurfaces={knownPlaceableSurfaces}
          partitionLabel={partitionLabel}
          surfaceCollectionsGraph={surfaceCollectionsGraph}
          sidebarSettings={sidebarSettings}
          sceneMountToken={sceneMountToken}
        />
        </ViewerAccessRefsProvider>
      </ErrorBoundary>
    </div>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  const input = props.surfaceInput && typeof props.surfaceInput === 'object' && !Array.isArray(props.surfaceInput)
    ? props.surfaceInput as Record<string, unknown> : {};
  const instanceId = typeof input.surface_instance_ref === 'string' && input.surface_instance_ref.length > 0
    ? input.surface_instance_ref : undefined;
  const capabilities = input.sidebar_capabilities && typeof input.sidebar_capabilities === 'object' && !Array.isArray(input.sidebar_capabilities)
    ? input.sidebar_capabilities as AppSidebarProps['capabilities'] : undefined;
  return mountReactSurface(el, React.createElement(SidebarRoot, {
    sceneMountToken: el.dataset.bitfieldSceneMountToken,
    instanceId,
    capabilities,
    sections: Array.isArray(input.sections) ? input.sections as AppSidebarProps['sections'] : undefined,
    arrangementNavigatorHost: input.arrangement_navigator_host === true,
    headerContentHost: typeof input.header_content_host === 'string' && input.header_content_host ? input.header_content_host : undefined,
    contentHostBySectionId: input.content_host_by_section_id && typeof input.content_host_by_section_id === 'object' && !Array.isArray(input.content_host_by_section_id)
      ? Object.fromEntries(Object.entries(input.content_host_by_section_id as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined,
    scope: readScope(props),
    showCollectionManager: readBooleanSurfaceInputField(props, 'hide_collection_manager') === true
      ? false
      : undefined,
    persistCollectionEdits: readBooleanSurfaceInputField(props, 'persist_collection_edits') === true,
    surfaceIntentDestinationRef: readDestinationRef(props),
    placeableSurfaceListAddressLabel: readPlaceableSurfaceListAddressLabel(props),
    visiblePlaceableSurfaceIds: readVisiblePlaceableSurfaceIdsValue(props),
    partitionLabel: readPartitionLabel(props),
    surfaceCollectionsGraph: readSurfaceCollectionsGraph(props),
    sidebarSettings: readSidebarSettingsInput(props),
    // The records the app publishes to its catalog address: the rail paints
    // from them until the catalog read answers.
    knownPlaceableSurfaces: input.placeable_surfaces,
  }));
}

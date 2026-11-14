// packages/screen-arrangement/show/EmptyContainer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// What a pane shows when nothing is open in it. Two parts, both chosen by DATA:
//
//   • A start screen: the app names placeable surfaces in
//     `empty_container_surface_ids` (see empty-container-sources.ts). The first
//     one in the catalog and not already on screen is mounted here through the
//     same ComponentMaterialSurface mount a pane uses. No names → no start screen.
//   • The quick-open launcher: search, the Layouts picker (LayoutPicker, the
//     same thumbnails the sidebar shows, with its "Name this layout" field to
//     save the arrangement on screen), the person's lists (the
//     sidebar's own list tree, read by the sidebar's `useSurfaceCollections`),
//     and everything this app can open. With a start screen it sits behind a
//     search field and one "Browse everything" button above it.
//
// Every section is a control the person's show rules decide (parts/ui/show/show-rules show-of.ts controlShown), declared
// in this part's controls.json under `arrangement.empty`: the heading, the search, the layouts, the folders (and making one), each "Open as" choice,
// everything this app can open, the screens kept at the foot, and the start screen. One rule on `arrangement.empty`
// holds for all of them; a rule on one holds for it alone.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Names no surface, package or app; what shows is DATA.
// 2. The lists are the sidebar's lists: same hook, same source arguments.
// 3. Every section of the launcher spans the same full-width column.
// 4. A failed read says so and offers Try again; it never reads as "none yet".
//
// =============================================================================

'use client';

import React, { startTransition, useDeferredValue } from 'react';
import { Button } from '../../ui/show/button';
import { Container } from '../../ui/show/container';
import { DisclosureSection } from '../../ui/show/disclosure-section/DisclosureSection';
import { NamedIcon } from '../../ui/show/icon';
import { Input } from '../../ui/show/input';
import { NameAndCreate } from '../../ui/show/name-and-create';
import { PickerTile } from '../../ui/show/picker-tile/PickerTile';
import { Text } from '../../ui/show/text';
import {
  type PlaceableSurfaceRecord,
} from '../read-data/read-published-records';
import { readInitialArrangementState } from '../read-data/read-initial-arrangement';
import {
  LayoutActionsContext,
  LayoutStateContext,
  PlaceableSurfaceListAddressContext,
  VisiblePlaceableSurfaceIdsContext,
} from './screen-arrangement-context';
import { filterByVisiblePlaceableSurfaceIds } from '../../ui/show/browsing-surface-presentation-value/browsing-surface-presentation-value';
import { tabForPlaceableSurface, tabShowsPlaceableSurface, tabWithId } from 'trillion-workshop/tools/arrange-screens-in-panes/show/placeable-surface-tab.ts';
import { packageEntryBytesAddressLabel } from '../../ui/show/placeable-surface-host';
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { listsPresentHere } from '../read-data/read-tab-collections';
import { SurfaceFolderTile } from './SurfaceFolderTile';
import { LayoutPicker } from './LayoutPicker';
import { openIntentCatalogRef, readOpenIntentRows, type OpenIntentRow } from '../read-data/read-open-intents';
import { createSurfaceCollection } from '../../sidebar/do-work/edit-surface-collections';
import { partitionLabelForSurfaceList, useSurfaceCollections } from '../../sidebar/show/use-surface-collections';
import { ComponentMaterialSurface } from './ComponentMaterialSurface';
import { EmptyContainerSourcesContext, useStartSurfaceForEmptyTab } from './empty-container-sources';
import { controlShown, showListed, useShowChange } from '../../ui/show/show-rules/show-of';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
// The places (surface DATA `sidebar_place`) whose screens stick to the bottom of an empty pane, as the sidebar keeps
// them at its foot (parts/sidebar/show/AppSidebar.tsx PLACES).
const STICKS_TO_BOTTOM = new Set(['bottom']);

function newCollectionId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Warm a surface's program the moment the pointer enters its picker tile — well
// before the click. The painter resolves + compiles the entry (and runs its
// read-scope seed) once, so the click that follows pays only the mount (sub-1ms).
// Hover is user-intent-driven and one-at-a-time, so this never floods the
// transport the way eagerly warming every tile would. Best-effort + idempotent.
function prewarmPlaceableSurface(surface: PlaceableSurfaceRecord): void {
  const packageName = surface.packageEntry?.packageName;
  const entryName = surface.packageEntry?.entryName;
  if (!packageName || !entryName || typeof window === 'undefined') return;
  const runtime = (window as unknown as {
    __THINGS_TO_PUT_ON_SCREEN__?: { prewarmSourceBytes?: (s: { address_label: string }) => unknown };
  }).__THINGS_TO_PUT_ON_SCREEN__;
  if (runtime && typeof runtime.prewarmSourceBytes === 'function') {
    void runtime.prewarmSourceBytes({ address_label: packageEntryBytesAddressLabel(packageName, entryName) });
  }
}

function surfaceMatches(surface: PlaceableSurfaceRecord, query: string): boolean {
  if (!query) return true;
  const haystack = [
    surface.label,
    // The surface's own id is part of its self-description — searching by any
    // token the DATA carries must find it (visual-database.table.budget matches
    // "table"); label-only search hid every aliased surface family.
    surface.id,
    surface.materialTarget,
    surface.packageEntry?.packageName,
    surface.packageEntry?.entryName,
    surface.badge,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

export function EmptyContainer({
  containerId,
  tabId = null,
  shown = true,
  placeableSurfaces,
}: {
  containerId: string;
  /** The empty tab this pane draws, when it draws one. */
  tabId?: string | null;
  /** Whether this pane is on screen. A hidden empty tab never takes a start
   * screen, so it cannot keep one from the pane a person is looking at. */
  shown?: boolean;
  placeableSurfaces: readonly PlaceableSurfaceRecord[];
}) {
  const layoutState = React.useContext(LayoutStateContext);
  const layoutActions = React.useContext(LayoutActionsContext);
  const showRevision = useShowChange();
  const shows = (part: string) => controlShown(`arrangement.empty.${part}`);
  const sources = React.useContext(EmptyContainerSourcesContext);
  const surfaceListAddress = React.useContext(PlaceableSurfaceListAddressContext);
  const [query, setQuery] = React.useState('');
  const [browsing, setBrowsing] = React.useState(false);
  // Open-intent rows, folded through the group door. Layouts are the shared LayoutPicker's own read.
  const [openIntents, setOpenIntents] = React.useState<OpenIntentRow[]>([]);
  const [intentsLoadError, setIntentsLoadError] = React.useState<string | null>(null);
  const [intentsReload, setIntentsReload] = React.useState(0);
  // The person's lists: the sidebar's own reader over the sidebar's own source.
  const lists = useSurfaceCollections({
    ...sources.collections,
    partitionLabel: sources.collections.partitionLabel ?? partitionLabelForSurfaceList(surfaceListAddress),
  });
  const [openFolderId, setOpenFolderId] = React.useState<string | null>(null);
  const [folderName, setFolderName] = React.useState('');
  const [creatingCollection, setCreatingCollection] = React.useState(false);
  const [collectionActionError, setCollectionActionError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setIntentsLoadError(null);
    void sendRequestToBitfieldTarget({
      target: 'group.load-graph',
      payload: { roots: [openIntentCatalogRef()] },
    }).then((reply) => {
      if (cancelled) return;
      setOpenIntents(readOpenIntentRows(reply));
    }).catch((error) => {
      if (cancelled) return;
      setIntentsLoadError(errorWords(error));
    });
    return () => {
      cancelled = true;
    };
  }, [intentsReload]);
  const refreshLists = lists.refresh;
  const retryReads = React.useCallback(() => {
    setIntentsReload((value) => value + 1);
    void refreshLists();
  }, [refreshLists]);

  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  // This is the picker, so the presentation's allowlist applies HERE and only
  // here. It decides what someone is offered; it never decides whether a pane
  // they already have open can still be drawn.
  const visiblePlaceableSurfaceIds = React.useContext(VisiblePlaceableSurfaceIdsContext);
  const surfaces = React.useMemo(
    () => filterByVisiblePlaceableSurfaceIds(
      placeableSurfaces.filter((surface) => !surface.disabled && showListed('screen', surface.payload as Record<string, unknown>)),
      visiblePlaceableSurfaceIds,
    ),
    [placeableSurfaces, visiblePlaceableSurfaceIds, showRevision],
  );
  // A screen kept out of lists (`listed: false`: a part of another screen, such as one of Home's) is not offered until
  // it is searched for, so any part of any screen can be placed in any pane.
  const visibleSurfaces = React.useMemo(
    () => surfaces.filter((surface) => (normalizedQuery ? surfaceMatches(surface, normalizedQuery) : surface.listed !== false)),
    [normalizedQuery, surfaces],
  );
  // A screen whose DATA keeps it in a place of its own (`sidebar_place`, as the sidebar keeps it) stays in reach
  // here too: held in a strip that sticks to the bottom of the pane while the rest scrolls.
  const keptSurfaces = shows('kept') ? visibleSurfaces.filter((surface) => surface.sidebarPlace && STICKS_TO_BOTTOM.has(surface.sidebarPlace)) : [];
  const listedSurfaces = visibleSurfaces.filter((surface) => !(surface.sidebarPlace && STICKS_TO_BOTTOM.has(surface.sidebarPlace)));

  // The start screen: the DATA-named surfaces in order, skipping any the
  // catalog lacks and any already open in a tab (a screen is in one place).
  const startCandidates = React.useMemo(() => {
    const openTabs = Object.values(layoutState?.tabs ?? {});
    return sources.startSurfaceIds.filter((id) => {
      const surface = placeableSurfaces.find((candidate) => candidate.id === id);
      if (!surface?.packageEntry || surface.disabled) return false;
      return !openTabs.some((tab) => tabShowsPlaceableSurface(tab, surface));
    });
  }, [layoutState?.tabs, placeableSurfaces, sources.startSurfaceIds]);
  const startSurfaceId = useStartSurfaceForEmptyTab(containerId, tabId, shown && shows('start'), startCandidates);
  const startSurface = React.useMemo(
    () => (startSurfaceId ? placeableSurfaces.find((surface) => surface.id === startSurfaceId) ?? null : null),
    [placeableSurfaces, startSurfaceId],
  );
  const startEntry = startSurface?.packageEntry ?? null;
  const showStart = Boolean(startEntry) && !browsing && normalizedQuery.length === 0;

  const activeTabId = React.useMemo(() => {
    const container = layoutState?.containers[containerId];
    if (!container) return null;
    return layoutState?.tabGroups[container.groupId]?.activeTabId ?? null;
  }, [containerId, layoutState]);

  const placeSurface = React.useCallback((surface: PlaceableSurfaceRecord) => {
    if (!layoutActions) return;
    const initialArrangement = readInitialArrangementState(surface);
    if (initialArrangement) {
      layoutActions.applyLayoutState(initialArrangement);
      return;
    }
    const tab = tabForPlaceableSurface(surface);
    if (activeTabId) {
      layoutActions.addSurfaceTab(containerId, tabWithId(tab, activeTabId));
      return;
    }
    layoutActions.addSurfaceTab(containerId, tab);
  }, [activeTabId, containerId, layoutActions]);

  const createFolder = React.useCallback(async () => {
    const name = folderName.trim();
    if (!name) return;
    setCreatingCollection(true);
    setCollectionActionError(null);
    try {
      await createSurfaceCollection(newCollectionId('list'), name, sources.collections.scope);
      setFolderName('');
      await refreshLists();
    } catch (error) {
      setCollectionActionError(errorWords(error));
    } finally {
      setCreatingCollection(false);
    }
  }, [folderName, refreshLists, sources.collections.scope]);

  const surfacesById = React.useMemo(
    () => new Map(surfaces.map((surface) => [surface.id, surface])),
    [surfaces],
  );
  const folders = React.useMemo(
    () => listsPresentHere(lists.collections, surfacesById),
    [lists.collections, surfacesById],
  );
  // The folder an empty pane leads with (its list's DATA `leads_where_empty`: the pursuit the workspace is about) starts
  // open, so its rows are offered at once.
  const leadFolderId = folders.find((folder) => folder.meta?.leads_where_empty === true)?.id ?? null;
  const [leadOpened, setLeadOpened] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (leadFolderId && leadOpened !== leadFolderId) { setLeadOpened(leadFolderId); setOpenFolderId(leadFolderId); }
  }, [leadFolderId, leadOpened]);
  const listsLoading = lists.loading && folders.length === 0;
  const listsUnavailable = Boolean(lists.error) && folders.length === 0;
  const readFailed = Boolean(intentsLoadError) || listsUnavailable;
  const showCollections = normalizedQuery.length === 0 && shows('folders');
  const showEverything = shows('everything');
  const showSearch = shows('search');
  const shownIntents = openIntents.filter((intent) => controlShown(`arrangement.empty.open-as.${intent.id}`));

  const search = !showSearch ? null : (
    <Container flex={1} padding="none">
      <Input
        type="search"
        value={query}
        onChange={(event) => {
          const value = event.currentTarget.value;
          startTransition(() => setQuery(value));
        }}
        placeholder="Search things"
        aria-label="Search things"
        data-reach-role="picker-search-input"
        icon={<NamedIcon name="Search" size="sm" />}
      />
    </Container>
  );

  const launcher = (
    <Container layout="vertical" gap="xl" padding="none" width="full">
      {readFailed ? (
        <Container layout="horizontal" gap="md" padding="md" alignItems="center" justifyContent="between" border="all" rounded="lg" role="alert">
          <Text variant="body" color="primary">Folders couldn&apos;t load.</Text>
          <Button type="button" variant="ghost" onClick={retryReads}>
            Try again
          </Button>
        </Container>
      ) : null}
      {normalizedQuery.length === 0 && shows('layouts') ? (
        <DisclosureSection title="Layouts" divider={false}>
          <LayoutPicker />
        </DisclosureSection>
      ) : null}
      {showCollections ? (
        <>
          <DisclosureSection title="Folders" divider={false}>
            {listsLoading ? (
              <Text variant="body-xs" color="secondary" role="status">Loading folders…</Text>
            ) : listsUnavailable ? (
              <Text variant="body-xs" color="secondary">Folders are unavailable.</Text>
            ) : folders.length > 0 ? (
              <Container layout="grid" gap="sm" padding="none" gridCols="auto-fill-xs" width="full">
                {folders.map((folder) => (
                  <SurfaceFolderTile
                    key={folder.id}
                    folder={folder}
                    surfacesById={surfacesById}
                    open={openFolderId === folder.id}
                    onToggle={() => setOpenFolderId((current) => (current === folder.id ? null : folder.id))}
                    onPickSurface={placeSurface}
                    openIntents={shownIntents}
                    layoutActions={layoutActions}
                    containerId={containerId}
                    emptyTabId={activeTabId}
                  />
                ))}
              </Container>
            ) : (
              <Container layout="vertical" gap="sm" padding="none" width="full">
                <Text variant="body-xs" color="secondary">No folders yet.</Text>
                {shows('folders.create') ? <NameAndCreate
                  label="Name a folder"
                  value={folderName}
                  onChange={setFolderName}
                  onSubmit={() => void createFolder()}
                  actionLabel="Create folder"
                  disabled={!folderName.trim() || creatingCollection}
                /> : null}
              </Container>
            )}
          </DisclosureSection>
        </>
      ) : null}
      {collectionActionError ? (
        <Text variant="body-xs" color="error" role="alert">
          That change couldn&apos;t be saved. Try again in a moment.
        </Text>
      ) : null}
      {showEverything || normalizedQuery ? <DisclosureSection title={showCollections ? 'Everything' : 'Results'} divider={showCollections}>
        {visibleSurfaces.length > 0 ? (
          <Container layout="grid" gap="sm" padding="none" gridCols="auto-fill-xs" width="full">
            {listedSurfaces.map((surface) => (
              <PickerTile
                key={surface.id}
                title={surface.label}
                icon={surface.icon ?? 'Square'}
                colour={surface.sidebarColour}
                trailing={surface.badge ? <Text variant="caption" color="faint">{surface.badge}</Text> : undefined}
                onPointerEnter={() => prewarmPlaceableSurface(surface)}
                onFocus={() => prewarmPlaceableSurface(surface)}
                onClick={() => placeSurface(surface)}
              />
            ))}
          </Container>
        ) : (
          <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" border="all" rounded="lg" minHeight="12rem">
            <Text variant="body" color="secondary" align="center">
              {surfaces.length === 0 ? 'No things available yet.' : 'No things match that search.'}
            </Text>
          </Container>
        )}
      </DisclosureSection> : null}
      {keptSurfaces.length > 0 ? (
        <Container data-kept-surfaces="" layout="vertical" gap="sm" padding="sm" width="full" position="sticky" inset="bottom-0" background="primary">
          {keptSurfaces.map((surface) => (
            <PickerTile
              row
              key={surface.id}
              title={surface.label}
              icon={surface.icon ?? 'Square'}
              colour={surface.sidebarColour}
              onPointerEnter={() => prewarmPlaceableSurface(surface)}
              onFocus={() => prewarmPlaceableSurface(surface)}
              onClick={() => placeSurface(surface)}
            />
          ))}
        </Container>
      ) : null}
    </Container>
  );

  return (
    <Container
      as="section"
      data-testid="empty-container"
      layout="vertical"
      gap="none"
      padding="none"
      width="full"
      height="full"
      overflow="hidden"
    >
      {startSurface && startEntry && showStart ? (
        <Container layout="vertical" gap="md" padding="md" width="full" height="full" minHeight="0">
          <Container layout="horizontal" gap="sm" padding="none" alignItems="center" width="full">
            {search}
            {showEverything ? (
              <Button type="button" variant="secondary" onClick={() => setBrowsing(true)}>
                Browse everything
              </Button>
            ) : null}
          </Container>
          <Container
            data-testid="empty-container-start-surface"
            data-placeable-surface-id={startSurface.id}
            layout="vertical"
            flex={1}
            padding="none"
            width="full"
            minHeight="0"
            overflow="hidden"
            border="all"
            rounded="lg"
          >
            <ComponentMaterialSurface
              packageEntry={startEntry}
              target={startSurface.target ?? null}
              materialTarget={startSurface.materialTarget}
              surfaceInput={startSurface.surfaceInput}
            />
          </Container>
        </Container>
      ) : (
        <Container
          data-testid="empty-container-content"
          layout="vertical"
          flex={1}
          padding="none"
          width="full"
          minHeight="0"
          overflow="auto"
        >
          <Container layout="vertical" gap="xl" padding="lg" width="full" maxWidth="5xl" marginX="auto">
            <Container layout="vertical" gap="md" padding="none" width="full">
              {shows('heading') ? <Text as="h2" variant="heading-lg" color="strong" align="center">
                {startSurface ? 'Open something here' : controlShown('arrangement.header.tabs') ? 'Select the thing you want in this tab' : 'Choose what to open'}
              </Text> : null}
              <Container layout="horizontal" gap="sm" padding="none" alignItems="center" width="full">
                {search}
                {startSurface ? (
                  <Button type="button" variant="ghost" onClick={() => { setBrowsing(false); setQuery(''); }}>
                    {`Back to ${startSurface.label}`}
                  </Button>
                ) : null}
              </Container>
            </Container>
            {launcher}
          </Container>
        </Container>
      )}
    </Container>
  );
}

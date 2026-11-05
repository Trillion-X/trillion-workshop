// packages/sidebar/show/AppSidebar.tsx
//
// Sidebar shell entry point. The sidebar owns chrome, placement, and the
// sidebar-shaped request it sends to discovered addresses. It does not own a
// feature list, setup definition, zone map, producer-specific open policy, or
// any product/agent vocabulary (engine status, AI-agent health, sound, etc.).
// Such surfaces, if wanted, are published by their OWN package as records the
// sidebar renders blindly — never hardcoded here.

import * as React from 'react';
import { controlShown, showListed, useShowChange } from '../../ui/show/show-rules/show-of';
import { CONTENT_HOST_ATTRIBUTE } from './content-host.ts';
import { useBitfieldData } from '#workspace-records';

import { readPlaceableSurfaces } from '../read-data/read-published-records.ts';
import {
  offerableSurfaces,
  ViewerAccessRefsContext,
} from '../../ui/show/placeable-surface-intent';
import {
  filterByVisiblePlaceableSurfaceIds,
  readVisiblePlaceableSurfaceIds,
} from '../../ui/show/browsing-surface-presentation-value/browsing-surface-presentation-value';
import { DEFAULT_SIDEBAR_SCOPE, listMadeByPerson, readSurfaceCollections, type SurfaceCollection } from '../read-data/read-surface-collections.ts';
import {
  readCollectionView,
  writeCollectionView,
  DEFAULT_COLLECTION_VIEW,
  type CollectionViewState,
} from '../do-work/collection-view-preference.ts';
import { partitionLabelForSurfaceList, useSurfaceCollections } from './use-surface-collections.ts';
import { callerCollectionSections } from '../read-data/caller-collection-sections.ts';
import {
  buildCollectionSections,
  collectSurfaceIds,
  nextViewMode,
  shouldShowFullCatalog,
} from './CollectionSections.ts';
import { CollectionManagerRow } from './CollectionManagerRow.tsx';
import { DesktopSidebar } from './DesktopSidebar.tsx';
import { Text } from '../../ui/index.ts';
import { SidebarContent, type NavItemData, type NavSectionData } from './SidebarContent.tsx';
import { mergeSidebarSettings, type SidebarSettings } from '../read-data/sidebar-settings.ts';
import type { SurfacePreview } from '../../ui/show/surface-preview/SurfacePreviewCard';
import { ShowRepliesSidebarCanUse } from './ShowRepliesSidebarCanUse.tsx';
import { ContainedSidebar } from './ContainedSidebar.tsx';
import type { DesktopSidebarProps } from './DesktopSidebar.tsx';

export interface AppSidebarProps {
  /** Identifies a portal as part of the exact scene mount that created this rail. */
  sceneMountToken?: string;
  /** Stable identity within the owning container; independent of list scope. */
  instanceId?: string;
  /** The contents named by the frame's accessible label and placement controls. */
  ariaLabel?: string;
  /** Caller-fed navigation; durable collection reads are opt-in through persistCollectionEdits. */
  sections?: NavSectionData[];
  capabilities?: DesktopSidebarProps['capabilities'];
  containerRef?: React.RefObject<HTMLElement | null>;
  persistPlacement?: boolean;
  currentSelectionId?: string;
  onNavigate?: (viewId: string) => void;
  /** Which group.index scope this sidebar renders. Default `sidebar` (the main
   * shell nav); a nested shell (e.g. Settings) passes its own scope so the SAME
   * sidebar primitive renders a different nav from DATA (L069). */
  scope?: string;
  /** Hide the list-editor controls when a scoped sidebar is navigation-only. */
  showCollectionManager?: boolean;
  /** Browser-local destination for child surface intents inside an embedded arrangement. */
  surfaceIntentDestinationRef?: string;
  /** Catalog address for the surfaces this sidebar should expose. */
  placeableSurfaceListAddressLabel?: string;
  /**
   * Which capability surfaces this presentation offers, resolved by the caller.
   *
   * `null` or absent means unrestricted, which is every app that has not said
   * otherwise. An array is an allow-list of surface ids: the catalog is narrowed
   * to it, and a list left holding nothing by that narrowing stops rendering.
   *
   * A section that never held a capability surface is untouched, because it is a
   * destination rather than a list of tools. That is what keeps Community and
   * the account controls on a presentation that offers one capability.
   */
  visiblePlaceableSurfaceIds?: readonly string[] | null;
  /**
   * The surface records the app itself publishes to the catalog address. They
   * are the catalog until the catalog read answers, so the rail paints at once
   * instead of waiting on the engine; the read's answer replaces them.
   */
  knownPlaceableSurfaces?: unknown;
  /** Enclosing app partition used only by the direct-record compatibility read. */
  partitionLabel?: string;
  /** Deterministic scene projection of the same group-record graph. */
  surfaceCollectionsGraph?: unknown;
  /** Sidebar-wide switches (the app's `sidebar_settings`), the widest level lists and rows override. */
  sidebarSettings?: SidebarSettings;
  /** Keep caller-provided groups while loading and editing durable user lists. */
  persistCollectionEdits?: boolean;
  /** Caller-owned catalog rows for a scoped projection. When present, this
   * replaces the placeable-surface feed lookup while collection decoding,
   * editing, placement, and rendering stay sidebar-owned. */
  catalogItems?: NavItemData[];
  /** Optional controlled search. Filtering remains caller-owned. */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  /** Optional section-independent actions rendered above lists. */
  headerItems?: NavItemData[];
  /** Compact caller-owned actions rendered above search and lists. */
  headerContent?: React.ReactNode;
  /** Caller-owned content host markers placed inside matching sections at any depth. */
  contentHostBySectionId?: Readonly<Record<string, string>>;
  /** Caller-owned empty state rendered when every section is empty. */
  emptyContent?: React.ReactNode;
  /** Dispatch a caller-owned action attached to one catalog row. */
  onItemAction?: (item: NavItemData, actionId: string) => void;
  /**
   * WHERE this sidebar lives, which is a different question from WHICH nav it
   * renders (that is `scope`).
   *
   * `app-rail` (default) is the shell's own rail: it docks to a window edge,
   * floats, hides and auto-hides, and it reads the ONE durable
   * `sidebar-placement` record the person owns.
   *
   * `embedded` is a nav INSIDE its container. With an instance id, container
   * and capabilities it uses its own contained placement record; otherwise
   * the caller lays out its plain rows. Neither path touches app placement.
   *
   * This distinction exists because getting it wrong is invisible in code and
   * catastrophic on screen: mounting the app rail inside a surface does not add
   * a panel, it EVICTS the shell nav and takes the rail, because there is one
   * placement record and the last mount wins.
   */
  presentation?: 'app-rail' | 'embedded';
}

function SidebarPublishedReplies() {
  const requestPayload = React.useMemo(() => ({}), []);

  return (
    <ShowRepliesSidebarCanUse
      requestPayload={requestPayload}
      missing={null}
    />
  );
}

/** A row whose DATA names its own place in the navigation (surface `sidebar_place`: `controls`, the row shown
 * among the window controls; `bottom`, the row kept at the foot below every list) shows there and in no list: one
 * row, one place, so a collapsed rail never draws the same screen twice. `placed` holds each place's rows by the
 * place's name; `listed` is every other row, what the lists and the uncollected catalog read. */
export function splitPlacedRows(items: readonly NavItemData[]): { placed: ReadonlyMap<string, NavItemData[]>; listed: NavItemData[] } {
  const placed = new Map<string, NavItemData[]>();
  const listed: NavItemData[] = [];
  for (const item of items) {
    if (!item.place) { listed.push(item); continue; }
    placed.set(item.place, [...(placed.get(item.place) ?? []), item]);
  }
  return { placed, listed };
}

/** The navigation's own regions a row can be placed in (surface DATA `sidebar_place`). */
const PLACES = { controls: 'controls', bottom: 'bottom' } as const;

export function buildSidebarSections(
  placeableItems: NavItemData[],
  collections: SurfaceCollection[],
  view: CollectionViewState,
  managerRow: React.ReactNode,
  showCollectionManager: boolean,
  offerCollectionEditing: boolean,
): NavSectionData[] {
  const sections: NavSectionData[] = [];
  const catalogById = new Map(placeableItems.map((item) => [item.id, item]));

  // User lists ARE the navigation SSOT (group records). The flat catalog is
  // consolidated away: it renders ONLY surfaces not yet placed in any list, so
  // once every surface is collected it disappears entirely, while any future
  // uncollected surface stays discoverable until it is deliberately placed
  // (L182 capability-existence != nav-placement; a surface is never lost).
  sections.push(...buildCollectionSections(collections, catalogById, view, offerCollectionEditing));

  const collectedSurfaceIds = collectSurfaceIds(collections);
  // `listed: false` surfaces exist (openable, embeddable, explicitly placeable)
  // but are never OFFERED by the nav: they skip the uncollected catalog section.
  const uncollectedItems = placeableItems.filter(
    (item) => !collectedSurfaceIds.has(item.id) && item.listed !== false,
  );
  if (showCollectionManager && uncollectedItems.length > 0 && shouldShowFullCatalog(view)) {
    sections.push({
      id: 'placeable-surfaces',
      title: 'Things',
      icon: 'LayoutDashboard',
      items: uncollectedItems,
      collapsible: true,
      defaultCollapsed: false,
    });
  }

  if (offerCollectionEditing) {
    sections.push({
      id: 'collection-manager',
      items: [],
      bottomContent: managerRow,
    });
  }

  sections.push({
    id: 'published-replies',
    items: [],
    bottomContent: <SidebarPublishedReplies />,
  });

  return sections;
}


/** A host follows its collection when that collection collapses, docks, or
 * detaches. The sidebar carries only a marker; the contributing package owns
 * the content and its actions. */
export function placeContentHosts(
  sections: NavSectionData[],
  hosts: Readonly<Record<string, string>> | undefined,
): NavSectionData[] {
  if (!hosts) return sections;
  return sections.map((section) => {
    const host = hosts[section.id];
    return {
      ...section,
      ...(section.sections ? { sections: placeContentHosts(section.sections, hosts) } : {}),
      ...(host && controlShown(`sidebar.content.${host}`) ? { bottomContent: <>{section.bottomContent}<div {...{ [CONTENT_HOST_ATTRIBUTE]: host }} /></> } : {}),
    };
  });
}

/** Remove list headings that have no visible rows or caller-owned content.
 * Empty lists remain in their owning data and can be populated from the list
 * manager; drawing an empty heading in the rail adds no navigation. A list the
 * person made themselves (listMadeByPerson) stays while they can edit it (it
 * offers rows to add): an empty one is where they drag or add the first row. A
 * kept copy of a list Trillion used to offer is not one they made. */
export function hideEmptySidebarLists(sections: NavSectionData[]): NavSectionData[] {
  const visible = sections.flatMap((section) => {
    const children = hideEmptySidebarLists(section.sections ?? []);
    const madeByPerson = section.collection !== undefined && listMadeByPerson(section.collection) && section.addableItems !== undefined
      && controlShown('sidebar.list.add', { list_id: section.collection.id });
    const hasContent = section.items.length > 0
      || Boolean(section.statusContent)
      || Boolean(section.bottomContent)
      || children.length > 0
      || madeByPerson;
    if (!hasContent) return [];
    return [{ ...section, ...(section.sections ? { sections: children } : {}) }];
  });
  return visible;
}

/** Sidebar-wide switches reach every list as its widest level; a list's own settings and each row's override them
 *  (read-data/sidebar-settings.ts). Caller-built and connected sidebars both pass through here. */
function withSidebarSettings(sections: NavSectionData[], sidebarSettings: SidebarSettings | undefined): NavSectionData[] {
  return sidebarSettings ? sections.map((section) => ({ ...section, settings: mergeSidebarSettings(sidebarSettings, section.settings) })) : sections;
}

export function AppSidebar(props: AppSidebarProps) {
  if (props.sections !== undefined && props.persistCollectionEdits) {
    return <CuratedCallerSidebar key={props.scope ?? props.instanceId} {...props} />;
  }
  if (props.sections !== undefined || (!props.persistCollectionEdits && props.catalogItems !== undefined && props.surfaceCollectionsGraph !== undefined)) {
    return <CallerSidebar key={props.instanceId ?? props.scope} {...props} />;
  }
  return <ConnectedSidebar key={props.instanceId ?? props.scope} {...props} />;
}

const EMPTY_CALLER_COLLECTION_GRAPH = Object.freeze({});

/** Caller rows remain their owner's projection; saved lists store references to
 * those rows through the same collection owner used by the main sidebar. */
function CuratedCallerSidebar(props: AppSidebarProps) {
  const scope = props.scope ?? DEFAULT_SIDEBAR_SCOPE;
  const { collections, loading, error, refresh } = useSurfaceCollections({
    scope, partitionLabel: props.partitionLabel,
    graph: EMPTY_CALLER_COLLECTION_GRAPH, persistEdits: true,
  });
  const [view, setView] = React.useState(DEFAULT_COLLECTION_VIEW);
  const [viewLoaded, setViewLoaded] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    setViewLoaded(false);
    void readCollectionView(scope).then(value => {
      if (!active) return;
      setView(value);
      setViewLoaded(true);
    });
    return () => { active = false; };
  }, [scope]);

  // A selected list can disappear after deletion or a scene change. Keep the
  // caller's own rows available instead of leaving this sidebar blank, and
  // repair the saved preference once the current scene's list read succeeded.
  React.useEffect(() => {
    if (!viewLoaded || loading || error || view.mode === 'show-all'
      || collections.some(collection => collection.id === view.mode)) return;
    const next = { ...view, mode: 'show-all' };
    setView(next);
    void writeCollectionView(next, scope);
  }, [collections, error, loading, scope, view, viewLoaded]);

  const changeView = () => {
    const next = { ...view, mode: nextViewMode(view, collections) };
    setView(next);
    void writeCollectionView(next, scope);
  };
  const items = props.catalogItems ?? [];
  const sections = [
    ...callerCollectionSections(props.sections ?? [], items, collections, view),
    { id: `${scope}:list-manager`, items: [], bottomContent: <>
      {error ? <Text role="status" variant="body-xs">{error}</Text> : null}
      {loading ? <Text role="status" variant="body-xs" color="muted">Loading lists…</Text> : null}
      <CollectionManagerRow scope={scope} collections={collections} placeableItems={items}
        view={view} onChanged={refresh} onCycleView={changeView} />
    </> },
  ];
  return <CallerSidebar {...props} sections={sections} onCollectionsChanged={refresh} />;
}

function CallerSidebar(props: AppSidebarProps & { onCollectionsChanged?: () => void | Promise<void> }) {
  const sections = withSidebarSettings(placeContentHosts(props.sections ?? buildCollectionSections(
    readSurfaceCollections(props.surfaceCollectionsGraph),
    new Map((props.catalogItems ?? []).map((item) => [item.id, item])),
    DEFAULT_COLLECTION_VIEW,
    false,
  ), props.contentHostBySectionId), props.sidebarSettings);
  const content = {
    sceneMountToken: props.sceneMountToken,
    ariaLabel: props.ariaLabel,
    sections,
    footerItems: [],
    currentSelectionId: props.currentSelectionId ?? '',
    onNavigate: props.onNavigate ?? (() => {}),
    searchValue: props.searchValue,
    onSearchChange: props.onSearchChange,
    searchPlaceholder: props.searchPlaceholder,
    searchAriaLabel: props.searchAriaLabel,
    headerContent: props.headerContent,
    headerItems: props.headerItems,
    emptyContent: props.emptyContent,
    onItemAction: props.onItemAction,
    onCollectionsChanged: props.onCollectionsChanged,
  };
  if (props.containerRef && props.instanceId && props.capabilities) {
    return <ContainedSidebar key={props.instanceId} {...content} instanceId={props.instanceId} containerRef={props.containerRef} capabilities={props.capabilities} persistPlacement={props.persistPlacement} />;
  }
  return props.presentation === 'app-rail'
    ? <DesktopSidebar {...content} />
    : <SidebarContent {...content} showLabels />;
}

function ConnectedSidebar({
  instanceId,
  ariaLabel,
  containerRef,
  capabilities,
  persistPlacement,
  currentSelectionId = '',
  onNavigate,
  scope = DEFAULT_SIDEBAR_SCOPE,
  showCollectionManager = true,
  persistCollectionEdits = false,
  surfaceIntentDestinationRef,
  placeableSurfaceListAddressLabel = 'placeable-surface-list',
  visiblePlaceableSurfaceIds = null,
  knownPlaceableSurfaces,
  partitionLabel,
  surfaceCollectionsGraph,
  sidebarSettings,
  catalogItems,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  headerItems,
  headerContent,
  contentHostBySectionId,
  emptyContent,
  onItemAction,
  presentation = scope === DEFAULT_SIDEBAR_SCOPE ? 'app-rail' : 'embedded',
  sceneMountToken,
}: AppSidebarProps) {
  const defaultPlaceableSurfaceListEntry = useBitfieldData('placeable-surface-list');
  const addressedPlaceableSurfaceListEntry = useBitfieldData({
    input: 'placeable-surface-list-by-address-label',
    params: { addressLabel: placeableSurfaceListAddressLabel },
  });
  const placeableSurfaceListEntry = placeableSurfaceListAddressLabel === 'placeable-surface-list'
    ? defaultPlaceableSurfaceListEntry
    : addressedPlaceableSurfaceListEntry;
  const effectivePartitionLabel = partitionLabel ?? partitionLabelForSurfaceList(placeableSurfaceListAddressLabel);

  // Collections (group-record SSOT) through the ONE shared reader every other
  // place that offers these lists also calls, plus the ONE view-preference record.
  const { collections, durableCollections, refresh: refreshCollections } = useSurfaceCollections({
    scope,
    partitionLabel: effectivePartitionLabel,
    graph: surfaceCollectionsGraph,
    persistEdits: persistCollectionEdits,
  });
  const [view, setView] = React.useState<CollectionViewState>(DEFAULT_COLLECTION_VIEW);

  React.useEffect(() => {
    let active = true;
    void readCollectionView(instanceId ?? scope).then((value) => { if (active) setView(value); }).catch(() => {});
    return () => { active = false; };
  }, [instanceId, scope]);

  const updateView = React.useCallback((next: CollectionViewState) => {
    setView(next);
    void writeCollectionView(next, instanceId ?? scope);
  }, [instanceId, scope]);

  const cycleViewMode = React.useCallback(() => {
    const viewCollections = persistCollectionEdits ? durableCollections : collections;
    updateView({ ...view, mode: nextViewMode(view, viewCollections) });
  }, [collections, durableCollections, persistCollectionEdits, updateView, view]);

  const handleNavigate = React.useCallback((viewId: string) => {
    onNavigate?.(viewId);
  }, [onNavigate]);

  // What the person looking at this app holds. `undefined` is an app that has
  // not said who is looking, which leaves every surface offered and is what
  // every app without the provider does today.
  //
  // This is how a capability stays installed without becoming a destination.
  // An assistant placing a form inside a conversation has already decided; the
  // navigation offering "Build a form" to the person the form is being built
  // FOR has not. The sidebar was the one catalog reader that skipped this gate,
  // so it offered every authoring tool the installed packages published.
  const viewerAccessRefs = React.useContext(ViewerAccessRefsContext);
  const showRevision = useShowChange();

  const feedPlaceableItems = React.useMemo<NavItemData[]>(() => {
    const catalog = readPlaceableSurfaces(placeableSurfaceListEntry ?? knownPlaceableSurfaces);
    // A row's hover preview is another surface in the same catalog, named by
    // DATA. Unlisted surfaces count: a preview is usually never offered alone.
    const previewFor = (id: string | undefined): SurfacePreview | undefined => {
      const preview = id ? catalog.find((candidate) => candidate.id === id && !candidate.disabled) : undefined;
      return preview?.packageEntry ? {
        label: preview.label,
        ...(preview.icon ? { icon: preview.icon } : {}),
        packageEntry: preview.packageEntry,
        materialTarget: preview.materialTarget,
        target: preview.target ?? null,
        ...(preview.surfaceInput ? { surfaceInput: preview.surfaceInput } : {}),
      } : undefined;
    };
    return offerableSurfaces(catalog, viewerAccessRefs).filter(surface => showListed('screen', surface.payload as Record<string, unknown>)).map((surface) => ({
      ...(() => { const preview = previewFor(surface.previewSurfaceId); return preview ? { preview } : {}; })(),
      id: surface.id,
      label: surface.label,
      icon: surface.icon,
      badge: surface.badge,
      ...(surface.badgeSource ? { badgeSource: surface.badgeSource } : {}),
      ...(surface.sidebarPlace ? { place: surface.sidebarPlace } : {}),
      ...(surface.sidebarColour ? { colour: surface.sidebarColour } : {}),
      ...(surface.glance ? { glance: surface.glance } : {}),
      ...(surface.surfaceActions ? { surfaceActions: surface.surfaceActions } : {}),
      ...(surface.description ? { description: surface.description } : {}),
      ...(surface.sidebarSettings ? { settings: surface.sidebarSettings } : {}),
      disabled: surface.disabled,
      ...(surface.listed === false ? { listed: false } : {}),
      placeableSurface: true,
      viewId: surface.materialTarget,
      target: surface.target,
      materialTarget: surface.materialTarget,
      packageEntry: surface.packageEntry,
      surfaceInput: surfaceIntentDestinationRef
        ? {
            ...(surface.surfaceInput ?? {}),
            surface_intent_destination_ref: surfaceIntentDestinationRef,
          }
        : surface.surfaceInput,
    }));
  }, [knownPlaceableSurfaces, placeableSurfaceListEntry, surfaceIntentDestinationRef, viewerAccessRefs, showRevision]);
  // One catalog, two presentations. The allowlist narrows what THIS
  // presentation offers; it never shrinks the shared catalog, so the same
  // package set still publishes every surface and the native app still gets
  // all of them by resolving this value to nothing.
  //
  // A collection left holding no admitted surface stops rendering on its own,
  // because the member join below skips a surface that is not in the catalog
  // and an empty section is dropped for a viewer who cannot edit it. That is
  // what turns one DATA array into a short rail rather than a full set of
  // headings with nothing under them.
  const visibleSurfaceIds = React.useMemo(
    () => readVisiblePlaceableSurfaceIds(visiblePlaceableSurfaceIds),
    [visiblePlaceableSurfaceIds],
  );
  // Rows the DATA places among the navigation's own controls stay out of every list (splitPlacedRows).
  const { placed, listed: placeableItems } = React.useMemo(
    () => splitPlacedRows(filterByVisiblePlaceableSurfaceIds(catalogItems ?? feedPlaceableItems, visibleSurfaceIds)),
    [catalogItems, feedPlaceableItems, visibleSurfaceIds],
  );

  const managerRow = React.useMemo(() => (
    <CollectionManagerRow
      scope={scope}
      collections={persistCollectionEdits ? durableCollections : collections}
      placeableItems={placeableItems}
      view={view}
      onChanged={refreshCollections}
      onCycleView={cycleViewMode}
    />
  ), [collections, cycleViewMode, durableCollections, persistCollectionEdits, placeableItems, refreshCollections, view, scope]);

  // A bounded catalog can still be curated when the caller opts into durable
  // list edits: the manager only offers rows from that same allow-list.
  const offerCollectionEditing = showCollectionManager
    && (visibleSurfaceIds === undefined || persistCollectionEdits);

  // Sidebar-wide switches reach every list as its widest level; a list's own
  // settings and each row's override them (read-data/sidebar-settings.ts).
  const sections = React.useMemo(
    () => withSidebarSettings(hideEmptySidebarLists(placeContentHosts(buildSidebarSections(
      placeableItems, collections, view, managerRow, showCollectionManager, offerCollectionEditing,
    ), contentHostBySectionId)), sidebarSettings),
    [placeableItems, collections, view, managerRow, showCollectionManager, offerCollectionEditing, contentHostBySectionId, sidebarSettings, showRevision],
  );
  const controlItems = React.useMemo(() => placed.get(PLACES.controls) ?? [], [placed]);
  // Rows the DATA keeps at the foot of the navigation, below every list.
  const footerItems = React.useMemo(() => placed.get(PLACES.bottom) ?? [], [placed]);

  const contentProps = {
    ariaLabel,
    sections,
    footerItems,
    currentSelectionId,
    onNavigate: handleNavigate,
    onCollectionsChanged: refreshCollections,
    searchValue,
    onSearchChange,
    searchPlaceholder,
    searchAriaLabel,
    headerContent,
    emptyContent,
    headerItems,
    onItemAction,
  };

  if (containerRef && instanceId && capabilities) {
    return <ContainedSidebar key={instanceId} {...contentProps} instanceId={instanceId} containerRef={containerRef} capabilities={capabilities} persistPlacement={persistPlacement} />;
  }

  // An embedded nav is its container's child. No placement record, no docking,
  // no floating, no mobile modal, no app rail. Its container owns where it sits.
  if (presentation === 'embedded') {
    return <SidebarContent {...contentProps} showLabels />;
  }

  return (
      <DesktopSidebar
        ariaLabel={ariaLabel}
        sceneMountToken={sceneMountToken}
        capabilities={capabilities}
        sections={sections}
        footerItems={footerItems}
        currentSelectionId={currentSelectionId}
        onNavigate={handleNavigate}
        onCollectionsChanged={refreshCollections}
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        searchPlaceholder={searchPlaceholder}
        searchAriaLabel={searchAriaLabel}
        headerContent={headerContent}
        emptyContent={emptyContent}
        headerItems={headerItems}
        controlItems={controlItems}
        onItemAction={onItemAction}
      />
  );
}

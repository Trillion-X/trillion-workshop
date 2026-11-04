import React from 'react';

import type { ChromeVisibilityMap } from '../read-data/chrome-visibility';
import { mergeChromeMaps } from '../read-data/chrome-visibility';
import type { LayoutState } from '../read-data/layout-types';
import type { LayoutStatePersistence } from '../do-work/save-layout-state';
import { holdsAnyTab, starterLayoutState, type StarterLayout } from '../read-data/starter-layouts';
import { readPlaceableSurfaces, surfaceInputOverridesReadInput } from '../read-data/read-published-records';
import { LayoutEngineView } from './LayoutEngine';
import { ArrangementHostDataContext, LayoutOwnerProvider, LayoutOwnerProviderView, type ArrangementHostData } from './screen-arrangement-context';
import { EmptyContainerSourcesContext, type EmptyContainerSources } from './empty-container-sources';
import { cn, ErrorBoundary } from '../../ui';
import { useBitfieldData } from '#workspace-records';
import { ViewerAccessRefsProvider, type SurfaceIntentReaderConfig } from '../../ui/show/placeable-surface-intent';
import { LocalSurfaceContentProvider, type LocalSurfaceContent } from './embedded-surface-content';
import { layoutBoundsWithin } from './layout-bounds';

export { LocalSurfaceContentContext, LocalSurfaceContentProvider } from './embedded-surface-content';
export type { LocalSurfaceContent, LocalSurfaceContentRegistry, LocalSurfaceContentRenderer, LocalSurfaceContentResolver } from './embedded-surface-content';

/**
 * What the top-level arrangement is given by its host, handed to a nested one so it is the same arrangement at every
 * depth: what an empty pane offers and the lists it opens from (`emptyContainerSources`), the host's own DATA (kept
 * layouts, tabs outside the catalog), and whose access scopes the screens offered (always the viewer's own).
 */
export type ArrangementHost = {
  emptyContainerSources?: EmptyContainerSources;
  hostData?: ArrangementHostData;
};

/** The providers the top level puts around its engine, around a nested one too (a nested screen is its own React root,
 *  so it inherits nothing). With no host the engine runs as it always did. */
function HostedEngine({ host, children }: { host?: ArrangementHost; children: React.ReactElement }) {
  if (!host) return children;
  let hosted = children;
  if (host.hostData) hosted = <ArrangementHostDataContext.Provider value={host.hostData}>{hosted}</ArrangementHostDataContext.Provider>;
  if (host.emptyContainerSources) hosted = <EmptyContainerSourcesContext.Provider value={host.emptyContainerSources}>{hosted}</EmptyContainerSourcesContext.Provider>;
  return <ViewerAccessRefsProvider>{hosted}</ViewerAccessRefsProvider>;
}

/** Inline arrangements take their height from the drawn panes, including natural-size panes. */
function EmbeddedArrangementBox({ sizing, className, children }: {
  sizing?: 'fill' | 'content'; className?: string; children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(0);
  React.useLayoutEffect(() => {
    if (sizing !== 'content' || !ref.current) return;
    const host = ref.current;
    let frame = 0;
    const watched = new Set<Element>();
    const measure = () => {
      frame = 0;
      const own = (node: Element) => node.closest('[data-embedded-screen-arrangement]') === host;
      const panes = [...host.querySelectorAll<HTMLElement>('[data-split-child], [data-arrangement-pane], [data-fits-content]')].filter(own);
      // Camera zoom changes its wrapper's real size without resizing the
      // logical panes. Watch that wrapper too, but fit from the content bounds.
      const observing = [...panes, ...[...host.querySelectorAll<HTMLElement>('[data-arrangement-zoom]')].filter(own)];
      for (const node of watched) if (!observing.includes(node as HTMLElement)) { sizes?.unobserve(node); watched.delete(node); }
      for (const node of observing) if (!watched.has(node)) { sizes?.observe(node); watched.add(node); }
      const viewport = host.querySelector<HTMLElement>('[data-arranger="split-tree"]');
      // Motion and scrolling change painted positions, not intrinsic size.
      // Keep nested fitters from feeding temporary translations into height.
      const bottom = panes.reduce((end, node) => {
        const bounds = layoutBoundsWithin(node, host);
        return bounds ? Math.max(end, bounds.y + bounds.height) : end;
      }, 0);
      const padding = viewport ? Number.parseFloat(getComputedStyle(viewport).paddingBottom) || 0 : 0;
      const next = Math.max(0, Math.ceil(bottom + padding));
      setHeight(current => current === next ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const changes = new MutationObserver(schedule);
    changes.observe(host, { childList: true, characterData: true, subtree: true });
    schedule();
    return () => { cancelAnimationFrame(frame); sizes?.disconnect(); changes.disconnect(); };
  }, [sizing]);
  return <div ref={ref} data-embedded-screen-arrangement
    className={cn('relative flex min-h-0 w-full overflow-hidden', sizing === 'content' ? 'shrink-0' : 'h-full', className)}
    style={sizing === 'content' ? { height } : undefined}>{children}</div>;
}

export type EmbeddedScreenArrangementProps = {
  initialState: Partial<LayoutState>;
  layoutEntryInput: string | { input: string; params: Record<string, unknown> };
  /** A host-supplied catalog read; when omitted, this arrangement reads its own catalog as before. */
  placeableSurfaceListEntry?: unknown;
  /** Host-owned local React content, resolved by the exact catalog surface id. */
  localSurfaceContent?: LocalSurfaceContent;
  placeableSurfaceListAddressLabel?: string;
  surfaceIntentDestinationRef?: string | null;
  addressedSurfaceTargetContainerId?: string | null;
  persistence?: LayoutStatePersistence;
  applicationRef?: string;
  acceptPersistedState?: (state: LayoutState) => boolean;
  reconcilePersistedState?: (persistedState: LayoutState, fallbackState: LayoutState) => LayoutState;
  /**
   * Host chrome zone visibility — layered OVER the persisted state's own
   * chrome map (host data wins per zone). Dot-path zones resolved by
   * longest-prefix match; e.g. `{ 'header.actions': false }` hides every
   * action button while tabs stay, `{ header: false }` hides the whole bar.
   */
  chrome?: ChromeVisibilityMap;
  className?: string;
  /** Inline controls grow with their arranged content; whole screens fill their allotted pane. */
  sizing?: 'fill' | 'content';
  surfaceIntentReader?: SurfaceIntentReaderConfig | null;
  /** The top level's host DATA, so this arrangement is that arrangement, nested (ArrangementHost). */
  host?: ArrangementHost;
  /**
   * The arrangement it opens on when nothing is saved, built from the screens this viewer is offered (the list
   * `placeableSurfaceListAddressLabel` names); it takes the place of `initialState`.
   */
  starter?: StarterLayout | null;
};

export type EmbeddedScreenArrangementViewProps = Omit<EmbeddedScreenArrangementProps, 'layoutEntryInput' | 'initialState' | 'starter'> & {
  /** The arrangement it opens on when nothing is saved; a `starter` takes its place. */
  initialState?: Partial<LayoutState>;
  /**
   * The screens this arrangement declares (starter DATA, already filled from the record it shows), built from the
   * screens the viewer is offered. With one, the arrangement can never open empty: a saved state holding no tab is
   * set aside for it, so a picker with nothing in it is never what a page shows.
   */
  starter?: StarterLayout | null;
  layoutEntry: unknown;
  publishedRecordsEntry: unknown;
  placeableSurfaceListEntry: unknown;
};

type EmbeddedScreenArrangementWithEntryProps = EmbeddedScreenArrangementProps & { placeableSurfaceListEntry: unknown };

/** Reuse the same catalog for starter admission and the rendered arrangement. */
function EmbeddedEngine({ placeableSurfaceListEntry, placeableSurfaceListAddressLabel, ...props }: {
  placeableSurfaceListEntry: unknown;
  placeableSurfaceListAddressLabel?: string;
  useGlobalSurfaceIntents: boolean;
  surfaceIntentReader?: SurfaceIntentReaderConfig | null;
  surfaceIntentDestinationRef?: string | null;
  addressedSurfaceTargetContainerId?: string | null;
}) {
  const publishedRecordsEntry = useBitfieldData('published-records');
  const placeableSurfaceInputOverridesEntry = useBitfieldData({
    input: 'selector-source-by-address',
    params: surfaceInputOverridesReadInput(placeableSurfaceListAddressLabel ?? 'placeable-surface-list::main-workspace').params,
  });
  return <LayoutEngineView {...props} publishedRecordsEntry={publishedRecordsEntry}
    placeableSurfaceListEntry={placeableSurfaceListEntry} placeableSurfaceInputOverridesEntry={placeableSurfaceInputOverridesEntry} />;
}

function EmbeddedScreenArrangementWithEntry({
  initialState,
  layoutEntryInput,
  placeableSurfaceListEntry,
  placeableSurfaceListAddressLabel,
  surfaceIntentDestinationRef,
  addressedSurfaceTargetContainerId,
  persistence,
  applicationRef,
  acceptPersistedState,
  reconcilePersistedState,
  chrome,
  className,
  surfaceIntentReader,
  host,
  starter,
  localSurfaceContent,
  sizing,
}: EmbeddedScreenArrangementWithEntryProps) {
  // A starter owns this declaration. Caller-owned controls rerender on every
  // keystroke; an unrelated fresh fallback object must not mint new starter
  // tabs and replace their mounted controls (and keyboard focus).
  const fallbackState = starter ? undefined : initialState;
  const declaredState = React.useMemo<Partial<LayoutState>>(
    () => (starter ? starterLayoutState(starter, readPlaceableSurfaces(placeableSurfaceListEntry)) : null) ?? fallbackState ?? {},
    [starter, placeableSurfaceListEntry, fallbackState],
  );
  const declaresTabs = holdsAnyTab(declaredState);
  const acceptsPersisted = React.useCallback(
    (state: LayoutState) => (!starter || !declaresTabs || holdsAnyTab(state)) && (acceptPersistedState?.(state) ?? true),
    [starter, declaresTabs, acceptPersistedState],
  );
  // Host chrome layers over the initial state's own chrome map (host wins
  // per zone). Persisted states keep their own chrome; hostChrome re-layers
  // on top after every persistence round-trip via the provider.
  const initialStateWithChrome = React.useMemo<Partial<LayoutState>>(
    () => (chrome ? { ...declaredState, chrome: mergeChromeMaps(declaredState.chrome, chrome) } : declaredState),
    [declaredState, chrome],
  );
  // The screens it declares are not offered yet (the screens list is still arriving): draw nothing rather than a
  // picker, and open on them once they are.
  if (starter && !declaresTabs) return null;
  return (
    <EmbeddedArrangementBox sizing={sizing} className={className}>
      <ErrorBoundary zoneName="embedded screen arrangement">
        <LayoutOwnerProvider
          applicationRef={applicationRef ?? `embedded:${typeof layoutEntryInput === 'string' ? layoutEntryInput : layoutEntryInput.input}`}
          initialState={initialStateWithChrome}
          layoutEntryInput={layoutEntryInput}
          placeableSurfaceListAddressLabel={placeableSurfaceListAddressLabel}
          persistence={persistence}
          acceptPersistedState={acceptsPersisted}
          reconcilePersistedState={reconcilePersistedState}
          hostChrome={chrome}
        >
          <LocalSurfaceContentProvider content={localSurfaceContent}>
            <HostedEngine host={host}>
              <EmbeddedEngine
                placeableSurfaceListEntry={placeableSurfaceListEntry}
                placeableSurfaceListAddressLabel={placeableSurfaceListAddressLabel}
                useGlobalSurfaceIntents={false}
                surfaceIntentReader={surfaceIntentReader}
                surfaceIntentDestinationRef={surfaceIntentDestinationRef}
                addressedSurfaceTargetContainerId={addressedSurfaceTargetContainerId}
              />
            </HostedEngine>
          </LocalSurfaceContentProvider>
        </LayoutOwnerProvider>
      </ErrorBoundary>
    </EmbeddedArrangementBox>
  );
}

function EmbeddedScreenArrangementReadList(props: EmbeddedScreenArrangementProps) {
  const placeableSurfaceListEntry = useBitfieldData({
    input: 'placeable-surface-list-by-address-label',
    params: { addressLabel: props.placeableSurfaceListAddressLabel ?? 'placeable-surface-list::main-workspace' },
  });
  return <EmbeddedScreenArrangementWithEntry {...props} placeableSurfaceListEntry={placeableSurfaceListEntry} />;
}

export function EmbeddedScreenArrangement(props: EmbeddedScreenArrangementProps) {
  return props.placeableSurfaceListEntry !== undefined
    ? <EmbeddedScreenArrangementWithEntry {...props} placeableSurfaceListEntry={props.placeableSurfaceListEntry} />
    : <EmbeddedScreenArrangementReadList {...props} />;
}

export function EmbeddedScreenArrangementView({
  initialState,
  layoutEntry,
  publishedRecordsEntry,
  placeableSurfaceListEntry,
  placeableSurfaceListAddressLabel,
  surfaceIntentDestinationRef,
  addressedSurfaceTargetContainerId,
  persistence,
  applicationRef,
  acceptPersistedState,
  reconcilePersistedState,
  chrome,
  className,
  surfaceIntentReader,
  starter,
  host,
  localSurfaceContent,
  sizing,
}: EmbeddedScreenArrangementViewProps) {
  const fallbackState = starter ? undefined : initialState;
  const declaredState = React.useMemo<Partial<LayoutState>>(
    () => (starter ? starterLayoutState(starter, readPlaceableSurfaces(placeableSurfaceListEntry)) : null) ?? fallbackState ?? {},
    [starter, placeableSurfaceListEntry, fallbackState],
  );
  const declaresTabs = holdsAnyTab(declaredState);
  const acceptsPersisted = React.useCallback(
    (state: LayoutState) => (!declaresTabs || holdsAnyTab(state)) && (acceptPersistedState?.(state) ?? true),
    [declaresTabs, acceptPersistedState],
  );
  const initialStateWithChrome = React.useMemo<Partial<LayoutState>>(
    () => (chrome ? { ...declaredState, chrome: mergeChromeMaps(declaredState.chrome, chrome) } : declaredState),
    [declaredState, chrome],
  );
  // The screens it declares are not offered yet (the screens list is still arriving): draw nothing rather than a
  // picker, and open on them once they are.
  if (starter && !declaresTabs) return null;
  return (
    <EmbeddedArrangementBox sizing={sizing} className={className}>
      <ErrorBoundary zoneName="embedded screen arrangement">
        <LayoutOwnerProviderView
          applicationRef={applicationRef ?? `embedded:${placeableSurfaceListAddressLabel ?? 'screen-arrangement'}`}
          initialState={initialStateWithChrome}
          layoutEntry={layoutEntry}
          placeableSurfaceListAddressLabel={placeableSurfaceListAddressLabel}
          persistence={persistence}
          acceptPersistedState={acceptsPersisted}
          reconcilePersistedState={reconcilePersistedState}
          hostChrome={chrome}
        >
          <LocalSurfaceContentProvider content={localSurfaceContent}>
            <HostedEngine host={host}>
              <LayoutEngineView
                publishedRecordsEntry={publishedRecordsEntry}
                placeableSurfaceListEntry={placeableSurfaceListEntry}
                useGlobalSurfaceIntents={false}
                surfaceIntentReader={surfaceIntentReader}
                surfaceIntentDestinationRef={surfaceIntentDestinationRef}
                addressedSurfaceTargetContainerId={addressedSurfaceTargetContainerId}
              />
            </HostedEngine>
          </LocalSurfaceContentProvider>
        </LayoutOwnerProviderView>
      </ErrorBoundary>
    </EmbeddedArrangementBox>
  );
}

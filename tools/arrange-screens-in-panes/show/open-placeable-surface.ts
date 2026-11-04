import type { LayoutActions } from '../do-work/layout-operations';
import type { LayoutState, SplitTreeNode, TabMeta, TiledLayout } from '../read-data/layout-types';
import type { PlaceableSurfaceRecord } from '../read-data/read-published-records';
import { readInitialArrangementState } from '../read-data/read-initial-arrangement';
import { placeTabInOverlay } from '../read-data/place-tab-in-overlay';
import { viewportIsNarrow } from '../../ui/show/use-narrow-viewport/useNarrowViewport';
import {
  readPlaceableSurfacePayloadFromUnknown,
  readPlaceableSurfaceTabFromPayload,
} from './placeable-surface-drag';
import {
  isEmptySurfaceTab,
  sameValue,
  tabShowsPlaceableSurface,
  tabWithId,
} from './placeable-surface-tab';

export type PlaceableSurfaceOpenActions = Pick<
  LayoutActions,
  'addSurfaceTab' | 'applyLayoutState' | 'activateTab' | 'focusContainer' | 'moveTabToContainer' | 'splitContainerWithSurface' | 'splitContainerWithTab' | 'updateTabMeta' | 'flush'
>;

/** The tab id inside a `surface_instance_ref` (`[layoutIdentity, tabId]`, ContainerHost), when that tab is open. */
function openTabOfInstance(layoutState: LayoutState, instanceRef: string): string | null {
  try {
    const parsed = JSON.parse(instanceRef) as unknown;
    const tabId = Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : null;
    return tabId && layoutState.tabs[tabId] ? tabId : null;
  } catch {
    return null;
  }
}

/** Bring an opened pane into the arrangement's scroll viewport after React has
 * committed the tab/layout action. The split tree owns the actual scrolling
 * element; other arrangement modes intentionally have no scroll viewport. */
export function revealArrangementContainer(containerId: string): void {
  if (typeof window === 'undefined') return;
  const reveal = () => {
    const pane = Array.from(document.querySelectorAll<HTMLElement>('[data-container-id]'))
      .find((element) => element.dataset.containerId === containerId);
    const viewport = pane?.closest<HTMLElement>('[data-arranger="split-tree"]');
    if (!pane || !viewport) return;

    const viewportRect = viewport.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const contentLeft = viewportRect.left + viewport.clientLeft;
    const contentTop = viewportRect.top + viewport.clientTop;
    const relativeLeft = paneRect.left - contentLeft;
    const relativeTop = paneRect.top - contentTop;
    const inset = 16;
    let left = viewport.scrollLeft;
    let top = viewport.scrollTop;

    if (relativeLeft < 0) left += relativeLeft - inset;
    else if (relativeLeft + paneRect.width > viewport.clientWidth) {
      left += relativeLeft + Math.min(paneRect.width, viewport.clientWidth) - viewport.clientWidth + inset;
    }
    if (relativeTop < 0) top += relativeTop - inset;
    else if (relativeTop + paneRect.height > viewport.clientHeight) {
      top += relativeTop + Math.min(paneRect.height, viewport.clientHeight) - viewport.clientHeight + inset;
    }

    const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    left = Math.max(0, Math.min(maxLeft, left));
    top = Math.max(0, Math.min(maxTop, top));
    if (left === viewport.scrollLeft && top === viewport.scrollTop) return;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    viewport.scrollTo({ left, top, behavior: reducedMotion ? 'instant' : 'smooth' });
  };

  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(reveal);
  else window.setTimeout(reveal, 0);
}

/** Wait for queued slot operations to commit before looking for a pane they
 * may have created. A frame scheduled at click time can run before the slot
 * reply mounts that pane, making a one-shot reveal silently miss. */
function revealArrangementContainerAfterLayout(
  layoutActions: PlaceableSurfaceOpenActions,
  tabId: string,
): void {
  void layoutActions.flush()
    .then((layout) => {
      const container = Object.values(layout.containers).find((candidate) => (
        layout.tabGroups[candidate.groupId]?.tabIds.includes(tabId)
      ));
      if (container) revealArrangementContainer(container.id);
    })
    .catch(() => {
      // A rejected layout operation did not create a destination to reveal.
    });
}

/**
 * Find a tab already showing `surface`, plus the container that holds it.
 * Dedupe-on-open keys on the surface's STABLE identity (via
 * `tabShowsPlaceableSurface` — surface id / materialTarget+target+entry+input),
 * NOT the tab's ephemeral id. Without this, every open mints a fresh tab id, the
 * slot's id-keyed dedup never fires, and tabs accumulate without bound.
 */
function findOpenSurfaceTab(
  layoutState: LayoutState,
  surface: PlaceableSurfaceRecord,
): { tabId: string; containerId: string } | null {
  const showsCatalogInput = (tab: TabMeta): boolean => {
    const input = tab.metadata?.surfaceInput;
    const own = surface.surfaceInput ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Object.keys(own).length === 0;
    const values = input as Record<string, unknown>;
    return Object.entries(own).every(([key, value]) => sameValue(values[key], value))
      && Object.entries(values).every(([key, value]) => key.startsWith('surface_intent')
        || (key in own && sameValue(value, own[key])));
  };
  const find = (shows: (tab: TabMeta) => boolean) => {
    for (const [containerId, container] of Object.entries(layoutState.containers)) {
      const group = layoutState.tabGroups[container.groupId];
      if (!group) continue;
      for (const tabId of group.tabIds) {
        const tab = layoutState.tabs[tabId];
        if (tab && shows(tab)) return { tabId, containerId };
      }
    }
    return null;
  };
  // A tab the catalog backs first; else a tab the surface is already showing for one thing (a space, a decision).
  // Asking for such a screen by name (a tour pointing at it) then shows that tab instead of adding one beside it that
  // has no thing to show.
  return find((tab) => tabShowsPlaceableSurface(tab, surface)
    && (tab.metadata?.surfaceInputBinding !== 'invocation' || showsCatalogInput(tab)))
    ?? (surface.addressInput
      ? find((tab) => tab.metadata?.surfaceInputBinding === 'invocation' && tabShowsSurfaceForOneThing(tab, surface))
      : null);
}

/**
 * Whether a tab opened for one thing shows `surface`: it mounts the same screen (package entry, material and target)
 * and its input carries the surface's own input. Screens that share one mount tell themselves apart by that own
 * input (`{ screen: 'decision' }` beside `{ screen: 'book' }`), and the thing adds to it (`{ screen: 'decision', id }`).
 */
function tabShowsSurfaceForOneThing(tab: TabMeta, surface: PlaceableSurfaceRecord): boolean {
  if (!samePackageEntryRef(tab.packageEntry ?? null, surface.packageEntry ?? null)
    || (tab.materialTarget ?? null) !== (surface.materialTarget ?? null)
    || (tab.target ?? null) !== (surface.target ?? null)) return false;
  const own = surface.surfaceInput;
  if (!own) return true;
  const input = tab.metadata?.surfaceInput;
  return isRecord(input) && Object.entries(own).every(([key, value]) => sameValue(input[key], value));
}

/** Same-surface test between an already-open tab and a freshly built candidate.
 * Input-bound surfaces key on the owner mount plus opaque input, independent of
 * a producer's request id. Static surfaces key on the stamped surface id, then
 * fall back to the mount contract. */
function tabsShowSameSurface(open: TabMeta | null | undefined, candidate: TabMeta): boolean {
  if (!open) return false;
  if (candidate.metadata?.surfaceInputBinding === 'invocation'
    && open.metadata?.surfaceInputBinding === 'catalog') return false;
  const openInput = open.metadata?.surfaceInput;
  const candidateInput = candidate.metadata?.surfaceInput;
  if (openInput !== undefined || candidateInput !== undefined) {
    return openInput !== undefined
      && candidateInput !== undefined
      && (open.materialTarget ?? null) === (candidate.materialTarget ?? null)
      && (open.target ?? null) === (candidate.target ?? null)
      && samePackageEntryRef(open.packageEntry ?? null, candidate.packageEntry ?? null)
      && sameValue(openInput, candidateInput);
  }
  const openId = open.metadata?.placeable_surface_id;
  const candidateId = candidate.metadata?.placeable_surface_id;
  if (typeof openId === 'string' && typeof candidateId === 'string') return openId === candidateId;
  return (open.materialTarget ?? null) === (candidate.materialTarget ?? null)
    && (open.target ?? null) === (candidate.target ?? null)
    && samePackageEntryRef(open.packageEntry ?? null, candidate.packageEntry ?? null)
    && sameValue(open.metadata?.surfaceInput, candidate.metadata?.surfaceInput);
}

function samePackageEntryRef(
  left: { packageName: string; entryName: string } | null,
  right: { packageName: string; entryName: string } | null,
): boolean {
  if (!left || !right) return !left && !right;
  return left.packageName === right.packageName && left.entryName === right.entryName;
}

function findTabMatchingTab(
  layoutState: LayoutState,
  candidate: TabMeta,
): { tabId: string; containerId: string } | null {
  for (const [containerId, container] of Object.entries(layoutState.containers)) {
    const group = layoutState.tabGroups[container.groupId];
    if (!group) continue;
    for (const tabId of group.tabIds) {
      if (tabsShowSameSurface(layoutState.tabs[tabId], candidate)) {
        return { tabId, containerId };
      }
    }
  }
  return null;
}

/**
 * The pane right after `containerId` along `dir` (to its right for a row, below
 * it for a column) in the tiled arrangement, or null when it has none. A
 * neighbour that is itself split answers with its first pane.
 */
export function paneBeside(layoutState: LayoutState, containerId: string, dir: 'row' | 'column'): string | null {
  const tiled = layoutState.layouts.find((layout): layout is TiledLayout => layout.type === 'tiled');
  const firstLeaf = (node: SplitTreeNode): string => node.kind === 'leaf' ? node.containerId : firstLeaf(node.children[0]);
  const contains = (node: SplitTreeNode): boolean => node.kind === 'leaf'
    ? node.containerId === containerId
    : node.children.some(contains);
  const search = (node: SplitTreeNode): string | null => {
    if (node.kind === 'leaf') return null;
    const index = node.children.findIndex(contains);
    if (index < 0) return null;
    const inner = search(node.children[index]);
    if (inner) return inner;
    const next = node.dir === dir ? node.children[index + 1] : undefined;
    return next ? firstLeaf(next) : null;
  };
  const found = tiled?.root ? search(tiled.root) : null;
  return found && found !== containerId && layoutState.containers[found] ? found : null;
}

/**
 * An open asked for from inside a pane, with no place of its own, opens beside
 * that pane: the request gains `placement: 'right'` and the pane as its source.
 * A request that names its own place, that a passing window asked for, or that no pane asked for (the sidebar,
 * an address, a notification), is returned unchanged.
 */
export function openBesideSourcePane(raw: unknown, layoutState: LayoutState, sourceContainerId: string | null): unknown {
  if (!sourceContainerId || !layoutState.containers[sourceContainerId]) return raw;
  // A passing window (closed by a press outside it, as Find anything is) is no pane to open beside.
  if (layoutState.closeOnOutsidePress?.[sourceContainerId] === true) return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const request = raw as Record<string, unknown>;
  if (request.placement || request.placementTargetContainerId || request.replacesInstance) return raw;
  return { ...request, placement: 'right', placementTargetContainerId: sourceContainerId };
}

export function choosePlacementContainerId(layoutState: LayoutState): string | null {
  // A passing window (one a press outside closes, as Find anything is) never takes the screens opened from it: they
  // land in the pane the person was working in when it opened (focusReturnsTo), followed back through any window
  // opened from another window.
  const takes = (id: string | null | undefined): id is string => !!id && !!layoutState.containers[id] && layoutState.closeOnOutsidePress?.[id] !== true;
  let focusedContainerId = layoutState.focusedContainerId;
  for (const seen = new Set<string>(); focusedContainerId && !takes(focusedContainerId) && !seen.has(focusedContainerId);) {
    seen.add(focusedContainerId);
    focusedContainerId = layoutState.focusReturnsTo?.[focusedContainerId] ?? null;
  }
  if (takes(focusedContainerId)) return focusedContainerId;
  const maximizedContainerId = layoutState.maximizedContainerId;
  if (takes(maximizedContainerId)) return maximizedContainerId;
  // No pane was chosen: the first pane of the tiled arrangement, else the first pane there is. An accepted open
  // always lands somewhere.
  const tiled = layoutState.layouts.find((layout): layout is TiledLayout => layout.type === 'tiled');
  const firstLeaf = (node: SplitTreeNode): string => node.kind === 'leaf' ? node.containerId : firstLeaf(node.children[0]);
  const tiledFirst = tiled?.root ? firstLeaf(tiled.root) : null;
  if (tiledFirst && layoutState.containers[tiledFirst]) return tiledFirst;
  return Object.keys(layoutState.containers).find(takes) ?? null;
}

function resolveTargetContainerId(
  layoutState: LayoutState,
  targetContainerId?: string | null,
): string | null {
  if (targetContainerId && layoutState.containers[targetContainerId]) return targetContainerId;
  return choosePlacementContainerId(layoutState);
}

function focusOrPlaceExistingTab(
  layoutActions: PlaceableSurfaceOpenActions,
  layoutState: LayoutState,
  open: { tabId: string; containerId: string },
  requestedPayload: ReturnType<typeof readPlaceableSurfacePayloadFromUnknown>,
  targetContainerId?: string | null,
): void {
  const placement = requestedPayload?.placement;
  const requestedTargetId = requestedPayload?.placementTargetContainerId;
  const requestedTarget = resolveTargetContainerId(layoutState, requestedTargetId ?? targetContainerId);
  if ((placement === 'right' || placement === 'below')
    && requestedTarget
    && open.containerId !== requestedTarget
    && open.containerId !== paneBeside(layoutState, requestedTarget, placement === 'right' ? 'row' : 'column')) {
    // Reuse the existing surface beside the active source container. Saved
    // layouts can reopen an older tab before an interactive request supplies
    // a source id, so the focused container is also a valid placement anchor.
    layoutActions.splitContainerWithTab(
      requestedTarget,
      placement === 'right' ? 'row' : 'column',
      open.tabId,
      'after',
    );
    // The split action activates the moved tab in its new pane. Keep that
    // guarantee explicit for action owners that preserve the prior active tab.
    layoutActions.activateTab(open.tabId);
    revealArrangementContainerAfterLayout(layoutActions, open.tabId);
    return;
  }
  if (placement === 'right') {
    layoutActions.focusContainer(open.containerId);
    layoutActions.activateTab(open.tabId);
    revealArrangementContainerAfterLayout(layoutActions, open.tabId);
    return;
  }
  // Opening a screen that is already open shows its tab where it is. Only a request that names a pane of its own (a
  // drop on a pane, an addressed delivery) moves the tab there; the focused pane is never a reason to move it, which
  // would leave the pane it came from empty.
  const namedTarget = requestedTargetId ?? targetContainerId;
  if (namedTarget && requestedTarget && open.containerId !== requestedTarget) {
    layoutActions.moveTabToContainer(open.tabId, requestedTarget);
    layoutActions.focusContainer(requestedTarget);
  } else {
    layoutActions.focusContainer(open.containerId);
  }
  layoutActions.activateTab(open.tabId);
  revealArrangementContainerAfterLayout(layoutActions, open.tabId);
}

function activeTabIdForContainer(layoutState: LayoutState, containerId: string): string | null {
  const container = layoutState.containers[containerId];
  return container ? layoutState.tabGroups[container.groupId]?.activeTabId ?? null : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readMaterialKind(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const material = value.material;
  if (!isRecord(material)) return null;
  const kind = material.kind;
  return typeof kind === 'string' && kind.trim().length > 0 ? kind.trim() : null;
}

function surfaceForMaterial(
  surfaces: readonly PlaceableSurfaceRecord[],
  materialKind: string | null,
): PlaceableSurfaceRecord | null {
  if (!materialKind) return null;
  return surfaces.find((surface) => (
    !surface.disabled && surface.acceptsMaterialKinds.includes(materialKind)
  )) ?? null;
}

function surfaceForPayload(
  surfaces: readonly PlaceableSurfaceRecord[],
  payload: ReturnType<typeof readPlaceableSurfacePayloadFromUnknown>,
): PlaceableSurfaceRecord | null {
  if (!payload) return null;
  if (payload.id) {
    const exactSurface = surfaces.find((surface) => !surface.disabled && surface.id === payload.id);
    if (exactSurface) return exactSurface;
  }
  if (payload.materialTarget) {
    if (payload.surfaceInput) {
      const surfaceInputMatch = surfaces.find((surface) => (
        !surface.disabled
        && surface.materialTarget === payload.materialTarget
        && sameValue(surface.surfaceInput, payload.surfaceInput)
      ));
      if (surfaceInputMatch) return surfaceInputMatch;
    }
    const materialTargetSurface = surfaces.find((surface) => (
      !surface.disabled && surface.materialTarget === payload.materialTarget
    ));
    if (materialTargetSurface) return materialTargetSurface;
  }
  return surfaceForMaterial(surfaces, readMaterialKind(payload));
}

export function resolvePlaceableSurfacePayload(
  raw: unknown,
  surfaces: readonly PlaceableSurfaceRecord[],
): unknown {
  const payload = readPlaceableSurfacePayloadFromUnknown(raw);
  if (!payload) return raw;
  if (payload.target || payload.packageEntry) return payload;
  const surface = surfaceForPayload(surfaces, payload);
  if (!surface) return payload;
  return {
    ...payload,
    // A catalog open shows the surface itself, so its tab carries the surface's own id and a later open of the same
    // surface finds it (tabShowsPlaceableSurface). An open for one thing is told apart by its input instead.
    id: payload.surfaceInput ? `${surface.id}:${payload.id ?? Date.now().toString(36)}` : surface.id,
    target: surface.target ?? null,
    packageEntry: surface.packageEntry ?? null,
    materialTarget: surface.materialTarget,
    // A request that names no title shows the surface's own label, never its entry name.
    title: payload.title ?? surface.label,
    icon: payload.icon ?? surface.icon,
    // What the surface always opens with (its own `surface_input`), with what this open adds on top: a screen that
    // opens on a tool keeps its tool when it is opened on one thing.
    ...(payload.surfaceInput ?? surface.surfaceInput ? { surfaceInput: { ...surface.surfaceInput, ...payload.surfaceInput } } : {}),
  };
}

/**
 * On a phone-narrow screen split panes stack into one tall column, so a screen asked to open beside another
 * (`placement: 'right' | 'below'`) opens in that pane instead, as the one screen shown; its tab stays for going back.
 */
function onePaneWhenNarrow(
  payload: ReturnType<typeof readPlaceableSurfacePayloadFromUnknown>,
): ReturnType<typeof readPlaceableSurfacePayloadFromUnknown> {
  if (!payload?.placement || !viewportIsNarrow()) return payload;
  const { placement: _placement, ...inPlace } = payload;
  return inPlace;
}

export function openPlaceableSurfacePayload({
  layoutActions,
  layoutState,
  raw,
  surfaces,
  deduplicate = false,
  targetContainerId = null,
}: {
  layoutActions: PlaceableSurfaceOpenActions;
  layoutState: LayoutState;
  raw: unknown;
  surfaces: readonly PlaceableSurfaceRecord[];
  /** Addressed delivery can require exact-surface idempotency even for rows
   * whose ordinary interactive policy permits intentionally-new tabs. */
  deduplicate?: boolean;
  targetContainerId?: string | null;
}): boolean {
  const requestedPayload = onePaneWhenNarrow(readPlaceableSurfacePayloadFromUnknown(raw));
  // A surface taking an open tab's place keeps that tab (its pane, its position) and swaps what it shows.
  const replacedTabId = requestedPayload?.replacesInstance ? openTabOfInstance(layoutState, requestedPayload.replacesInstance) : null;
  if (replacedTabId) {
    const replacement = readPlaceableSurfaceTabFromPayload(resolvePlaceableSurfacePayload(raw, surfaces), 'invocation');
    if (!replacement) return false;
    const { id: _replacementId, ...patch } = replacement;
    layoutActions.updateTabMeta(replacedTabId, patch);
    return true;
  }
  const resolvedSurface = surfaceForPayload(
    surfaces,
    requestedPayload,
  );
  const initialArrangement = resolvedSurface ? readInitialArrangementState(resolvedSurface) : null;
  if (initialArrangement) {
    layoutActions.applyLayoutState(initialArrangement);
    return true;
  }
  // Dedupe-on-open: unless the surface DATA opts into multiple tabs
  // (openMode: 'new-tab'), focus an already-open instance instead of spawning a
  // duplicate. This is what bounds tab accumulation — opening "Chat" twice gives
  // one Chat tab, focused.
  // An open that names its own layer (Open as a floating window) always places a new window, even for a screen that
  // is open elsewhere; any other open finds an open tab first. A request carrying the screen's own placement (its row
  // opened by its address, which copies open_placement along) is a catalog open: it finds the window already open
  // instead of stacking another on every visit.
  const ownLayer = requestedPayload?.openPlacement ?? null;
  const requestedLayer = ownLayer && JSON.stringify(ownLayer) !== JSON.stringify(resolvedSurface?.openPlacement ?? null) ? ownLayer : null;
  if (resolvedSurface && !requestedLayer && (deduplicate || resolvedSurface.openMode !== 'new-tab')) {
    // A material-addressed request with surface input is one semantic instance
    // of the owner surface. Match its owner mount plus opaque input so the same
    // subject refocuses across producers while a different subject opens
    // independently. Static catalog opens retain one-tab-per-surface behavior.
    const requestedTab = requestedPayload?.surfaceInput
      ? readPlaceableSurfaceTabFromPayload(resolvePlaceableSurfacePayload(raw, surfaces))
      : null;
    const open = requestedTab
      ? findTabMatchingTab(layoutState, requestedTab)
      : findOpenSurfaceTab(layoutState, resolvedSurface);
    if (open) {
      focusOrPlaceExistingTab(layoutActions, layoutState, open, requestedPayload, targetContainerId);
      return true;
    }
  }
  // A surface that shows one thing, named by its address (`/decisions/<id>`), is never opened without that thing: a
  // tab with no input to show would only say it could not load. Asked for by name, it showed an open tab above or
  // opens nothing.
  const addressInput = resolvedSurface?.addressInput;
  const input = requestedPayload?.surfaceInput ?? resolvedSurface?.surfaceInput;
  if (addressInput && !(input && typeof input[addressInput] === 'string' && input[addressInput])) return false;
  const tab = readPlaceableSurfaceTabFromPayload(
    resolvePlaceableSurfacePayload(raw, surfaces),
    requestedPayload?.surfaceInput ? 'invocation' : 'catalog',
  );
  if (!tab) return false;
  // Payload-identity dedupe: a payload that resolves to no catalog surface
  // (self-describing intent payloads) still has a stable identity, namely the
  // stamped placeable_surface_id or its mount contract. Without this branch
  // the catalog-keyed dedupe above never fires for such payloads and every
  // open mints a duplicate tab.
  if (!requestedLayer && (deduplicate || !resolvedSurface)) {
    const open = findTabMatchingTab(layoutState, tab);
    if (open) {
      focusOrPlaceExistingTab(layoutActions, layoutState, open, requestedPayload, targetContainerId);
      return true;
    }
  }
  // Surface DATA may ask a catalog open to become a picture-in-picture window
  // (open_placement). A request that names its own place (a drop on a
  // container, "open beside", an addressed delivery) keeps that place, and a
  // request carrying its own open_placement (open as a floating window) wins
  // over the surface's.
  const surfacePlacement = resolvedSurface?.openPlacement?.layer === 'overlay'
    && !requestedPayload?.placement
    && !requestedPayload?.placementTargetContainerId
    && !targetContainerId
    ? resolvedSurface.openPlacement
    : null;
  const overlayPlacement = requestedLayer?.layer === 'overlay' ? requestedLayer : surfacePlacement;
  if (overlayPlacement) {
    // `layoutState` is the settled arrangement (createPlaceableSurfaceOpener decides every open against it).
    const viewport = typeof window === 'undefined'
      ? { width: 1280, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight };
    layoutActions.applyLayoutState(placeTabInOverlay(layoutState, tab, overlayPlacement, viewport).state);
    return true;
  }
  const containerId = resolveTargetContainerId(layoutState, requestedPayload?.placementTargetContainerId ?? targetContainerId);
  if (!containerId) return false;
  if (requestedPayload?.placement === 'right' || requestedPayload?.placement === 'below') {
    const dir = requestedPayload.placement === 'right' ? 'row' : 'column';
    // The pane already beside the source takes the new screen as a tab, so a
    // second open from the same list lands next to the first instead of
    // splitting the source again and again.
    const beside = paneBeside(layoutState, containerId, dir);
    if (beside) {
      layoutActions.addSurfaceTab(beside, tab);
      layoutActions.focusContainer(beside);
      revealArrangementContainerAfterLayout(layoutActions, tab.id);
      return true;
    }
    layoutActions.splitContainerWithSurface(containerId, dir, tab, 'after');
    // A newly split pane is created beside the requested source and is already
    // in the current viewport. Waiting for a flush here added a second layout
    // round trip before the surface could paint. Existing-tab moves still use
    // the reveal barrier above because their destination may be off-screen.
    return true;
  }
  const activeTabId = activeTabIdForContainer(layoutState, containerId);
  const activeTab = activeTabId ? layoutState.tabs[activeTabId] : null;
  const placedTabId = activeTabId && activeTab && isEmptySurfaceTab(activeTab) ? activeTabId : tab.id;
  layoutActions.addSurfaceTab(
    containerId,
    activeTabId && isEmptySurfaceTab(activeTab) ? tabWithId(tab, activeTabId) : tab,
  );
  // The pane the screen lands in is where the person is now (a pick in Find anything lands in the pane they were in).
  if (layoutState.focusedContainerId !== containerId) layoutActions.focusContainer(containerId);
  revealArrangementContainerAfterLayout(layoutActions, placedTabId);
  return true;
}

/** Whether a request names something the arrangement can show: a surface it offers, or a mount of its own. */
export function placeableSurfacePayloadOpens(raw: unknown, surfaces: readonly PlaceableSurfaceRecord[]): boolean {
  const payload = readPlaceableSurfacePayloadFromUnknown(raw);
  if (!payload) return false;
  return !!(payload.replacesInstance || payload.target || payload.packageEntry || surfaceForPayload(surfaces, payload));
}

export interface SettledOpenRequest {
  raw: unknown;
  surfaces: readonly PlaceableSurfaceRecord[];
  /** The pane whose row, button or link asked for this open, if any: the open lands beside it. */
  sourceContainerId?: string | null;
  deduplicate?: boolean;
  targetContainerId?: string | null;
}

/**
 * The one way opens reach an arrangement. Each open is decided against the arrangement as it stands once every
 * earlier operation (the opens before it among them) has landed, one after another, so two opens of the same screen
 * with the same input close together (a sidebar click and the tour it starts, the page's address and a saved
 * layout, a return from a payment page) find each other: the first adds the tab, the second shows it. Deciding each
 * against the state last drawn let both see no tab and add two.
 */
export function createPlaceableSurfaceOpener(layoutActions: PlaceableSurfaceOpenActions): (request: SettledOpenRequest) => Promise<boolean> {
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    const opened = queue.then(async () => {
      // A failed earlier operation is that operation's to report; this open still decides against what stands.
      const layoutState = await layoutActions.flush().catch(() => layoutActions.flush());
      return openPlaceableSurfacePayload({
        layoutActions,
        layoutState,
        raw: openBesideSourcePane(request.raw, layoutState, request.sourceContainerId ?? null),
        surfaces: request.surfaces,
        deduplicate: request.deduplicate,
        targetContainerId: request.targetContainerId,
      });
    });
    queue = opened.catch(() => false);
    return opened;
  };
}

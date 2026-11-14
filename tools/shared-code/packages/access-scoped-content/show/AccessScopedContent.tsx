import React from 'react';
import { BookOpen, Download, Map as MapIcon, PlayCircle } from 'lucide-react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Button } from '@/packages/ui/show/button';
import { cardVariants } from '@/packages/ui/show/card';
import { cn } from '@/packages/ui/show/cn';
import { Container } from '@/packages/ui/show/container';
import { PlaceableSurfaceHost } from '@/packages/ui/show/placeable-surface-host';
import { Text } from '@/packages/ui/show/text';
import { NestedNavigationPicker } from '@/packages/ui/show/nested-navigation/NestedNavigationPicker';
import { AppSidebar } from '@/packages/sidebar/show/AppSidebar';
import type { AppSidebarProps } from '@/packages/sidebar/show/AppSidebar';
import defaultSidebarCapabilities from '../../../../edit-a-document-together/data/sidebar-config.json';
import {
  buildProjectedCollectionsNav,
  projectedCollectionsToCatalogItems,
} from '@/packages/sidebar/show/ProjectedCollectionNav';
import {
  accessDecisionIsCurrent,
  readAccessScopedContentProjection,
  renderSurfaceIsValid,
  type AccessScopedContentProjection,
} from '@/packages/access-scoped-content/read-data/read-access-scoped-items';
import {
  decodeTargetValue,
  itemAvailableForViewer,
  type ViewerAccessState,
} from '@/packages/access-scoped-content/read-data/resolve-viewer-access';
import {
  currentBrowserSessionAccessKey,
  currentPresenterBrowserSessionId,
} from '@/packages/account-session/do-work/browser-session-access-key';

const DEFAULT_PROJECTION_ADDRESS = 'package-set-records::access-scoped-content-projection';
const SESSION_ACCESS_TARGET = 'product-access.read-session-access';

function useCompactLearningLayout(): boolean {
  const query = '(max-width: 720px)';
  const [compact, setCompact] = React.useState(() => globalThis.matchMedia?.(query).matches ?? false);
  React.useEffect(() => {
    const media = globalThis.matchMedia?.(query);
    if (!media) return;
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}

// The session this reads was written by the sign-in surface, which addresses a
// browser by the pair account-session owns in browser storage. Reading it by the
// separate localStorage correlation id instead matched nothing and failed at the
// access hash on every visit, so the id and its key both come from that owner.
function currentBrowserSession(): { browser_id: string; session_access_key: string } | null {
  try {
    const browserId = currentPresenterBrowserSessionId().trim();
    const accessKey = currentBrowserSessionAccessKey().trim();
    return browserId && accessKey ? { browser_id: browserId, session_access_key: accessKey } : null;
  } catch {
    return null;
  }
}

async function readViewerAccess(): Promise<ViewerAccessState> {
  const session = currentBrowserSession();
  if (!session) return { status: 'ready', authenticated: false, heldAccessRefs: [] };
  const value = decodeTargetValue(await sendRequestToBitfieldTarget({ target: SESSION_ACCESS_TARGET, payload: session }));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Access could not be checked.');
  const access = value as { authenticated?: unknown; granted_access_refs?: unknown };
  if (typeof access.authenticated !== 'boolean' || !Array.isArray(access.granted_access_refs)
    || !access.granted_access_refs.every(ref => typeof ref === 'string' && ref.trim())) throw new Error('Access could not be checked.');
  if (!access.authenticated && access.granted_access_refs.length) throw new Error('Access could not be checked.');
  return { status: 'ready', authenticated: access.authenticated, heldAccessRefs: access.granted_access_refs };
}

export function resolveViewerItems(
  items: readonly AccessScopedContentProjection[],
  access: ViewerAccessState,
): AccessScopedContentProjection[] {
  return items.map((item) => ({
    ...item,
    available: itemAvailableForViewer(item.available, item.required_access_refs ?? [], access),
  }));
}

export function visibleViewerItems(
  items: readonly AccessScopedContentProjection[],
): AccessScopedContentProjection[] {
  return items.filter(accessDecisionIsCurrent);
}

type ExternalDownload = { fileName: string; label: string; url: string };

function externalDownloadFrom(item: AccessScopedContentProjection | null): ExternalDownload | null {
  const input = item?.render_surface?.surface_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const url = typeof input.download_url === 'string' ? input.download_url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return null;
  const rawName = typeof input.file_name === 'string' ? input.file_name.trim() : '';
  const fileName = rawName && !/[\\/\u0000-\u001f\u007f]/.test(rawName) ? rawName : 'download.zip';
  const label = typeof input.download_label === 'string' && input.download_label.trim()
    ? input.download_label.trim()
    : item?.label ?? 'Download';
  return { fileName, label, url };
}

/** Every item that sits under `rootId`, at any depth, plus the root itself.
 * A surface opened on one program shows that program's contents and nothing
 * from its neighbours. A root nobody names leaves the whole set alone. */
export function itemsUnder(
  items: readonly AccessScopedContentProjection[],
  rootId: string | null,
): AccessScopedContentProjection[] {
  if (!rootId) return [...items];
  const childrenOf = new Map<string, AccessScopedContentProjection[]>();
  for (const item of items) {
    const parent = nonEmpty(item.parent_ref);
    if (!parent) continue;
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(item);
    childrenOf.set(parent, siblings);
  }
  const root = items.find((item) => item.id === rootId || item.content_ref === rootId);
  if (!root) return [...items];
  const kept: AccessScopedContentProjection[] = [root];
  // Breadth-first over the rows themselves, with a seen set, so a row that names
  // its own ancestor as its parent cannot spin this forever.
  const seen = new Set<string>([root.id]);
  for (let index = 0; index < kept.length; index += 1) {
    const node = kept[index];
    for (const child of [...(childrenOf.get(node.id) ?? []), ...(childrenOf.get(node.content_ref) ?? [])]) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      kept.push(child);
    }
  }
  return kept;
}

/** The rail's sections, read from what the rows say contains what.
 *
 * EVERY COURSE IS ITS OWN OPENABLE LIST AND ITS LESSONS ARE THE ROWS INSIDE IT.
 *
 * A course sat in the rail as a single row with a play button, so the only
 * thing a learner could do to a course they had paid for was play it, and
 * everything inside it was unreachable. The rail's own model is exactly what
 * was needed and was not being used: a collection is a named list the learner
 * opens and closes, and items live inside it.
 *
 * The rule is the same at every level: a thing that holds other things is a
 * LIST, a thing that holds nothing is a ROW. So a module inside a course inside
 * a program is drawn exactly the way the program is, and depth is never a number
 * this code has to know.
 *
 * An earlier correction grouped by the OUTERMOST ancestor instead, which gave
 * one flat list per course holding every lesson under it. That reads fine on a
 * course with no modules and silently deletes the middle of every course that
 * has them, which is most of them. It is recorded here because it looks like the
 * fix and is not: preserving depth and preserving one-list-per-course are the
 * same requirement only when nothing is nested. */
export function containmentCollections(
  items: readonly AccessScopedContentProjection[],
  fallbackLabel: string,
  rootId: string | null,
) {
  const byId = new Map<string, AccessScopedContentProjection>();
  for (const item of items) {
    byId.set(item.id, item);
    if (nonEmpty(item.content_ref)) byId.set(item.content_ref, item);
  }
  const parentOf = (item: AccessScopedContentProjection) => {
    const named = nonEmpty(item.parent_ref);
    const parent = named ? byId.get(named) : undefined;
    return parent && parent.id !== item.id ? parent : null;
  };
  const containers = new Set<string>();
  for (const item of items) {
    const parent = parentOf(item);
    if (parent) containers.add(parent.id);
  }
  const byOwnOrder = (
    left: { item: AccessScopedContentProjection; index: number },
    right: { item: AccessScopedContentProjection; index: number },
  ) => {
    const leftOrder = Number.isFinite(left.item.item_order) ? Number(left.item.item_order) : left.index;
    const rightOrder = Number.isFinite(right.item.item_order) ? Number(right.item.item_order) : right.index;
    return leftOrder - rightOrder || left.index - right.index;
  };
  const ordered = [...items]
    .map((item, index) => ({ item, index }))
    .sort(byOwnOrder)
    .map(({ item }) => item);

  const childrenOf = new Map<string | null, AccessScopedContentProjection[]>();
  for (const item of ordered) {
    if (item.id === rootId || item.content_ref === rootId) continue;
    const parent = parentOf(item);
    const under = parent && parent.id !== rootId && parent.content_ref !== rootId ? parent.id : null;
    const siblings = childrenOf.get(under) ?? [];
    siblings.push(item);
    childrenOf.set(under, siblings);
  }

  const lesson = (item: AccessScopedContentProjection) => ({
    id: item.id,
    label: item.label ?? item.id,
    icon: 'PlayCircle',
    disabled: !accessDecisionIsCurrent(item),
  });

  // A thing that holds other things is a list; a thing that holds nothing is a
  // row. The same rule at every level, so a module inside a module inside a
  // program is drawn the same way the program is, and depth is not a number this
  // code ever has to know. `walked` stops a row that names its own ancestor.
  const listFor = (
    container: AccessScopedContentProjection,
    walked: ReadonlySet<string>,
  ): {
    id: string;
    name: string;
    itemFamily: string;
    items: ReturnType<typeof lesson>[];
    collections: ReturnType<typeof listFor>[];
  } => {
    const inside = walked.has(container.id) ? [] : (childrenOf.get(container.id) ?? []);
    const nextWalked = new Set(walked).add(container.id);
    return {
      id: container.id,
      name: container.label ?? container.id,
      itemFamily: 'access-scoped-content.lesson',
      items: inside.filter((child) => !containers.has(child.id)).map(lesson),
      collections: inside
        .filter((child) => containers.has(child.id))
        .map((child) => listFor(child, nextWalked)),
    };
  };

  const top = childrenOf.get(null) ?? [];
  const loose = top.filter((item) => !containers.has(item.id));
  const lists = top.filter((item) => containers.has(item.id)).map((item) => listFor(item, new Set()));
  return [
    // A library with named programs navigates by those programs. Unrelated
    // top-level proof, service, and offer rows still exist in the library data,
    // but they are not lessons in its course navigator. Inside an opened
    // program, direct lessons remain reachable beside any nested modules.
    ...(loose.length > 0 && (rootId !== null || lists.length === 0)
      ? [{
          id: '__loose__',
          name: fallbackLabel,
          itemFamily: 'access-scoped-content.lesson',
          items: loose.map(lesson),
          collections: [],
        }]
      : []),
    ...lists,
  ];
}

export function filterItemsWithAncestors(
  items: readonly AccessScopedContentProjection[],
  query: string,
): AccessScopedContentProjection[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  const byId = new Map<string, AccessScopedContentProjection>();
  for (const item of items) {
    byId.set(item.id, item);
    if (nonEmpty(item.content_ref)) byId.set(item.content_ref, item);
  }
  const kept = new Set<AccessScopedContentProjection>();
  for (const item of items) {
    if (!`${item.label ?? ''} ${item.summary ?? ''} ${item.content_ref ?? ''}`.toLowerCase().includes(needle)) continue;
    let current: AccessScopedContentProjection | undefined = item;
    while (current && !kept.has(current)) {
      kept.add(current);
      current = byId.get(nonEmpty(current.parent_ref) ?? '');
    }
  }
  return items.filter((item) => kept.has(item));
}

export function contentCollections(
  items: readonly AccessScopedContentProjection[],
  fallbackLabel: string,
) {
  const collections = new Map<string, {
    id: string;
    name: string;
    order: number;
    firstIndex: number;
    items: AccessScopedContentProjection[];
  }>();
  items.forEach((item, index) => {
    const id = nonEmpty(item.collection_ref) ?? 'lessons';
    const name = nonEmpty(item.collection_label) ?? fallbackLabel;
    const order = Number.isFinite(item.collection_order) ? Number(item.collection_order) : index;
    const collection = collections.get(id) ?? { id, name, order, firstIndex: index, items: [] };
    collection.items.push(item);
    collections.set(id, collection);
  });
  return [...collections.values()]
    .sort((left, right) => left.order - right.order || left.firstIndex - right.firstIndex)
    .map((collection) => ({
      id: collection.id,
      name: collection.name,
      itemFamily: 'access-scoped-content.lesson',
      items: collection.items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => {
          const leftOrder = Number.isFinite(left.item.item_order) ? Number(left.item.item_order) : left.index;
          const rightOrder = Number.isFinite(right.item.item_order) ? Number(right.item.item_order) : right.index;
          return leftOrder - rightOrder || left.index - right.index;
        })
        .map(({ item }) => ({
          id: item.id,
          label: item.label ?? item.id,
          icon: 'PlayCircle',
          disabled: !accessDecisionIsCurrent(item),
        })),
    }));
}

function ViewerAccessNotice({ access, onRetry }: { access: ViewerAccessState; onRetry: () => void }) {
  const title = access.status === 'loading'
    ? 'Checking your access…'
    : access.status === 'error'
      ? 'We could not check your access.'
      : access.authenticated
        ? 'This download is included after purchase.'
        : 'Sign in to open your purchased downloads.';
  const detail = access.status === 'loading'
    ? 'This usually takes a moment.'
    : access.status === 'error'
      ? 'Nothing has been unlocked. Try the check again.'
      : access.authenticated
        ? 'Your account does not have this purchase yet.'
        : 'Use the same account you used at checkout.';
  return (
    <Container layout="vertical" gap="sm" padding="xl" border="all" rounded="lg" aria-live="polite" data-access-scoped-viewer-state={access.status}>
      <Text variant="heading-md" color="strong">{title}</Text>
      <Text variant="body" color="secondary">{detail}</Text>
      {access.status === 'error' ? <Button variant="secondary" onClick={onRetry}>Try again</Button> : null}
    </Container>
  );
}

export type AccessScopedSurfaceInput = {
  access_item_id?: string;
  content_ref?: string;
  access_projection_address_label?: string;
  /** Which rail abilities this placement offers, as DATA. Absent means the
   * package's own default, which is all of them. */
  sidebar_capabilities?: AppSidebarProps['capabilities'];
  path_surface?: {
    package_entry?: { package_name?: string; entry_name?: string };
    material_target?: string;
    target?: string;
    surface_input?: Record<string, unknown>;
  };
};

export type AccessScopedContentProps = {
  items?: readonly AccessScopedContentProjection[];
  onOpenItem?: (item: AccessScopedContentProjection) => void | Promise<void>;
  projectionSource?: unknown;
  surfaceInput?: AccessScopedSurfaceInput;
  title?: string;
};

export function AccessScopedContent({
  items: explicitItems,
  onOpenItem,
  projectionSource,
  surfaceInput,
  title = 'Learn',
}: AccessScopedContentProps) {
  const addressLabel = nonEmpty(surfaceInput?.access_projection_address_label) ?? DEFAULT_PROJECTION_ADDRESS;
  const runtimeSource = useBitfieldData({
    input: 'access-projection-by-address-label',
    params: { addressLabel },
  });
  const authoredItems = React.useMemo(
    () => explicitItems ? [...explicitItems] : readAccessScopedContentProjection(projectionSource ?? runtimeSource),
    [explicitItems, projectionSource, runtimeSource],
  );
  const requiresViewerAccess = React.useMemo(
    () => authoredItems.some((item) => (item.required_access_refs?.length ?? 0) > 0),
    [authoredItems],
  );
  const [retry, setRetry] = React.useState(0);
  const [access, setAccess] = React.useState<ViewerAccessState>({ status: 'loading', authenticated: false, heldAccessRefs: [] });

  React.useEffect(() => {
    let cancelled = false;
    if (!requiresViewerAccess) {
      setAccess({ status: 'ready', authenticated: false, heldAccessRefs: [] });
      return () => { cancelled = true; };
    }
    setAccess({ status: 'loading', authenticated: false, heldAccessRefs: [] });
    void readViewerAccess()
      .then((next) => { if (!cancelled) setAccess(next); })
      .catch(() => { if (!cancelled) setAccess({ status: 'error', authenticated: false, heldAccessRefs: [] }); });
    return () => { cancelled = true; };
  }, [requiresViewerAccess, retry]);

  const items = React.useMemo(() => resolveViewerItems(authoredItems, access), [access, authoredItems]);
  const allRestricted = items.length > 0 && items.every((item) => (item.required_access_refs?.length ?? 0) > 0);
  if (allRestricted && !items.some((item) => item.available)) {
    return <ViewerAccessNotice access={access} onRetry={() => setRetry((value) => value + 1)} />;
  }
  const visibleItems = visibleViewerItems(items);
  return (
    <AccessScopedContentView
      items={visibleItems}
      onOpenItem={onOpenItem}
      surfaceInput={surfaceInput}
      title={title}
    />
  );
}

export function AccessScopedContentView({
  items: providedItems,
  onOpenItem,
  surfaceInput,
  title = 'Learn',
}: Omit<AccessScopedContentProps, 'items'> & { items: readonly AccessScopedContentProjection[] }) {
  const compactLayout = useCompactLearningLayout();
  const requested = surfaceInput?.access_item_id ?? surfaceInput?.content_ref;
  // A surface opened on one program is scoped to that program and everything
  // inside it. Before this, the surface picked ONE row out of the whole library
  // and played it, which is why a program holding dozens of lessons showed a
  // single video and nothing to click into.
  const rootItem = React.useMemo(
    () => (requested ? providedItems.find((item) => item.id === requested || item.content_ref === requested) ?? null : null),
    [providedItems, requested],
  );
  const items = React.useMemo(
    () => itemsUnder(providedItems, rootItem?.id ?? null),
    [providedItems, rootItem],
  );
  const rootId = rootItem?.id ?? null;
  const [selectedId, setSelectedId] = React.useState<string | null>(requested ?? items[0]?.id ?? null);
  React.useEffect(() => {
    if (requested && items.some((item) => item.id === requested || item.content_ref === requested)) {
      setSelectedId(items.find((item) => item.id === requested || item.content_ref === requested)?.id ?? null);
      return;
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) setSelectedId(items[0]?.id ?? null);
  }, [items, requested, selectedId]);

  // Opening a program lands on something playable. The program row itself is a
  // container and often has nothing to play, so the first thing inside it plays
  // instead of the learner meeting "this content is not available right now".
  React.useEffect(() => {
    if (!rootId || selectedId !== rootId) return;
    const root = items.find((item) => item.id === rootId);
    if (root && renderSurfaceIsValid(root.render_surface) && accessDecisionIsCurrent(root)) return;
    const firstInside = items.find((item) => item.id !== rootId && accessDecisionIsCurrent(item));
    if (firstInside) setSelectedId(firstInside.id);
  }, [items, requested, selectedId]);

  // The lesson rail is the OWNED sidebar, and owning it takes four things
  // together, not one.
  //
  // This comment used to say that collapse, width, docking, floating and hiding
  // already worked here. They did not. `AppSidebar` hands back the plain
  // content unless `containerRef`, `instanceId` AND `capabilities` are all
  // present — miss any one and you silently get a static list with no chrome,
  // which is exactly what a learner saw. `presentation="embedded"` was correct
  // and was never the problem; it says WHERE the rail lives, not what it can do.
  //
  // `documents` has had all four since it moved onto this sidebar, which is why
  // its page rail moves and this one did not. What the rail offers is DATA
  // (`data/sidebar-config.json`), overridable per placement, so a surface that
  // wants a fixed rail says so instead of losing the chrome by omission.
  const surfaceRootRef = React.useRef<HTMLElement | null>(null);
  const sidebarCapabilities = surfaceInput?.sidebar_capabilities ?? defaultSidebarCapabilities;
  const [search, setSearch] = React.useState('');
  const [view, setView] = React.useState<'lessons' | 'path'>('lessons');

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const descriptor = selected?.render_surface;
  const available = Boolean(selected && accessDecisionIsCurrent(selected) && renderSurfaceIsValid(descriptor));
  const download = available ? externalDownloadFrom(selected) : null;

  // A single-item program (one video) needs no lesson rail: the player fills the
  // whole surface. A multi-lesson program gets the collapsible lesson rail.

  const filtered = React.useMemo(() => {
    return filterItemsWithAncestors(items, search);
  }, [items, search]);

  // Lessons stay the source of truth; this only projects them. A locked lesson
  // stays VISIBLE and disabled rather than vanishing, because a learner needs to
  // see what the program contains before they can want it.
  const lessonCollections = React.useMemo(() => {
    const byContainment = containmentCollections(filtered, title, rootId);
    // Rows that say nothing about what contains them still group by whatever
    // collection they name, which is what every existing library already does.
    return byContainment.length > 0 ? byContainment : contentCollections(filtered, title);
  }, [filtered, rootId, title]);
  const mobileLessonCollections = React.useMemo(() => {
    const byContainment = containmentCollections(items, title, rootId);
    return byContainment.length > 0 ? byContainment : contentCollections(items, title);
  }, [items, rootId, title]);
  // Keyed on content, never on array identity: the sidebar reacts to graph
  // identity, so an identity-keyed memo would rebuild every render and spin.
  // A program with contents gets the rail, whatever the row count happens to be.
  // The old test asked whether the WHOLE LIBRARY had more than one row, which is
  // false for a program opened on its own and is why the rail disappeared exactly
  // where a learner needed it.
  // Counted through the whole tree. Counting only the top level made a program
  // whose every lesson sits one level down look like it held nothing, and the
  // rail vanished on exactly the deep courses that need it most.
  const countRows = (
    collections: readonly { items: readonly unknown[]; collections?: readonly unknown[] }[],
  ): number => collections.reduce(
    (total, collection) => total + collection.items.length
      + countRows((collection.collections ?? []) as never),
    0,
  );
  const lessonRowCount = countRows(lessonCollections);
  const hasNamedContainer = lessonCollections.some((collection) => collection.id !== '__loose__');
  const isCollection = lessonRowCount > 1 || hasNamedContainer;

  const lessonsSignature = JSON.stringify(
    filtered.map((item) => [item.id, item.label, accessDecisionIsCurrent(item)]),
  );
  const lessonCollectionsRef = React.useRef(lessonCollections);
  lessonCollectionsRef.current = lessonCollections;
  const lessonsSidebar = React.useMemo(() => ({
    graph: buildProjectedCollectionsNav({
      scope: 'access-scoped-content-lessons',
      collections: lessonCollectionsRef.current,
    }),
    catalogItems: projectedCollectionsToCatalogItems(lessonCollectionsRef.current),
  }), [lessonsSignature, title]);

  const player = download ? (
    <Container height="full" minHeight="0" layout="vertical" gap="md" padding="xl" alignItems="start" justifyContent="center">
      <Download aria-hidden="true" />
      <Text variant="heading-md" color="strong">{download.label}</Text>
      {selected?.summary ? <Text variant="body" color="secondary">{selected.summary}</Text> : null}
      <a
        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--text-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--surface-base,#111)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
        data-access-scoped-download={selected?.id}
        download={download.fileName}
        href={download.url}
        rel="noreferrer"
      >
        Download {download.label}
      </a>
      <Text variant="body-sm" color="muted">ZIP file · {download.fileName}</Text>
    </Container>
  ) : available && descriptor ? (
    <PlaceableSurfaceHost
      packageName={descriptor.package_entry.package_name}
      entryName={descriptor.package_entry.entry_name}
      materialTarget={descriptor.material_target}
      target={descriptor.target}
      surfaceInput={descriptor.surface_input}
      fill
      interactive
    />
  ) : (
    <Container height="full" minHeight="0" alignItems="center" justifyContent="center" padding="xl">
      <Text variant="body" color="secondary">This content is not available right now.</Text>
    </Container>
  );

  const stage = (
    <Container
      as="main"
      flex={compactLayout ? 'none' : 1}
      minHeight={compactLayout ? '36rem' : '0'}
      overflow="hidden"
      border="all"
      rounded="lg"
      clearsDockedEdges
    >
      {player}
    </Container>
  );

  const pathSurface = surfaceInput?.path_surface;
  const hasPath = Boolean(
    pathSurface?.package_entry?.package_name
    && pathSurface?.package_entry?.entry_name
    && pathSurface?.material_target,
  );
  const pathStage = hasPath && pathSurface?.package_entry ? (
    <Container as="main" flex={1} minHeight="0" overflow="hidden" border="all" rounded="lg">
      <PlaceableSurfaceHost
        packageName={pathSurface.package_entry.package_name as string}
        entryName={pathSurface.package_entry.entry_name as string}
        materialTarget={pathSurface.material_target as string}
        target={pathSurface.target}
        surfaceInput={pathSurface.surface_input}
        fill
        interactive
      />
    </Container>
  ) : null;

  const header = (
    <Container layout="horizontal" gap="md" minHeight="0" alignItems="center" justifyContent="between" wrap>
      {hasPath ? (
        <Container layout="horizontal" gap="xs" role="group" aria-label="Learning view">
          <Button variant="secondary" size="sm" active={view === 'lessons'} onClick={() => setView('lessons')}>
            <BookOpen aria-hidden="true" size={16} /> Lessons
          </Button>
          <Button variant="secondary" size="sm" active={view === 'path'} onClick={() => setView('path')}>
            <MapIcon aria-hidden="true" size={16} /> Path
          </Button>
        </Container>
      ) : null}
    </Container>
  );

  return (
    <Container
      as="section"
      ref={surfaceRootRef as React.RefObject<HTMLDivElement>}
      data-package="access-scoped-content"
      layout="vertical"
      gap="sm"
      padding="sm"
      height="full"
      minHeight="0"
      width="full"
      overflow="hidden"
    >
      {hasPath ? header : null}
      {items.length === 0 ? (
        <Container border="all" rounded="lg" padding="xl" alignItems="center" justifyContent="center">
          <Text variant="body" color="secondary">Nothing is available here yet.</Text>
        </Container>
      ) : view === 'path' && pathStage ? (
        pathStage
      ) : isCollection && compactLayout ? (
        <Container layout="vertical" flex={1} minHeight="0" gap="sm" overflow="y-auto">
          <NestedNavigationPicker
            collections={mobileLessonCollections}
            selectedId={selected?.id}
            selectedLabel={selected?.label ?? 'Choose a lesson'}
            title="Course contents"
            searchPlaceholder="Search lessons"
            onSelect={(id) => {
              const item = items.find(candidate => candidate.id === id);
              if (!item || !accessDecisionIsCurrent(item)) return;
              setSelectedId(id);
              void onOpenItem?.(item);
            }}
          />
          {stage}
        </Container>
      ) : isCollection ? (
        <Container
          layout="horizontal"
          flex={1}
          minHeight="0"
          gap="sm"
          overflow="hidden"
        >
          <AppSidebar
            scope="access-scoped-content-lessons"
            presentation="embedded"
            instanceId={`access-scoped-content:${rootId ?? 'library'}:lessons`}
            containerRef={surfaceRootRef}
            capabilities={sidebarCapabilities}
            persistPlacement
            surfaceCollectionsGraph={lessonsSidebar.graph}
            catalogItems={lessonsSidebar.catalogItems}
            currentSelectionId={selected?.id ?? ''}
            onNavigate={(id) => {
              const item = items.find(candidate => candidate.id === id);
              if (!item || !accessDecisionIsCurrent(item)) return;
              setSelectedId(id);
              void onOpenItem?.(item);
            }}
            showCollectionManager={false}
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search lessons"
            searchAriaLabel="Search lessons"
            emptyContent={<Text variant="body" color="muted">No matching lessons</Text>}
          />
          {stage}
        </Container>
      ) : (
        stage
      )}
    </Container>
  );
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

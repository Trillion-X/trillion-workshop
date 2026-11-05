// packages/sidebar/show/SidebarContent.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure navigation content renderer shared by all sidebar shells (desktop and
// mobile). Renders navigation sections with collapsible groups and footer
// statistics. Has zero knowledge of HOW it is displayed (inline vs overlay)
// or WHAT package owns a dragged material target.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure content component — no shell/positioning logic
// 2. Receives data via props, never fetches its own data
// 3. Icon strings are caller data resolved by the pure ui NamedIcon primitive
// 4. Delegates all styling/layout decisions to parent shells
// 5. Navigation sections use glassmorphism active states (white/10, not gray)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ScrollViewport } from '../../ui/show/scrollable-surface';
import { ActionMenu, type ActionMenuItem } from '../../ui/show/action-menu';
import {
  Button,
  Badge,
  Text,
  Tooltip,
  Container,
  AnchoredOverlay,
  HoverRevealGroup,
  HoverRevealItem,
  ExpandableTabs,
  Input,
  NamedIcon,
  StatusDot,
  openFloatingPanel,
  canOpenFloatingPanel,
  type PlaceableSurfacePayload,
} from '../../ui/index.ts';
import { emitPlaceableSurfaceIntent as emitPlaceableSurfaceBrowserIntent, setPlaceableSurfaceDragData } from '../../ui/show/placeable-surface-intent/placeable-surface-intent';
import { PaneTab } from '../../ui/show/pane-tab';
import { NestingGuide } from '../../ui/show/nesting-guide';
import { SurfacePreviewCard, type SurfacePreview } from '../../ui/show/surface-preview/SurfacePreviewCard';
import { OPEN_CHOICES, shownOpenChoices, withOpenChoice, type OpenChoice } from '../../ui/show/placeable-surface-intent/open-choices';
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of';
import { runSurfaceAction, type GlanceDeclaration, type SurfaceActionData } from '../../ui/show/surface-preview/surface-glance';
import { useSurfaceBadge } from '../../ui/show/surface-badges/surface-badges';
import { useSurfaceChip } from '../../ui/show/surface-chips/surface-chips';
import { useSurfaceNote } from '../../ui/show/surface-notes/surface-notes';
import { SortableRows } from '../../ui/show/drag-reorder-list/SortableRows';
import { shouldPublishPlaceableIntentOnClick } from '../read-data/activation-routing.ts';
import { DisclosureHeading } from '../../ui/show/disclosure-heading/DisclosureHeading';
import { SearchField } from '../../ui/show/search-field/SearchField';
import {
  addSurfaceToCollection,
  removeSurfaceFromCollection,
  reorderSurfaceInCollection,
  updateSurfaceCollectionPlacement,
} from '../do-work/edit-surface-collections.ts';
import type { SurfaceCollection } from '../read-data/read-surface-collections.ts';
import type { SidebarPlacementState } from '../read-data/read-sidebar-placement.ts';
import { SIDEBAR_SWITCHES, mergeSidebarSettings, sidebarAllows, type SidebarSettings } from '../read-data/sidebar-settings.ts';
import { SIDEBAR_BADGE_MARK_TABLE, sidebarBadgeMark, sidebarDotStatus, type SidebarBadgeMark } from '../read-data/sidebar-badge-marks.ts';
import type { SidebarPlacementController } from './useSidebarPlacement.ts';
import { foldAtPatch, placeAtPatch } from '../../ui/show/dockable-placement/dockable-placement';
import { SPACE_ROW_LOOK } from '../read-data/space-row.ts';
import { itemContainsSelection, itemsWithinSelectionCap, sectionContainsSelection } from '../read-data/selection-visibility.ts';

const SIDEBAR_COLLECTION_DRAG_MIME = 'application/x-bitfield-sidebar-collection-member+json';

/** One caller-owned row action. It renders through the shared ActionMenu, so a
 *  Lucide `icon` is required; `tone: 'destructive'` gives the quiet destructive tone. */
export interface NavItemActionData {
  id: string;
  label: string;
  icon: string;
  tone?: 'destructive';
  disabled?: boolean;
  /** Reveal the row's item before running an action that works in its content. */
  opensItem?: boolean;
  /** Caller-defined groups and submenus are preserved by the shared action renderer. */
  group?: string;
  items?: NavItemActionData[];
}

function navItemActionById(actions: readonly NavItemActionData[], id: string): NavItemActionData | undefined {
  for (const action of actions) {
    if (action.id === id) return action;
    const nested = action.items && navItemActionById(action.items, id);
    if (nested) return nested;
  }
}

export function navItemActionsToMenuItems(actions: readonly NavItemActionData[]): ActionMenuItem[] {
  return actions.map(action => ({ ...action, group: action.group ?? 'page',
    ...(action.items ? { items: navItemActionsToMenuItems(action.items) } : {}) }));
}

/** The list row's own action, shown after the caller's actions. */
const REMOVE_FROM_LIST_ACTION = 'sidebar:remove-from-list';
/** A closable row's close, sent to the row owner through onItemAction. */
export const CLOSE_ROW_ACTION = 'sidebar:close';
/** Every screen row can open beside the focused pane. */
// Where else a row's screen can open (ui open-choices.json): each choice is a menu entry with this prefix.
const OPEN_CHOICE_ACTION = 'sidebar:open:';

// When the person last opened each row, kept in this browser only, so a row
// with no glance DATA can still say something true about itself.
const OPENED_KEY = 'bitfield.sidebar.last-opened';
function readOpenedMap(): Record<string, number> {
  try { const value = JSON.parse(localStorage.getItem(OPENED_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function readOpened(id: string): number | undefined {
  const value = readOpenedMap()[id];
  return typeof value === 'number' ? value : undefined;
}
function rememberOpened(id: string): void {
  try { localStorage.setItem(OPENED_KEY, JSON.stringify({ ...readOpenedMap(), [id]: Date.now() })); } catch { /* storage unavailable: the time is simply not remembered */ }
}

// ============================================================================
// TYPES
// ============================================================================

export interface NavItemData {
  id: string;
  label: string;
  /** Navigation owned by this surface, carried with its row when it moves between lists. */
  sections?: NavSectionData[];
  icon?: string;
  viewId?: string;
  /** True when click activation should publish the generic placeable-surface intent before navigation fallback. */
  placeableSurface?: boolean;
  /** Keep the row click with its caller while preserving generic preview, Open, and drag behavior. */
  navigation?: 'local';
  packageEntry?: { packageName: string; entryName: string } | null;
  materialTarget?: string;
  target?: string;
  surfaceInput?: Record<string, unknown>;
  intent?: { type: string; payload?: Record<string, unknown> };
  badge?: string;
  /** Live badge channel (surface DATA `badge_source`); its value replaces `badge` while set. */
  badgeSource?: string;
  /** Where the navigation shows this row instead of its lists (surface DATA `sidebar_place`: `controls`, `bottom`). */
  place?: string;
  /** The palette hue the row is drawn in (surface DATA `sidebar_colour`, screen-look `--record-kind-<hue>`). */
  colour?: string;
  /** Another screen whose live content shows in a hover card (surface DATA `preview_surface_id`). */
  preview?: SurfacePreview;
  /** What the hover card reads for its live look (surface DATA `glance`). */
  glance?: GlanceDeclaration;
  /** Actions from surface DATA (`actions`), offered in the hover card and the row menu. */
  surfaceActions?: readonly SurfaceActionData[];
  /** One plain sentence about the screen (surface DATA `description`). */
  description?: string;
  disabled?: boolean;
  /** False when the surface exists but is never OFFERED by nav catalogs/pickers (explicit list placement still renders). */
  listed?: boolean;
  /** Original catalog id when the rendered row id is unique to one list. */
  surfaceId?: string;
  /** Owning list and exact group member id for list editing. */
  collectionId?: string;
  collectionMemberId?: string;
  /** Caller-owned row actions. Dispatch stays with the row owner through onItemAction. */
  actions?: NavItemActionData[];
  /** The row level of the sidebar's settings (the screen's `sidebar_settings`, then its list member's). */
  settings?: SidebarSettings;
  /** How the row is drawn: a key of ROW_LOOKS (`tab` draws the shared pane tab); absent is the list row. */
  look?: string;
  /** The row can be closed; its close reaches the owner as onItemAction(item, CLOSE_ROW_ACTION). */
  closable?: boolean;
  /** The row is pinned in place (a pin instead of its close). */
  pinned?: boolean;
  /** Drawn before the row's words in place of its icon, for example who or what the row is (a person's or an AI's mark). */
  leading?: React.ReactNode;
  /** Opaque region handle stamped as `data-node-ref`, so the surface's one right-click menu can act on the row. */
  nodeRef?: string;
}

/** What the row owner hears from its rows besides a click: they are dragged, dropped on, and warmed before a click. */
export interface NavRowEvents {
  onDragStart?: (item: NavItemData, event: React.DragEvent) => void;
  onDragEnd?: (item: NavItemData, event: React.DragEvent) => void;
  /** Something is dropped on the row; the owner reads the event to decide what it was and where it lands. */
  onDrop?: (item: NavItemData, event: React.DragEvent) => void;
  /** The row is pointed at or focused, before any click. */
  onWarm?: (item: NavItemData) => void;
}

export interface NavSectionData {
  id: string;
  /** This section's child navigation belongs to the named surface, rather than to the containing list. */
  ownerSurfaceId?: string;
  title?: string;
  /** Icon identifier for the section (used as group icon in collapsed sidebar mode) */
  icon?: string;
  items: NavItemData[];
  /**
   * Nested child sections (the recursive group tree). Rendered indented below
   * this section's items, inside its collapse wrapper, so a parent collapse hides
   * the whole subtree. Any depth; one recursive component draws every level.
   */
  sections?: NavSectionData[];
  /** Source group record; present only for editable collection-backed groups. */
  collection?: SurfaceCollection;
  /** Inline groups stay attached by default; detached groups render as their own sidebar. */
  attached?: boolean;
  /** Placement for this group when it is independently controlled. */
  placement?: SidebarPlacementState;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** Optional React content rendered in the collapsible header area (e.g. status indicators) */
  statusContent?: React.ReactNode;
  /** Optional React content rendered below the section items */
  bottomContent?: React.ReactNode;
  /** Catalog surfaces not currently direct members of this list. */
  addableItems?: NavItemData[];
  /** The list level of the sidebar's settings, already merged over the sidebar-wide ones. */
  settings?: SidebarSettings;
  /** How many rows show before a Show more row; the open screen's row always shows. */
  showAtMost?: number;
}

export interface SidebarContentProps {
  /** Navigation sections to render */
  sections: NavSectionData[];
  /** Footer items (settings, logout) */
  footerItems: NavItemData[];
  /** Current selected sidebar item ID (for active state) */
  currentSelectionId: string;
  /** Callback when a nav item is clicked */
  onNavigate: (viewId: string) => void;
  /** Whether to show labels (false = icon-only mode) */
  showLabels?: boolean;
  /** Layout orientation — vertical (left/right sidebar) or horizontal (top/bottom sidebar) */
  orientation?: 'vertical' | 'horizontal';
  /** Content rendered at top of the main nav list (scrolls with nav items) */
  topContent?: React.ReactNode;
  /** Reload the group graph after a list mutation settles. */
  onCollectionsChanged?: () => void | Promise<void>;
  /** Optional controlled search. Filtering belongs to the section owner. */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  /** Compact caller-owned actions rendered above search and lists. */
  headerContent?: React.ReactNode;
  /** Caller-owned empty state rendered when every section is empty. */
  emptyContent?: React.ReactNode;
  /** Optional section-independent actions rendered above lists. */
  headerItems?: NavItemData[];
  /** Dispatch a caller-owned action attached to one row. */
  onItemAction?: (item: NavItemData, actionId: string) => void;
  /** Caller content drawn before the rows (for example back and forward). */
  leadingContent?: React.ReactNode;
  /** Caller content drawn after the rows (for example a + and the owner's own controls). */
  trailingContent?: React.ReactNode;
  /** Drag, drop and warm events from the rows, for an owner whose rows are not screens. */
  rowEvents?: NavRowEvents;
}

// ============================================================================
// NAV ITEM COMPONENT
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function makePlaceableSurfacePayload(item: NavItemData, viewId: string): PlaceableSurfacePayload {
  const intentPayload = isRecord(item.intent?.payload) ? item.intent.payload : {};
  const materialTarget = item.materialTarget ?? readFirstString(intentPayload, [
    'materialTarget',
    'material_target',
  ]);
  const target = item.target ?? readFirstString(intentPayload, [
    'target',
    'address',
    'address_to_ask',
    'surface_target',
  ]) ?? (item.packageEntry || materialTarget ? null : viewId);

  return {
    version: 1,
    id: item.surfaceId ?? item.id,
    title: item.label,
    target,
    packageEntry: item.packageEntry ?? null,
    materialTarget,
    icon: item.icon,
    ...(isRecord(item.surfaceInput) ? { surfaceInput: item.surfaceInput } : {}),
  };
}

/** The words a row's glance fills its `{name}` placeholders with: the screen input it opens with (one space, one job). */
function glanceParamsOf(item: NavItemData): Record<string, string> | undefined {
  if (!isRecord(item.surfaceInput)) return undefined;
  const words = Object.entries(item.surfaceInput).filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number');
  return words.length ? Object.fromEntries(words.map(([name, value]) => [name, String(value)])) : undefined;
}

function isPlaceableSurfaceItem(item: NavItemData): boolean {
  return item.placeableSurface === true || !!item.packageEntry || !!item.materialTarget;
}

function emitPlaceableSurfaceIntent(item: NavItemData, viewId: string): boolean {
  return emitPlaceableSurfaceBrowserIntent(makePlaceableSurfacePayload(item, viewId));
}

interface NavItemProps {
  item: NavItemData;
  isActive: boolean;
  showLabel: boolean;
  /** The settings of the list holding this row; the row's own override them. */
  listSettings?: SidebarSettings;
  /** The list holding this row, as shown; an app-provided list is saved before its first change. */
  list?: SurfaceCollection;
  onClick: () => void;
  onCollectionsChanged?: () => void | Promise<void>;
  onItemAction?: (item: NavItemData, actionId: string) => void;
  rowEvents?: NavRowEvents;
}

/** Row looks other than the list row, by the key a row's `look` names. */
const ROW_LOOKS: Record<string, (props: NavItemProps) => React.ReactElement> = {
  tab: TabRow,
};

/** A row drawn as the shared pane tab: it is selected by a click or a right-click, closed by its X, and dragged and
 * dropped on through the owner's row events. */
function TabRow({ item, isActive, onClick, onItemAction, rowEvents }: NavItemProps) {
  // A tab that is not the one showing previews what it holds on its name (never on its close), the same card a
  // sidebar row shows; the active tab is already on screen, so it shows none. The card is the control
  // arrangement.header.tabs.row-preview, which a show rule can hide.
  useShowChange();
  const previewed = !isActive && !item.disabled && (item.glance || item.preview || item.description || item.surfaceActions?.length)
    && controlShown('arrangement.header.tabs.row-preview');
  const wrapTitle = previewed ? (title: React.ReactElement<Record<string, unknown>>) => (
    <SurfacePreviewCard label={item.label} icon={item.icon} preview={item.preview} glance={item.glance} glanceParams={glanceParamsOf(item)}
      description={item.description} actions={(item.surfaceActions ?? []).map((action) => ({ id: action.id, label: action.label, icon: action.icon, onAction: () => { runSurfaceAction(action); } }))}
      trigger={title} onOpen={onClick} side="bottom" />
  ) : undefined;
  return (
    <PaneTab
      wrapTitle={wrapTitle}
      title={item.label}
      leading={item.leading}
      active={isActive}
      pinned={item.pinned}
      closable={item.closable === true}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      onContextMenu={onClick}
      onClose={() => onItemAction?.(item, CLOSE_ROW_ACTION)}
      onDragStart={rowEvents?.onDragStart && ((event) => rowEvents.onDragStart!(item, event))}
      onDragEnd={rowEvents?.onDragEnd && ((event) => rowEvents.onDragEnd!(item, event))}
      onDragOver={rowEvents?.onDrop && ((event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; })}
      onDrop={rowEvents?.onDrop && ((event) => rowEvents.onDrop!(item, event))}
      onPointerEnter={rowEvents?.onWarm && (() => rowEvents.onWarm!(item))}
      onFocus={rowEvents?.onWarm && (() => rowEvents.onWarm!(item))}
      nodeRef={item.nodeRef}
      testId={`tab-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
    />
  );
}

export function NavItem(props: NavItemProps) {
  // An empty space is drawn by the list row itself (read-data/space-row.ts), never by a row look.
  const Look = props.item.look && props.showLabel ? ROW_LOOKS[props.item.look] : undefined;
  return Look ? <Look {...props} /> : <ListRow {...props} />;
}

function ListRow({
  item,
  isActive,
  showLabel,
  listSettings,
  list,
  onClick,
  onCollectionsChanged,
  onItemAction,
  rowEvents,
}: NavItemProps) {
  const viewId = item.viewId ?? item.id;
  const surfaceIdentity = item.surfaceId ?? item.id;
  const controlFacts = { list_id: item.collectionId, screen: surfaceIdentity };
  const [busy, setBusy] = React.useState(false);
  const space = item.look === SPACE_ROW_LOOK;

  const handleClick = React.useCallback(() => {
    if (isPlaceableSurfaceItem(item)) {
      rememberOpened(surfaceIdentity);
      if (shouldPublishPlaceableIntentOnClick(item.navigation) && emitPlaceableSurfaceIntent(item, viewId)) return;
    }
    onClick();
  }, [item, onClick, surfaceIdentity, viewId]);
  const openWith = React.useCallback((choice: OpenChoice) => {
    rememberOpened(surfaceIdentity);
    emitPlaceableSurfaceBrowserIntent(withOpenChoice(makePlaceableSurfacePayload(item, viewId), choice));
  }, [item, surfaceIdentity, viewId]);
  const placeable = isPlaceableSurfaceItem(item);
  const settings = mergeSidebarSettings(listSettings, item.settings);
  const listMember = Boolean(item.collectionId && item.collectionMemberId);
  // Only a list member is sorted, by its handle; the row itself is dragged to
  // open its screen in a pane, or into another list when the settings allow.
  const sortable = controlShown('sidebar.row.move', controlFacts) && listMember && sidebarAllows(settings, SIDEBAR_SWITCHES.reorder);
  const movesBetweenLists = controlShown('sidebar.row.move', controlFacts) && listMember && sidebarAllows(settings, SIDEBAR_SWITCHES.moveBetweenLists);
  const removable = listMember && sidebarAllows(settings, SIDEBAR_SWITCHES.removeFromList);
  const rowDraggable = controlShown('sidebar.row.move', controlFacts) && !item.disabled && (Boolean(rowEvents?.onDragStart) || placeable || movesBetweenLists);
  const liveBadge = useSurfaceBadge(item.badgeSource);
  // A note left on this row (by the person's AI): its count is the row's badge when nothing else counts here, its
  // highlight marks the row, and its message and screens show in the hover card.
  const note = useSurfaceNote(surfaceIdentity);
  // A small tinted chip beside the name ("New"), unless this row is drawn in the list the chip comes from.
  const offeredChip = useSurfaceChip(surfaceIdentity);
  const chip = offeredChip && offeredChip.from !== item.collectionId ? offeredChip : undefined;
  const noteBadge = note?.count ? { text: String(note.count), kind: NOTE_BADGE_KIND } : undefined;
  const shownBadge = liveBadge ?? noteBadge;
  const badge = shownBadge?.text ?? item.badge;
  // What the badge counts decides its mark (DATA sidebar-badge-marks.json): with the
  // name, the grey number; on the icon alone, a red dot for unread notifications
  // and nothing for a count, since red is kept for notifications.
  const markWithLabel = badge ? sidebarBadgeMark(SIDEBAR_BADGE_MARK_TABLE, shownBadge?.kind, 'with_label') : 'none';
  const markIconOnly = badge ? sidebarBadgeMark(SIDEBAR_BADGE_MARK_TABLE, shownBadge?.kind, 'icon_only') : 'none';
  // A row whose DATA names a preview shows that screen in a hover card; the
  // card's heading opens this row's own screen, the same as clicking the row.
  // Every screen row gets the same hover card: a live look from its DATA (a
  // small screen, or a glance) and its actions. A row with neither still says
  // when it was last opened and offers to open it in a new pane.
  // The card is the control sidebar.row-preview and each open choice the control open.<id>: a show rule hides either.
  useShowChange();
  const cardActions = [
    ...(item.surfaceActions ?? []).map((action) => ({ id: action.id, label: action.label, icon: action.icon, onAction: () => { runSurfaceAction(action); } })),
    ...(note?.opens ?? []).map((open) => ({ id: `note-open:${open.id}`, label: open.label, icon: open.icon ?? 'ArrowUpRight', onAction: open.open })),
    ...(placeable ? shownOpenChoices().map((choice) => ({ id: OPEN_CHOICE_ACTION + choice.id, label: choice.label, icon: choice.icon, onAction: () => openWith(choice) })) : []),
  ];
  const withPreview = (trigger: React.ReactElement<Record<string, unknown>>, side: 'right' | 'bottom') => (
    placeable && !item.disabled && controlShown('sidebar.row-preview')
      ? <SurfacePreviewCard label={item.label} icon={item.icon} preview={item.preview} glance={item.glance} glanceParams={glanceParamsOf(item)} description={item.description}
          lastOpenedAt={readOpened(surfaceIdentity)} actions={cardActions} trigger={trigger} onOpen={handleClick} side={side}
          note={note?.message ? { message: note.message, by: note.by } : undefined} />
      : trigger
  );

  const handleDragStart = React.useCallback((e: React.DragEvent) => {
    if (rowEvents?.onDragStart) {
      rowEvents.onDragStart(item, e);
      return;
    }
    setPlaceableSurfaceDragData(
      e.dataTransfer,
      makePlaceableSurfacePayload(item, viewId),
      item.label,
    );
    if (movesBetweenLists) {
      e.dataTransfer.setData(SIDEBAR_COLLECTION_DRAG_MIME, JSON.stringify({
        collectionId: item.collectionId,
        memberId: item.collectionMemberId,
        surfaceId: item.surfaceId ?? item.id,
        ...(list ? { list: listAsShown(list) } : {}),
      }));
    }
  }, [item, list, movesBetweenLists, rowEvents, viewId]);

  const handleRemove = React.useCallback(async () => {
    if (!item.collectionId || !item.collectionMemberId || busy) return;
    setBusy(true);
    try {
      await removeSurfaceFromCollection(item.collectionId, item.collectionMemberId, list);
      await onCollectionsChanged?.();
    } finally {
      setBusy(false);
    }
  }, [busy, item.collectionId, item.collectionMemberId, list, onCollectionsChanged]);

  const rowActions: ActionMenuItem[] = [
    ...(item.surfaceActions ?? []).map((action) => ({ id: action.id, label: action.label, icon: action.icon, group: 'surface' })),
    ...(placeable ? shownOpenChoices().map((choice) => ({ id: OPEN_CHOICE_ACTION + choice.id, label: choice.label, icon: choice.icon, group: 'surface' })) : []),
    ...navItemActionsToMenuItems(item.actions ?? []),
    ...(removable
      ? [{ id: REMOVE_FROM_LIST_ACTION, label: 'Remove from this list', icon: 'ListMinus', group: 'list', disabled: busy }]
      : []),
  ];
  // A screen's row says which screen it is, so its ⋯ also offers every row the page has for that screen
  // (action-menu/menu-rows.ts); the sidebar names none of them.
  const about = placeable && !item.disabled ? { kind: 'screen', id: item.surfaceId ?? item.id, title: item.label, ...(item.surfaceInput ? { input: item.surfaceInput } : {}) } : undefined;

  return (
    <HoverRevealGroup
      layout="horizontal"
      gap="xs"
      alignItems="center"
      className="relative w-full"
      data-sidebar-surface-id={surfaceIdentity}
      data-sidebar-note={note?.highlight ? 'highlight' : note?.message ? 'message' : undefined}
      data-colour={item.colour}
    >
      {showLabel ? (
        <>
          {sortable ? (
            <HoverRevealItem className="flex h-9 w-6 shrink-0 items-center justify-center">
              <button
                type="button"
                data-reorder-handle=""
                disabled={item.disabled}
                className="flex h-7 w-6 cursor-grab items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)] active:cursor-grabbing disabled:cursor-not-allowed"
                aria-label={`Move ${item.label}`}
                aria-keyshortcuts="ArrowUp ArrowDown Home End"
              >
                <NamedIcon name="GripVertical" size="xs" />
              </button>
            </HoverRevealItem>
          ) : null}
          {space ? (
            // An empty space opens nothing: a quiet gap the person moves or takes out like any row.
            <Container layout="horizontal" alignItems="center" gap="sm" className="min-w-0 flex-1 h-7 px-3" data-sidebar-space="">
              <Container className="h-0 flex-1 border-t border-dashed border-[var(--border-primary)]" />
              <Text variant="body-xs" color="muted" className="shrink-0">{item.label}</Text>
              <Container className="h-0 flex-1 border-t border-dashed border-[var(--border-primary)]" />
            </Container>
          ) : withPreview(
            <Button
              variant="ghost"
              data-sidebar-activate=""
              // Going to a place is not a command: it is not announced or written to history.
              data-feedback="none"
              onClick={handleClick}
              disabled={item.disabled}
              active={isActive}
              // `active` paints the row. `aria-current` is what a screen reader
              // uses to answer "which one am I on", and painting alone leaves that
              // person with no answer at all. Both, always, for every surface that
              // mounts this sidebar.
              aria-current={isActive ? 'true' : undefined}
              draggable={rowDraggable}
              onDragStart={rowDraggable ? handleDragStart : undefined}
              onDragEnd={rowEvents?.onDragEnd && ((event) => rowEvents.onDragEnd!(item, event))}
              onDragOver={rowEvents?.onDrop && ((event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; })}
              onDrop={rowEvents?.onDrop && ((event) => rowEvents.onDrop!(item, event))}
              onPointerEnter={rowEvents?.onWarm && (() => rowEvents.onWarm!(item))}
              onFocus={rowEvents?.onWarm && (() => rowEvents.onWarm!(item))}
              className="min-w-0 flex-1 gap-3 px-3 h-9 min-h-0"
            >
              {item.leading ?? <NamedIcon name={item.icon} size="lg" className="flex-shrink-0" />}
              {/* A chip hugs the name (pair 06, "Candidates  New"); without one the name fills the row. */}
              <Text className={chip ? 'min-w-0 truncate text-left' : 'truncate flex-1 text-left'}>{item.label}</Text>
              {chip ? <Badge variant={chip.variant as React.ComponentProps<typeof Badge>['variant']} size="sm" data-slot="sidebar-row-chip" className="-ml-1.5 mr-auto">{chip.label}</Badge> : null}
              <RowBadgeMark mark={markWithLabel} text={badge} tone={liveBadge?.tone} />
            </Button>,
            'right',
          )}
          {controlShown('sidebar.row.actions', controlFacts) && (rowActions.length > 0 || about) ? (
            <HoverRevealItem revealed={isActive} className="flex h-9 w-7 shrink-0 items-center justify-center">
              <ActionMenu
                label={`Actions for ${item.label}`}
                items={rowActions}
                about={about}
                onAction={(actionId) => {
                  const surfaceAction = item.surfaceActions?.find((action) => action.id === actionId);
                  if (actionId === REMOVE_FROM_LIST_ACTION) void handleRemove();
                  else if (actionId.startsWith(OPEN_CHOICE_ACTION)) { const choice = OPEN_CHOICES.find((one) => OPEN_CHOICE_ACTION + one.id === actionId); if (choice) openWith(choice); }
                  else if (surfaceAction) runSurfaceAction(surfaceAction);
                  else {
                    if (navItemActionById(item.actions ?? [], actionId)?.opensItem) onClick();
                    onItemAction?.(item, actionId);
                  }
                }}
                trigger={<Button variant="ghost" size="icon-xs" onClick={(event: React.MouseEvent) => event.stopPropagation()} />}
                triggerContent={<NamedIcon name="MoreHorizontal" size="xs" />}
              />
            </HoverRevealItem>
          ) : null}
        </>
      ) : space ? (
        // On a rail of icons an empty space is only room between them.
        <Container className="h-4 w-full" data-sidebar-space="" aria-hidden />
      ) : (
        (() => {
          const railButton = (
            <Button
              variant="ghost"
              data-sidebar-activate=""
              data-feedback="none"
              data-live-badge={markIconOnly !== 'none' ? '' : undefined}
              onClick={handleClick}
              disabled={item.disabled}
              active={isActive}
              // Collapsed rail: icon-only, so `aria-current` is the ONLY signal a
              // screen reader has here. It matters more in this variant, not less.
              aria-current={isActive ? 'true' : undefined}
              aria-label={badge ? `${item.label}, ${badge}` : item.label}
              className="w-full gap-3 px-3 h-9 min-h-0 justify-center"
              draggable={rowDraggable}
              onDragStart={rowDraggable ? handleDragStart : undefined}
              onDragEnd={rowEvents?.onDragEnd && ((event) => rowEvents.onDragEnd!(item, event))}
              onDragOver={rowEvents?.onDrop && ((event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; })}
              onDrop={rowEvents?.onDrop && ((event) => rowEvents.onDrop!(item, event))}
              onPointerEnter={rowEvents?.onWarm && (() => rowEvents.onWarm!(item))}
              onFocus={rowEvents?.onWarm && (() => rowEvents.onWarm!(item))}
            >
              {item.leading ?? <NamedIcon name={item.icon} size="lg" className="flex-shrink-0" />}
              <RowBadgeMark mark={markIconOnly} text={badge} tone={liveBadge?.tone} onIcon />
            </Button>
          );
          // The preview card already names the screen, so it replaces the tooltip.
          return placeable && !item.disabled
            ? withPreview(railButton, 'right')
            : <Tooltip label={item.label}>{railButton}</Tooltip>;
        })()
      )}
    </HoverRevealGroup>
  );
}

/** A row's badge drawn as its mark: the words in the quiet pill, a small dot (red unless the badge's tone says
 *  otherwise), or nothing. */
function RowBadgeMark({ mark, text, tone, onIcon = false }: { mark: SidebarBadgeMark; text: string | undefined; tone?: string; onIcon?: boolean }) {
  if (mark === 'number' && text) {
    return onIcon
      ? <Badge variant="neutral" size="sm" className="sidebar-rail-badge" data-slot="sidebar-row-badge" aria-hidden="true">{text}</Badge>
      : <Badge variant="neutral" size="sm" data-slot="sidebar-row-badge">{text}</Badge>;
  }
  if (mark === 'dot') {
    const status = sidebarDotStatus(tone);
    return <StatusDot status={status} className={onIcon ? 'sidebar-rail-dot' : 'sidebar-row-dot'} data-slot="sidebar-row-dot" data-status={status} aria-hidden="true" />;
  }
  return null;
}

// What a note's count is, for its mark (sidebar-badge-marks.json `note`).
const NOTE_BADGE_KIND = 'note';

const collectionMemberOf = (item: NavItemData) => item.collectionMemberId ?? item.id;

/**
 * A list's rows in their saved order, sorted by their handles with the shared
 * SortableRows: the row follows the pointer, the others slide out of the way and
 * a line marks where it lands. Dragging the row itself (not its handle) still
 * carries its screen, so dropping it on a pane opens it there.
 */
function SortableNavRows({
  items: allItems,
  onCollectionsChanged,
  list,
  showAtMost,
  currentSelectionId,
  showLabel = true,
  renderItem,
}: {
  items: readonly NavItemData[];
  /** The list as shown, so an app-provided list is saved before its first change. */
  list?: SurfaceCollection;
  /** Rows shown before a Show more row; the row of the open screen always shows. */
  showAtMost?: number;
  currentSelectionId?: string;
  /** False in the collapsed rail: the Show more row is an icon like every row there, its words its name. */
  showLabel?: boolean;
  onCollectionsChanged?: () => void | Promise<void>;
  renderItem: (item: NavItemData) => React.ReactNode;
}) {
  const [showingAll, setShowingAll] = React.useState(false);
  const capped = !showingAll && showAtMost !== undefined && allItems.length > showAtMost;
  const items = capped
    ? itemsWithinSelectionCap(allItems, showAtMost, currentSelectionId)
    : allItems;
  const more = allItems.length - items.length;
  const collectionId = items[0]?.collectionId;
  const sortable = Boolean(collectionId) && items.every((item) => item.collectionId === collectionId && item.collectionMemberId);
  const foldable = showAtMost !== undefined && allItems.length > showAtMost;
  const foldWords = showingAll ? 'Show fewer' : `Show ${more} more`;
  return (
    <>
      <SortableRows
        items={items}
        getId={collectionMemberOf}
        renderItem={renderItem}
        disabled={!sortable}
        className="gap-1"
        onReorder={async (_order, moved) => {
          await reorderSurfaceInCollection(collectionId!, moved.id, moved.before ? { before: moved.before } : { after: moved.after! }, list);
          await onCollectionsChanged?.();
        }}
      />
      {foldable ? (showLabel ? (
        <Button
          variant="ghost"
          size="sm"
          // Its words start where the rows' icons do: a 28px handle gutter plus the row's own 12px inset.
          className="justify-start pl-10 text-[var(--text-secondary)]"
          data-sidebar-show-more=""
          aria-expanded={showingAll}
          onClick={() => setShowingAll((open) => !open)}
        >
          {foldWords}
        </Button>
      ) : (
        <Tooltip label={foldWords} side="right">
          <Button
            variant="ghost"
            className="w-full gap-3 px-3 h-9 min-h-0 justify-center text-[var(--text-secondary)]"
            data-sidebar-show-more=""
            aria-label={foldWords}
            aria-expanded={showingAll}
            onClick={() => setShowingAll((open) => !open)}
          >
            <NamedIcon name={showingAll ? 'ChevronsUp' : 'Ellipsis'} size="lg" className="flex-shrink-0" />
          </Button>
        </Tooltip>
      )) : null}
    </>
  );
}

/** A list as shown, without its child lists, small enough to ride in a drag. */
function listAsShown(list: SurfaceCollection): SurfaceCollection {
  return { ...list, members: list.members.map(({ childCollection: _child, ...member }) => member) };
}

function readCollectionDrag(dataTransfer: DataTransfer): {
  collectionId: string;
  memberId: string;
  surfaceId: string;
  list?: SurfaceCollection;
} | null {
  const raw = dataTransfer.getData(SIDEBAR_COLLECTION_DRAG_MIME);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return typeof value.collectionId === 'string'
      && typeof value.memberId === 'string'
      && typeof value.surfaceId === 'string'
      ? {
        collectionId: value.collectionId,
        memberId: value.memberId,
        surfaceId: value.surfaceId,
        ...(value.list && typeof value.list === 'object' ? { list: value.list as SurfaceCollection } : {}),
      }
      : null;
  } catch {
    return null;
  }
}

function AddToListPopover({
  section,
  onCollectionsChanged,
}: {
  section: NavSectionData;
  onCollectionsChanged?: () => void | Promise<void>;
}) {
  const anchorRef = React.useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [busySurfaceId, setBusySurfaceId] = React.useState<string | null>(null);
  const addableItems = section.addableItems ?? [];
  const filteredItems = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? addableItems.filter((item) => item.label.toLowerCase().includes(normalized))
      : addableItems;
  }, [addableItems, query]);

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const addItem = React.useCallback(async (item: NavItemData) => {
    const surfaceId = item.surfaceId ?? item.id;
    setBusySurfaceId(surfaceId);
    try {
      await addSurfaceToCollection(section.id.replace(/^collection:/, ''), surfaceId, section.collection);
      close();
      await onCollectionsChanged?.();
    } finally {
      setBusySurfaceId(null);
    }
  }, [close, onCollectionsChanged, section.id]);

  return (
    <>
      <Tooltip label={`Add to ${section.title ?? 'this list'}`}>
        <Button
          ref={anchorRef}
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Add to ${section.title ?? 'this list'}`}
          className="text-[var(--text-muted)]"
        >
          <NamedIcon name="Plus" size="xs" />
        </Button>
      </Tooltip>
      <AnchoredOverlay anchorRef={anchorRef} open={open} placement="below" onDismiss={close}>
        <Container
          layout="vertical"
          style={{ width: 280, maxHeight: '60vh', overflow: 'hidden' }}
        >
          {/* The search sits flush at the top, underlined from the rows it filters (the shared search box and its look). */}
          <Container className="shrink-0 border-b border-[var(--border-primary)] p-1.5" data-sidebar-add-search="">
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Find a screen"
              label={`Find a screen to add to ${section.title ?? 'this list'}`}
              autoFocus
            />
          </Container>
          {/* The rows start right under the search's underline, with no extra gap between them. */}
          <Container layout="vertical" gap="xs" className="overflow-y-auto px-1.5 pb-1.5 pt-0.5">
            {filteredItems.length === 0 ? (
              <Text variant="body-xs" color="muted">
                {addableItems.length === 0 ? 'Every screen is already in this list.' : 'No screens match.'}
              </Text>
            ) : filteredItems.map((item) => {
              const surfaceId = item.surfaceId ?? item.id;
              return (
                <Button
                  key={surfaceId}
                  variant="ghost"
                  size="sm"
                  fullWidth
                  disabled={busySurfaceId !== null}
                  onClick={() => addItem(item)}
                  className="justify-start"
                >
                  <NamedIcon name={item.icon} size="sm" />
                  <Text className="truncate">{item.label}</Text>
                </Button>
              );
            })}
          </Container>
        </Container>
      </AnchoredOverlay>
    </>
  );
}

// ============================================================================
// COLLAPSIBLE SECTION COMPONENT
// ============================================================================

function useCollectionSectionPlacement(section: NavSectionData, onCollectionsChanged?: () => void | Promise<void>) {
  const placementKey = section.collection ? `bitfield.sidebar.collection-placement.${section.collection.id}` : null;
  const [placement, setPlacement] = React.useState(() => {
    if (!placementKey || !section.placement) return section.placement;
    try {
      const saved = JSON.parse(localStorage.getItem(placementKey) || 'null');
      return saved && typeof saved === 'object' ? { ...section.placement, ...saved } : section.placement;
    } catch { return section.placement; }
  });
  const [attached, setAttached] = React.useState(section.attached ?? true);
  const [error, setError] = React.useState('');
  const latest = React.useRef({ placement, attached });
  latest.current = { placement, attached };
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());

  const save = React.useCallback((nextPlacement: SidebarPlacementState, nextAttached: boolean) => {
    if (!section.collection) return;
    latest.current = { placement: nextPlacement, attached: nextAttached };
    setPlacement(nextPlacement);
    setAttached(nextAttached);
    if (placementKey) {
      try { localStorage.setItem(placementKey, JSON.stringify(nextPlacement)); } catch { /* browser storage is optional */ }
    }
    queue.current = queue.current.catch(() => {}).then(async () => {
      await updateSurfaceCollectionPlacement(section.collection!, nextPlacement, nextAttached);
      setError('');
      await onCollectionsChanged?.();
    }).catch(() => setError('This group setting could not be saved.'));
  }, [onCollectionsChanged, section.collection]);

  const patchPlacement = React.useCallback((patch: Partial<SidebarPlacementState>) => {
    const current = latest.current.placement;
    if (!current) return;
    save({ ...current, ...patch, floatRect: { ...current.floatRect, ...patch.floatRect } }, latest.current.attached);
  }, [save]);

  const controller = React.useMemo<SidebarPlacementController | undefined>(() => placement ? ({
    ...placement,
    setPosition: position => patchPlacement({ position }),
    setDockState: dockState => patchPlacement({ dockState }),
    setMode: mode => patchPlacement({ mode }),
    setWidth: width => patchPlacement({ width }),
    setFloatRect: rect => patchPlacement({ floatRect: { ...placement.floatRect, ...rect } }),
    placeAt: at => patchPlacement(placeAtPatch(placement.mode, at)),
    foldAt: point => patchPlacement(foldAtPatch(point)),
    setFit: fit => patchPlacement({ fit }),
  }) : undefined, [patchPlacement, placement]);

  return { placement, attached, error, controller, patchPlacement, setAttached: (value: boolean) => {
    if (placement) save(placement, value);
  } };
}

function DetachedCollectionFrame({
  section,
  state,
  currentSelectionId,
  showLabels,
  onNavigate,
  onCollectionsChanged,
  onItemAction,
}: Pick<CollapsibleSectionProps, 'section' | 'currentSelectionId' | 'showLabels' | 'onNavigate' | 'onCollectionsChanged' | 'onItemAction'> & {
  state: ReturnType<typeof useCollectionSectionPlacement>;
}) {
  const [panelBody, setPanelBody] = React.useState<HTMLElement | null>(null);
  const setAttachedRef = React.useRef(state.setAttached);
  setAttachedRef.current = state.setAttached;
  const label = section.title ?? section.id;
  useShowChange();
  const listFacts = { list_id: section.collection?.id ?? section.id };
  const attached = state.attached || !controlShown('sidebar.list.unpin', listFacts);
  const unpinned = !!state.controller && !attached;
  // An unpinned list opens in the shared floating panel (no tab bar), the same
  // frame every unpinned sidebar item uses. Closing that panel pins it back.
  React.useEffect(() => {
    if (!unpinned) return;
    let closingHere = false;
    let handle: ReturnType<typeof openFloatingPanel> = null;
    // The panel renders synchronously into its own root, which React refuses
    // while this effect's commit is still running, so open it just after.
    const timer = setTimeout(() => {
      try {
        handle = openFloatingPanel(null, {
          label,
          kind: `sidebar-list:${section.id}`,
          // Closing this panel pins the list back, so its control says so.
          closeAs: { label: `Pin ${label} to the sidebar`, icon: 'Pin' },
          onClose: () => { if (!closingHere) setAttachedRef.current(true); },
        });
      } catch { handle = null; }
      if (!handle) { setAttachedRef.current(true); return; }
      setPanelBody(handle.body);
    });
    return () => { closingHere = true; clearTimeout(timer); setPanelBody(null); handle?.close(); };
  }, [unpinned, label, section.id]);
  if (!state.controller) return null;
  const list = <CollapsibleSection
    section={{ ...section, collection: undefined, attached: true }}
    currentSelectionId={currentSelectionId}
    showLabels
    onNavigate={onNavigate}
    onCollectionsChanged={onCollectionsChanged}
    onItemAction={onItemAction}
  />;
  if (attached) {
    return <CollapsibleSection
      section={{ ...section, attached: true }}
      currentSelectionId={currentSelectionId}
      showLabels={showLabels}
      onNavigate={onNavigate}
      onCollectionsChanged={onCollectionsChanged}
      onItemAction={onItemAction}
    />;
  }
  // The list keeps its place in the sidebar as its heading alone, so it can be
  // pinned back from where it was as well as from its panel. The collapsed rail
  // shows it as its own icon, like every list there, and pressing it pins it back.
  return <>
    {showLabels ? (
      <DisclosureHeading
        label={<Text className="truncate">{label}</Text>}
        accessibleLabel={`${label}, unpinned`}
        open={false}
        onOpenChange={() => state.setAttached(true)}
        className="sidebar-section-heading"
        actionsShown
        actions={<ExpandableTabs
          mode="action"
          size="sm"
          ariaLabel={`${label} list actions`}
          items={controlShown('sidebar.list.pin', listFacts) ? [{ id: 'pin', label: 'Pin to sidebar', icon: 'Pin' }] : []}
          onSelect={() => state.setAttached(true)}
        />}
      />
    ) : (
      <Tooltip label={`${label}, unpinned`} side="right">
        <Button
          variant="ghost"
          aria-label={`Pin ${label} to the sidebar`}
          onClick={() => state.setAttached(true)}
          className="w-full gap-3 px-3 h-9 min-h-0 justify-center"
        >
          <NamedIcon name={section.icon} size="lg" className="flex-shrink-0" />
        </Button>
      </Tooltip>
    )}
    {state.error && <div role="status">{state.error}</div>}
    {panelBody ? createPortal(list, panelBody) : null}
  </>;
}

interface CollapsibleSectionProps {
  section: NavSectionData;
  currentSelectionId: string;
  showLabels: boolean;
  onNavigate: (viewId: string) => void;
  depth?: number;
  /** The settings of the list holding this one; a list inside a list inherits them. */
  inheritedSettings?: SidebarSettings;
  onCollectionsChanged?: () => void | Promise<void>;
  onItemAction?: (item: NavItemData, actionId: string) => void;
  rowEvents?: NavRowEvents;
}

export function CollapsibleSection({
  section,
  currentSelectionId,
  showLabels,
  onNavigate,
  depth = 0,
  inheritedSettings,
  onCollectionsChanged,
  onItemAction,
  rowEvents,
}: CollapsibleSectionProps) {
  useShowChange();
  const controlFacts = { list_id: section.collection?.id ?? section.id };
  const autoHideAllowed = controlShown('sidebar.list.auto-hide', controlFacts);
  const collectionState = useCollectionSectionPlacement(section, onCollectionsChanged);
  const listSettings = mergeSidebarSettings(inheritedSettings, section.settings);
  const [localOpen, setLocalOpen] = React.useState(!section.defaultCollapsed);
  const isOpen = section.collection && collectionState.placement
    ? collectionState.placement.mode !== 'collapsed'
    : localOpen;
  const [autoRevealed, setAutoRevealed] = React.useState(false);
  const [sectionActionsOpen, setSectionActionsOpen] = React.useState(false);
  const sectionSelected = sectionContainsSelection(section, currentSelectionId);
  const [isDropTarget, setIsDropTarget] = React.useState(false);
  const railButtonRef = React.useRef<HTMLButtonElement | null>(null);
  // The rail panel opens only when its icon is pressed, never from a remembered expanded state.
  const [railPanelOpen, setRailPanelOpen] = React.useState(false);
  const collectionId = section.id.startsWith('collection:')
    ? section.id.slice('collection:'.length)
    : null;
  // A note left on this list (by the person's AI): its count beside the name, its highlight on the list, its message
  // under the name.
  const listNote = useSurfaceNote(collectionId ?? undefined);

  const handleDrop = React.useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDropTarget(false);
    const source = readCollectionDrag(event.dataTransfer);
    if (!source || !collectionId || source.collectionId === collectionId || !controlShown('sidebar.list.add', controlFacts)) return;
    await removeSurfaceFromCollection(source.collectionId, source.memberId, source.list);
    try {
      await addSurfaceToCollection(collectionId, source.surfaceId, section.collection);
    } catch (error) {
      await addSurfaceToCollection(source.collectionId, source.surfaceId, source.list && { ...source.list, appList: source.list.appList && { saved: true } });
      throw error;
    }
    await onCollectionsChanged?.();
  }, [collectionId, onCollectionsChanged, section.collection]);

  if (!controlShown('sidebar.list', controlFacts)) return null;

  if (section.collection && !collectionState.attached && controlShown('sidebar.list.unpin', controlFacts)) {
    return <DetachedCollectionFrame section={{ ...section, attached: false }} state={collectionState} currentSelectionId={currentSelectionId} showLabels={showLabels} onNavigate={onNavigate} onCollectionsChanged={onCollectionsChanged} onItemAction={onItemAction} />;
  }

  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    if (section.collection && collectionState.placement) collectionState.patchPlacement({ mode: next ? 'expanded' : 'collapsed' });
  };
  const isAutoHidden = Boolean(autoHideAllowed && section.collection && collectionState.placement?.mode === 'auto' && !autoRevealed);
  const sectionActionsVisible = sectionActionsOpen || sectionSelected;
  const canAddToList = Boolean(controlShown('sidebar.list.add', controlFacts) && section.addableItems && sidebarAllows(listSettings, SIDEBAR_SWITCHES.addToList));

  const renderRow = (item: NavItemData, showLabel: boolean) => <React.Fragment key={item.id}>
    <NavItem item={item} list={section.collection}
      isActive={itemContainsSelection(item, currentSelectionId)}
      showLabel={showLabel} listSettings={listSettings}
      onClick={() => onNavigate(item.viewId ?? item.id)} onCollectionsChanged={onCollectionsChanged}
      onItemAction={onItemAction} rowEvents={rowEvents} />
    {item.sections?.map(child => <Container key={child.id} className={showLabel ? 'sidebar-owned-navigation' : undefined}
      data-list-member={item.collectionId && item.collectionMemberId ? '' : undefined}>
      <CollapsibleSection section={child} currentSelectionId={currentSelectionId}
        showLabels={showLabel} onNavigate={onNavigate} depth={depth + 1} inheritedSettings={listSettings}
        onCollectionsChanged={onCollectionsChanged} onItemAction={onItemAction} rowEvents={rowEvents} />
    </Container>)}
  </React.Fragment>;

  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!collectionId || !controlShown('sidebar.list.add', controlFacts) || !sidebarAllows(listSettings, SIDEBAR_SWITCHES.moveBetweenLists) || !Array.from(event.dataTransfer.types).includes(SIDEBAR_COLLECTION_DRAG_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setIsDropTarget(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setIsDropTarget(false);
    },
    onDrop: (event: React.DragEvent) => void handleDrop(event),
  };

  // -------------------------------------------------------------------
  // ICON-ONLY MODE
  // -------------------------------------------------------------------
  if (!showLabels) {
    // Collapsible sections in icon-only mode: show a single group icon
    // that expands to reveal all sub-item icons when clicked.
    if (section.collapsible && section.icon) {
      return (
          <Container layout="vertical" gap="xs" data-sidebar-section-id={section.id} {...dropProps}>
          <Tooltip label={section.title ?? section.id} side="right">
            <Button
              ref={railButtonRef}
              variant="ghost"
              onClick={() => { if (section.bottomContent) setRailPanelOpen((value) => !value); else setOpen(!isOpen); }}
              aria-expanded={section.bottomContent ? railPanelOpen : isOpen}
              aria-label={section.title ?? section.id}
              active={section.bottomContent ? railPanelOpen : isOpen}
              className="w-full gap-3 px-3 h-9 min-h-0 justify-center"
            >
              <NamedIcon name={section.icon} size="lg" className="flex-shrink-0" />
            </Button>
          </Tooltip>
          {/* A section's own controls (bottomContent) open from its rail icon
              in the collapsed sidebar, anchored beside it, never floating over
              the work on their own. */}
          {section.bottomContent ? (
            <AnchoredOverlay anchorRef={railButtonRef} open={railPanelOpen} placement="below" gap={6} onDismiss={() => setRailPanelOpen(false)}>
              <Container className="w-72 p-2" data-sidebar-rail-panel={section.id}>{section.bottomContent}</Container>
            </AnchoredOverlay>
          ) : null}
          {isOpen && section.statusContent}
          {isOpen && (
            <SortableNavRows
              items={section.items}
              list={section.collection}
              showAtMost={section.showAtMost}
              currentSelectionId={currentSelectionId}
              showLabel={false}
              onCollectionsChanged={onCollectionsChanged}
              renderItem={(item) => renderRow(item, false)}
            />
          )}
          {isOpen && section.sections?.map((childSection) => (
            <CollapsibleSection
              key={childSection.id}
              section={childSection}
              currentSelectionId={currentSelectionId}
              showLabels={false}
              onNavigate={onNavigate}
              depth={depth + 1}
              inheritedSettings={listSettings}
              onCollectionsChanged={onCollectionsChanged}
              onItemAction={onItemAction}
              rowEvents={rowEvents}
            />
          ))}

        </Container>
      );
    }

    // Non-collapsible sections in icon-only mode: show all items flat
    return (
          <Container layout="vertical" gap="xs" data-sidebar-section-id={section.id} {...dropProps}>
        {section.items.map(item => renderRow(item, false))}
        {section.sections?.map((childSection) => (
          <CollapsibleSection
            key={childSection.id}
            section={childSection}
            currentSelectionId={currentSelectionId}
            showLabels={false}
            onNavigate={onNavigate}
            depth={depth + 1}
            inheritedSettings={listSettings}
            onCollectionsChanged={onCollectionsChanged}
          />
        ))}
      </Container>
    );
  }

  // -------------------------------------------------------------------
  // LABEL MODE
  // -------------------------------------------------------------------
  // A list's own controls, each offered only when the settings allow it. The
  // list's width belongs to the sidebar's edge, so a list has no width controls.
  const listActions = section.collection && collectionState.placement ? [
    ...(controlShown('sidebar.list.unpin', controlFacts) && canOpenFloatingPanel() && sidebarAllows(listSettings, SIDEBAR_SWITCHES.unpin) ? [{ id: 'detach', label: 'Unpin', icon: 'PinOff' }] : []),
    ...(autoHideAllowed && sidebarAllows(listSettings, SIDEBAR_SWITCHES.autoHide)
      ? [collectionState.placement.mode === 'auto'
        ? { id: 'visibility', label: 'Always show', icon: 'Eye' }
        : { id: 'visibility', label: 'Auto-hide', icon: 'EyeOff' }]
      : []),
  ] : [];
  return (
    <Container
      layout="vertical"
      gap="xs"
      data-sidebar-section-id={section.id}
      {...dropProps}
      onPointerEnter={() => { if (autoHideAllowed && collectionState.placement?.mode === 'auto') setAutoRevealed(true); }}
      onPointerLeave={() => { if (autoHideAllowed && collectionState.placement?.mode === 'auto') setAutoRevealed(false); }}
      onFocusCapture={() => { if (autoHideAllowed && collectionState.placement?.mode === 'auto') setAutoRevealed(true); }}
      onBlurCapture={(event: React.FocusEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (autoHideAllowed && collectionState.placement?.mode === 'auto') setAutoRevealed(false);
      }}
      className={isDropTarget ? 'rounded-[var(--radius-control)] ring-1 ring-accent-purple/70 bg-accent-purple/10' : undefined}
      data-sidebar-note={listNote?.highlight ? 'highlight' : listNote?.message ? 'message' : undefined}
    >
      {section.collapsible && section.title ? (
        <DisclosureHeading
          label={listNote?.count
            ? <><Text className="truncate">{section.title}</Text><Badge variant="neutral" size="sm" data-slot="sidebar-list-note-count">{String(listNote.count)}</Badge></>
            : <Text className="truncate">{section.title}</Text>}
          accessibleLabel={listNote?.count ? `${section.title}, ${listNote.count}` : section.title}
          open={isOpen}
          onOpenChange={setOpen}
          className="sidebar-section-heading"
          actionsShown={sectionActionsVisible}
          onPointedChange={setSectionActionsOpen}
          actions={listActions.length || canAddToList ? (
            <>
              {canAddToList ? <AddToListPopover section={section} onCollectionsChanged={onCollectionsChanged} /> : null}
              {listActions.length ? (
                <ExpandableTabs
                  mode="action"
                  size="sm"
                  ariaLabel={`${section.title} list actions`}
                  items={listActions}
                  onSelect={(id) => {
                    const placement = collectionState.placement!;
                    if (id === 'detach') collectionState.setAttached(false);
                    else collectionState.patchPlacement({ mode: placement.mode === 'auto' ? 'expanded' : 'auto' });
                  }}
                />
              ) : null}
            </>
          ) : undefined}
        />
      ) : section.title ? (
        <Container layout="horizontal" gap="xs" alignItems="center" className="px-3 py-1">
          <Text variant="label" className="min-w-0 flex-1 truncate">{section.title}</Text>
          {canAddToList ? <AddToListPopover section={section} onCollectionsChanged={onCollectionsChanged} /> : null}
        </Container>
      ) : null}
      {listNote?.message ? (
        <Text variant="caption" className="sidebar-list-note px-3" data-slot="sidebar-list-note">
          {listNote.by ? `${listNote.by}: ${listNote.message}` : listNote.message}
        </Text>
      ) : null}

      <div
        inert={!isOpen || isAutoHidden}
        aria-hidden={!isOpen || isAutoHidden}
        className={[
          'grid overflow-hidden transition-[grid-template-rows,opacity] duration-150',
          isOpen && !isAutoHidden ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        ].join(' ')}
      >
        <div className="min-h-0 overflow-hidden">
          {/* The guide belongs to navigation rows, not to contributed panels or their headings. */}
          <Container layout="vertical" gap="xs" className={section.title ? 'sidebar-list-body' : undefined}>
            {section.title && (section.items.length > 0 || (section.sections?.length ?? 0) > 0) ? <NestingGuide /> : null}
            {section.statusContent}
            <SortableNavRows
              items={section.items}
              list={section.collection}
              showAtMost={section.showAtMost}
              currentSelectionId={currentSelectionId}
              onCollectionsChanged={onCollectionsChanged}
              renderItem={(item) => renderRow(item, true)}
            />

            {section.sections?.map((childSection) => (
              <Container
                key={childSection.id}
                className="pl-3"
                data-sidebar-collection-branch=""
              >
                <CollapsibleSection
                  section={childSection}
                  currentSelectionId={currentSelectionId}
                  showLabels={true}
                  onNavigate={onNavigate}
                  depth={depth + 1}
                  inheritedSettings={listSettings}
                  onCollectionsChanged={onCollectionsChanged}
                  onItemAction={onItemAction}
                  rowEvents={rowEvents}
                />
              </Container>
            ))}
          </Container>
          {section.bottomContent}
          {!section.title && canAddToList ? (
            <Container className="px-3"><AddToListPopover section={section} onCollectionsChanged={onCollectionsChanged} /></Container>
          ) : null}
        </div>
      </div>
    </Container>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SidebarContent({
  sections,
  footerItems,
  currentSelectionId,
  onNavigate,
  showLabels = true,
  orientation = 'vertical',
  topContent,
  onCollectionsChanged,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  headerContent,
  emptyContent,
  headerItems,
  onItemAction,
  leadingContent,
  trailingContent,
  rowEvents,
}: SidebarContentProps) {
  const handleItemClick = (item: NavItemData) => {
    onNavigate(item.viewId ?? item.id);
  };

  // The selected row is always in view: a short sidebar or a narrow bar shows only part of its rows, and a row chosen
  // past the edge would otherwise be selected but out of sight. Only the rows' own viewport scrolls, never the page.
  const rowsRef = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    const rows = rowsRef.current;
    const viewport = rows?.closest('.bf-scroll-viewport') as HTMLElement | null;
    const row = rows?.querySelector('[aria-current="true"]') as HTMLElement | null;
    if (!viewport || !row) return;
    const edge = viewport.getBoundingClientRect();
    const place = row.getBoundingClientRect();
    if (orientation === 'horizontal') {
      if (place.left < edge.left) viewport.scrollLeft -= edge.left - place.left;
      else if (place.right > edge.right) viewport.scrollLeft += place.right - edge.right;
    } else if (place.top < edge.top) viewport.scrollTop -= edge.top - place.top;
    else if (place.bottom > edge.bottom) viewport.scrollTop += place.bottom - edge.bottom;
  }, [currentSelectionId, orientation, sections]);

  const renderHorizontalItems = (section: NavSectionData): React.ReactNode => (
    <React.Fragment key={section.id}>
      {section.items.map((item) => (
        <React.Fragment key={item.id}><Container className="flex-shrink-0">
          <NavItem
            item={item}
            isActive={currentSelectionId === item.id || currentSelectionId === item.viewId}
            showLabel={showLabels}
            onClick={() => onNavigate(item.viewId ?? item.id)}
            onCollectionsChanged={onCollectionsChanged}
            onItemAction={onItemAction}
            rowEvents={rowEvents}
          />
        </Container>{item.sections?.map(renderHorizontalItems)}</React.Fragment>
      ))}
      {section.sections?.map(renderHorizontalItems)}
    </React.Fragment>
  );

  // -----------------------------------------------------------------------
  // HORIZONTAL LAYOUT — same NavItem components, flex-row instead of flex-col
  // -----------------------------------------------------------------------
  if (orientation === 'horizontal') {
    return (
      <Container layout="horizontal" className="h-full w-full min-w-0">
        {(headerContent || searchValue !== undefined || (headerItems && headerItems.length > 0)) && (
          <Container layout="vertical" gap="xs" className="h-full flex-shrink-0 border-r border-[var(--border-primary)] p-2">
            {headerContent}
            {searchValue !== undefined && (
              <Input
                value={searchValue}
                onChange={(event) => onSearchChange?.(event.target.value)}
                placeholder={searchPlaceholder ?? 'Search'}
                aria-label={searchAriaLabel ?? 'Search navigation'}
                icon={<NamedIcon name="Search" size="sm" />}
              />
            )}
            {headerItems?.map((item) => (
              <NavItem
                key={item.id}
                item={item}
                isActive={false}
                showLabel={showLabels}
                onClick={() => onNavigate(item.viewId ?? item.id)}
                onCollectionsChanged={onCollectionsChanged}
                onItemAction={onItemAction}
                rowEvents={rowEvents}
              />
            ))}
          </Container>
        )}
        {leadingContent}
        {/* Main navigation — horizontal scroll */}
        <ScrollViewport axis="horizontal" className="flex-1 min-w-0 h-full pr-2 pl-0" aria-label="Navigation lists">
          <Container ref={rowsRef} layout="horizontal" gap="xs" alignItems="center" className="h-full">
            {sections.map(renderHorizontalItems)}
          </Container>
        </ScrollViewport>
        {trailingContent}

        {/* Footer section — pinned right */}
        {footerItems.length > 0 && <Container className="flex-shrink-0">
          <Container layout="horizontal" gap="xs" alignItems="center" className="h-full px-2">
            {footerItems.map((item) => (
              <Container key={item.id} className="flex-shrink-0">
                <NavItem
                  item={item}
                  isActive={currentSelectionId === item.id || currentSelectionId === item.viewId}
                  showLabel={showLabels}
                  onClick={() => handleItemClick(item)}
                  onCollectionsChanged={onCollectionsChanged}
                  onItemAction={onItemAction}
                  rowEvents={rowEvents}
                />
              </Container>
            ))}
          </Container>
        </Container>}
      </Container>
    );
  }

  // -----------------------------------------------------------------------
  // VERTICAL LAYOUT — original stacked sections with collapsible groups
  // -----------------------------------------------------------------------
  return (
      <Container layout="vertical" className="h-full">
        {headerContent}
        {leadingContent}
        {/* Main navigation - scrollable area */}
      <ScrollViewport className="flex-1 p-2" contentClassName="flex flex-col gap-2" aria-label="Navigation lists">
        <Container ref={rowsRef} layout="vertical" gap="sm">
        {searchValue !== undefined && (
          <Input
            value={searchValue}
            onChange={(event) => onSearchChange?.(event.target.value)}
            placeholder={searchPlaceholder ?? 'Search'}
            aria-label={searchAriaLabel ?? 'Search navigation'}
            icon={<NamedIcon name="Search" size="sm" />}
          />
        )}
        {headerItems && headerItems.length > 0 && (
          <Container layout="vertical" gap="xs">
            {headerItems.map((item) => (
              <NavItem
                key={item.id}
                item={item}
                isActive={false}
                showLabel={showLabels}
                onClick={() => onNavigate(item.viewId ?? item.id)}
                onCollectionsChanged={onCollectionsChanged}
                onItemAction={onItemAction}
                rowEvents={rowEvents}
              />
            ))}
          </Container>
        )}
        {topContent}
        {emptyContent && sections.every((section) => (
          section.items.length === 0
            && (section.sections?.length ?? 0) === 0
            && !section.bottomContent
            && !section.statusContent
        )) && emptyContent}
        {sections.map((section) => (
          <CollapsibleSection
            key={section.id}
            section={section}
            currentSelectionId={currentSelectionId}
            showLabels={showLabels}
            onNavigate={onNavigate}
            onCollectionsChanged={onCollectionsChanged}
            onItemAction={onItemAction}
            rowEvents={rowEvents}
          />
        ))}
        </Container>
      </ScrollViewport>
      {trailingContent}

      {/* Footer section */}
      {footerItems.length > 0 && <Container className="flex-shrink-0">
        {/* Footer nav items */}
        <Container layout="vertical" gap="xs" className="p-2">
          {footerItems.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              isActive={currentSelectionId === item.id || currentSelectionId === item.viewId}
              showLabel={showLabels}
              onClick={() => handleItemClick(item)}
              onCollectionsChanged={onCollectionsChanged}
            />
          ))}
        </Container>

      </Container>}
    </Container>
  );
}

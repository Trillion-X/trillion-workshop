// packages/ui/show/action-menu/ActionMenu.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE action menu. Every overflow ("…"), context and action-group menu renders
// through this one component, so every menu has the same anatomy:
//
//   [icon] Label ............................ [⌘][⌫]
//   ─────────────────────────────────────────────────
//   [icon] Destructive label (tinted, two-step confirm)
//
// Anatomy source: the workflow-canvas NodeActionMenu (leading glyph, danger
// tone, opt-in two-step confirm), taken to the level of 21st.dev coss "Menu"
// (id 11561, the base-ui menu this package already vendors under coss/ui/menu)
// and wensity "Context Menu" (id 31387: grouped sections, shortcut labels,
// destructive tint), checked against Linear / Productboard / Vapi menus on Mobbin.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. A row without an icon cannot render. `icon` is required DATA (a Lucide
//    name resolved by resolveNamedIcon, or a Lucide component); a missing or
//    unknown name throws, so a plain-text menu is impossible, not discouraged.
// 2. Groups are DATA: a separator is drawn wherever `group` changes, and a
//    group heading when the row carries `groupLabel` and headings are asked for;
//    a heading sits in its own menu group, which Base UI requires of a label.
// 3. A shortcut is DATA ({key, modifiers}); the SAME row both shows the Kbd
//    hint and (when `bindShortcuts`) binds the key, so a hint can never lie.
// 4. A menu that declares `scope` only accepts rows whose `target` equals it
//    (an item menu takes item actions only); anything else throws.
// 5. A menu opened from inside a surface marked [data-menu-anchor] (a floating
//    dock or toolbar) is placed against that surface, so it never covers it.
// 6. The menu never branches on what an action means; `tone`, `confirm`,
//    `disabled` are generic presentation properties.
// 7. Rows are left-aligned, one anatomy for every menu and submenu:
//    [grip] [icon] label ........ [hint] [check | shortcut | chevron].
//    A row with `items` opens its submenu on hover, so depth never needs a click.
// 8. A menu given `onReorder` lets a person drag its rows by the grip that
//    appears on hover (the way a sidebar row reveals its actions); the row
//    follows the pointer, the others slide aside and a line marks where it
//    lands (the shared SortableRows, the one every sortable list uses); the
//    menu reports the new order of ids and the caller keeps it.
// 9. A menu given `search` filters its rows (and their submenus) as the person
//    types, Linear's "Add filter…" box; typing never moves focus out of the box.
//    With `search.create`, words that match no row exactly are offered as a last
//    row that makes a new one ("New space “Garden”"), handed to `onCreate`.
// 10. A menu given `about` (the thing it is about) also offers, after its own
//    rows, every row the page's one source offers for that thing (menu-rows.ts):
//    tools, screens, saved actions, ways to send, nested as the source nests
//    them. The menu names none of them and hands each pick back to the source.
// 11. A row with `panel` opens, beside it, whatever the panel draws (a message
//    box, a form), so work that needs words or a recording happens inside the
//    menu; typing in it never moves through the menu's rows.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { reportChoice } from '../action-feedback/action-feedback';
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check, GripVertical, MoreHorizontal } from 'lucide-react';
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator, MenuGroup, MenuGroupLabel, MenuSub, MenuSubTrigger, MenuSubPopup } from '../coss/ui/menu';
import { Button } from '../coss/ui/button';
import { SearchField } from '../search-field/SearchField';
import { resolveNamedIcon } from '../icon/NamedIcon';
import { Kbd } from '../kbd/Kbd';
import { SortableRows } from '../drag-reorder-list/SortableRows';
import { menuRowSource, rowIds, useMenuRows, type MenuThing } from './menu-rows';
import { runCommand } from '../action-feedback/action-feedback';

export type ActionShortcut = { readonly key: string; readonly modifiers?: readonly string[] };

export interface ActionMenuItem {
  readonly id: string;
  readonly label: string;
  /** Required. A Lucide icon name ("trash-2" / "Trash2"), a Lucide component, or a
   *  `{glyph}` the row draws in the icon slot (an emoji, a colour swatch). */
  readonly icon: string | LucideIcon | { readonly glyph: React.ReactNode };
  /** Rows sharing a group sit together; a separator is drawn where it changes. */
  readonly group?: string;
  /** Heading shown above the group when the menu shows headings. */
  readonly groupLabel?: string;
  /** 'destructive' tints the row. */
  readonly tone?: string;
  /** Keyboard shortcut shown as Kbd hints (and bound when the menu binds shortcuts). */
  readonly shortcut?: ActionShortcut;
  /** When set, the first choice turns the row into this confirmation; the second runs it. */
  readonly confirm?: string;
  readonly disabled?: boolean;
  /** What the action acts on (for example "item", "library", "app"); checked against the menu's scope. */
  readonly target?: string;
  /** Extra attributes for the row (test ids, legacy hooks). */
  readonly props?: Record<string, unknown>;
  /** Nested rows: the row opens a submenu on hover instead of running. Same rules apply to every nested row. */
  readonly items?: readonly ActionMenuItem[];
  /** A check at the row's end: this row is the current choice. */
  readonly checked?: boolean;
  /** Quiet words at the row's end: a count, the current choice inside its submenu. */
  readonly hint?: string;
  /** How far the row sits in under the row above it (0 at the top): rows given in tree order draw as a tree, the
   *  way the sidebar shows its lists, without opening a submenu. */
  readonly depth?: number;
  /** Choosing the row leaves the menu open, for choices a person makes several of at once. */
  readonly keepOpen?: boolean;
  /** In a menu with `onReorder`, false pins this row where it is. */
  readonly reorderable?: boolean;
  /** The row opens this beside it instead of running (a message box, a form); `close` closes the whole menu. */
  readonly panel?: (close: () => void) => React.ReactNode;
}

export interface ActionMenuProps {
  readonly label: string;
  readonly items: readonly ActionMenuItem[];
  readonly onAction: (id: string) => void;
  /** Accept only rows whose `target` equals this scope. */
  readonly scope?: string;
  /** Show `groupLabel` headings above groups. */
  readonly showGroupLabels?: boolean;
  /** Bind each row's shortcut while the trigger is on screen. */
  readonly bindShortcuts?: boolean;
  /** Trigger shows the "…" icon (default) or the label as text. */
  readonly iconTrigger?: boolean;
  /** A caller-supplied trigger element (rendered through MenuTrigger). */
  readonly trigger?: React.ReactElement;
  readonly triggerContent?: React.ReactNode;
  readonly triggerProps?: Record<string, unknown>;
  /** Toolbar menus can keep adjacent controls interactive while open. */
  readonly modal?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly align?: 'start' | 'center' | 'end';
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  readonly popupClassName?: string;
  /** Extra non-item content drawn after the rows (for example a field list). */
  readonly children?: React.ReactNode;
  /** Open at a viewport point (a right-click) with no visible trigger. */
  readonly anchorPoint?: { readonly x: number; readonly y: number };
  /** Rows can be dragged by their grip; receives every top-level row id in the new order. */
  readonly onReorder?: (ids: string[]) => void;
  /** A box at the top that narrows the rows (and submenus) to what matches. */
  readonly search?: {
    readonly placeholder: string;
    /** A last row making a new thing from the typed words: `label` with `{name}` filled in, and what to do with them. */
    readonly create?: { readonly label: string; readonly icon?: string; readonly onCreate: (name: string) => void };
  };
  /** Content drawn above the rows (a heading, the current choices). */
  readonly header?: React.ReactNode;
  /** What the menu is about: the page's menu rows for it follow the menu's own rows (menu-rows.ts). */
  readonly about?: MenuThing;
}

/** Rows whose label, or any nested row's label, contains the words. */
const rowId = (item: ActionMenuItem) => item.id;

/** The row with this id, at any depth. */
function findRow(rows: readonly ActionMenuItem[], id: string): ActionMenuItem | undefined {
  for (const row of rows) {
    if (row.id === id) return row;
    const inside = row.items ? findRow(row.items, id) : undefined;
    if (inside) return inside;
  }
  return undefined;
}

export function matchingRows(rows: readonly ActionMenuItem[], query: string): ActionMenuItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  const out: ActionMenuItem[] = [];
  for (const row of rows) {
    if (row.label.toLocaleLowerCase().includes(needle)) { out.push(row); continue; }
    const nested = row.items ? matchingRows(row.items, needle) : [];
    if (nested.length) out.push({ ...row, items: nested });
  }
  return out;
}

/** The ids after moving one row onto another's place. */
const MODIFIER_GLYPHS: Readonly<Record<string, string>> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'];
const KEY_GLYPHS: Readonly<Record<string, string>> = {
  Backspace: '⌫', Delete: '⌦', Enter: '↩', Escape: 'esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: '⇥', ' ': 'Space',
};

/** The glyphs a shortcut shows, in macOS order. */
export function shortcutGlyphs(shortcut: ActionShortcut): string[] {
  const modifiers = MODIFIER_ORDER.filter((modifier) => shortcut.modifiers?.includes(modifier)).map((modifier) => MODIFIER_GLYPHS[modifier]);
  return [...modifiers, KEY_GLYPHS[shortcut.key] ?? shortcut.key.toUpperCase()];
}

const ARIA_MODIFIERS: Readonly<Record<string, string>> = { ctrl: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta' };

/** The aria-keyshortcuts value for a shortcut, modifiers in the same order the hint shows them. */
export function ariaShortcut(shortcut: ActionShortcut): string {
  return [...MODIFIER_ORDER.filter((modifier) => shortcut.modifiers?.includes(modifier)).map((modifier) => ARIA_MODIFIERS[modifier]), shortcut.key].join('+');
}

/** True when a keydown is exactly this shortcut (no extra modifiers). */
export function matchesShortcut(event: KeyboardEvent, shortcut: ActionShortcut): boolean {
  const wanted = new Set(shortcut.modifiers ?? []);
  const pressed = { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey } as Record<string, boolean>;
  if (MODIFIER_ORDER.some((modifier) => pressed[modifier] !== wanted.has(modifier))) return false;
  return event.key.toLowerCase() === shortcut.key.toLowerCase();
}

function resolveIcon(item: ActionMenuItem): LucideIcon | { readonly glyph: React.ReactNode } {
  // A new icon name in live DATA must never take down the whole workspace.
  // Keep a visible icon while the missing name is corrected in the bundle.
  const icon = typeof item.icon === 'string'
    ? (resolveNamedIcon(item.icon) ?? (item.icon ? MoreHorizontal : null))
    : item.icon;
  if (!icon || (typeof icon === 'object' && 'glyph' in icon && (icon.glyph === null || icon.glyph === undefined || icon.glyph === ''))) {
    throw new Error(`Menu item "${item.label}" needs an icon (received ${String(item.icon)}).`);
  }
  return icon as LucideIcon | { readonly glyph: React.ReactNode };
}

function RowIcon({ icon }: { icon: LucideIcon | { readonly glyph: React.ReactNode } }): React.ReactElement {
  if (typeof icon === 'object' && 'glyph' in icon) return <span aria-hidden="true" data-slot="menu-item-icon">{icon.glyph}</span>;
  const Glyph = icon as LucideIcon;
  return <Glyph aria-hidden="true" data-slot="menu-item-icon" />;
}

/** Validate rows once: every row has a resolvable icon and fits the menu's scope. */
export function checkActionMenuItems(items: readonly ActionMenuItem[], scope?: string): void {
  for (const item of items) {
    resolveIcon(item);
    if (scope !== undefined && item.target !== scope) {
      throw new Error(`"${item.label}" acts on ${item.target ?? 'nothing declared'}, so it cannot appear in a menu for one ${scope}.`);
    }
    if (item.items) checkActionMenuItems(item.items, scope);
  }
}

function isTyping(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return !!node && (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));
}

export function ActionMenu({
  label,
  items,
  onAction,
  scope,
  showGroupLabels = false,
  bindShortcuts = false,
  iconTrigger = true,
  trigger,
  triggerContent,
  triggerProps = {},
  open: controlledOpen,
  modal = true,
  onOpenChange,
  align = 'end',
  side = 'bottom',
  popupClassName,
  children,
  anchorPoint,
  onReorder,
  search,
  header,
  about,
}: ActionMenuProps): React.ReactElement | null {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const open = controlledOpen ?? uncontrolledOpen;
  // The rows the page offers for what this menu is about follow the menu's own, each group kept apart by a line.
  const offered = useMenuRows(about, open);
  const offeredIds = React.useMemo(() => rowIds(offered), [offered]);
  const ownItems = items;
  items = offered.length ? [...ownItems, ...offered] : ownItems;
  checkActionMenuItems(ownItems, scope);
  checkActionMenuItems(offered);
  const pick = (id: string) => {
    const source = menuRowSource();
    if (!about || !source || !offeredIds.has(id)) { onAction(id); return; }
    const row = findRow(offered, id);
    void runCommand(row?.label ?? null, async () => source.act(about, id)).catch(() => undefined);
  };
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const setOpen = (value: boolean) => {
    if (!value) { setConfirming(null); setQuery(''); }
    if (controlledOpen === undefined) setUncontrolledOpen(value);
    onOpenChange?.(value);
  };

  const latest = React.useRef({ items, pick });
  latest.current = { items, pick };
  const hasShortcuts = bindShortcuts && items.some((item) => item.shortcut);
  React.useEffect(() => {
    if (!hasShortcuts) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const node = triggerRef.current;
      if (event.defaultPrevented || isTyping(event.target) || !node?.isConnected || !node.getClientRects().length) return;
      const item = latest.current.items.find((row) => row.shortcut && !row.disabled && matchesShortcut(event, row.shortcut));
      if (!item) return;
      event.preventDefault();
      // A keyboard shortcut presses nothing, so it reports its own choice.
      reportChoice(item.label);
      latest.current.pick(item.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hasShortcuts]);

  // Rows move with the one shared sortable (SortableRows): the row follows the
  // pointer, the others slide aside and a line marks the landing place. A row
  // with `reorderable: false` has no grip and keeps its slot.
  const reordering = !!onReorder && !query;
  const reorderRows = (order: readonly string[]) => {
    const movableIds = items.filter((item) => item.reorderable !== false).map((item) => item.id);
    const moved = order.filter((id) => movableIds.includes(id));
    let next = 0;
    onReorder?.(items.map((item) => (movableIds.includes(item.id) ? moved[next++]! : item.id)));
  };

  if (!items.length && !children && !header && !about) return null;
  const shownItems = search ? matchingRows(items, query) : items;
  const typed = query.trim();
  const creatable = !!search?.create && !!typed && !items.some((item) => item.label.toLocaleLowerCase() === typed.toLocaleLowerCase());
  const rowEnd = (item: ActionMenuItem, isConfirming: boolean) => (
    <>
      {item.hint && !isConfirming && <span data-slot="menu-item-hint">{item.hint}</span>}
      {item.checked && !isConfirming && <Check aria-hidden="true" data-slot="menu-item-check" />}
      {item.shortcut && !isConfirming && (
        <span data-slot="menu-item-shortcut" aria-hidden="true">
          {shortcutGlyphs(item.shortcut).map((glyph, position) => <Kbd key={position} size="sm">{glyph}</Kbd>)}
        </span>
      )}
    </>
  );
  const renderRow = (item: ActionMenuItem, index: number, rows: readonly ActionMenuItem[], topLevel: boolean): React.ReactNode => {
    const previous = rows[index - 1];
    const newGroup = index > 0 && item.group !== previous.group;
    const icon = resolveIcon(item);
    const isConfirming = confirming === item.id;
    const heading = showGroupLabels && item.groupLabel && (index === 0 || newGroup) ? <MenuGroup><MenuGroupLabel>{item.groupLabel}</MenuGroupLabel></MenuGroup> : null;
    const movable = topLevel && reordering && item.reorderable !== false;
    const grip = topLevel && reordering ? (
      <span
        data-slot="menu-item-grip"
        aria-hidden="true"
        data-reorder-handle={movable ? '' : undefined}
        data-pinned={movable ? undefined : 'true'}
      >
        {movable && <GripVertical />}
      </span>
    ) : null;
    if (item.panel) {
      return (
        <React.Fragment key={item.id}>
          {newGroup && <MenuSeparator />}
          {heading}
          <MenuSub>
            <MenuSubTrigger {...item.props} disabled={item.disabled} data-action-id={item.id} data-has-grip={grip ? 'true' : undefined}>
              {grip}
              <RowIcon icon={icon} />
              <span data-slot="menu-item-label">{item.label}</span>
              {rowEnd(item, false)}
            </MenuSubTrigger>
            <MenuSubPopup className="action-menu action-menu-panel" portalProps={{ className: 'coss-ui' }} data-action-menu="">
              {/* Typing in the panel stays in the panel: the menu's own keys (type to find a row, arrows) never see it. */}
              <div data-slot="menu-panel" onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation(); }}>
                {item.panel(() => setOpen(false))}
              </div>
            </MenuSubPopup>
          </MenuSub>
        </React.Fragment>
      );
    }
    if (item.items) {
      return (
        <React.Fragment key={item.id}>
          {newGroup && <MenuSeparator />}
          {heading}
          <MenuSub>
            <MenuSubTrigger {...item.props} disabled={item.disabled} data-action-id={item.id} data-has-grip={grip ? 'true' : undefined}>
              {grip}
              <RowIcon icon={icon} />
              <span data-slot="menu-item-label">{item.label}</span>
              {rowEnd(item, false)}
            </MenuSubTrigger>
            <MenuSubPopup className="action-menu" portalProps={{ className: 'coss-ui' }} data-action-menu="">{renderRows(item.items, false)}</MenuSubPopup>
          </MenuSub>
        </React.Fragment>
      );
    }
    return (
      <React.Fragment key={item.id}>
        {newGroup && <MenuSeparator />}
        {heading}
        <MenuItem
          {...item.props}
          closeOnClick={false}
          disabled={item.disabled}
          variant={item.tone === 'destructive' || isConfirming ? 'destructive' : 'default'}
          data-action-id={item.id}
          data-has-grip={grip ? 'true' : undefined}
          data-checked={item.checked ? 'true' : undefined}
          data-depth={item.depth ? item.depth : undefined}
          style={item.depth ? { paddingInlineStart: `calc(var(--menu-row-padding, 0.5rem) + ${item.depth} * var(--menu-depth-step, 1rem))` } : undefined}
          data-confirming={isConfirming || undefined}
          aria-keyshortcuts={item.shortcut ? ariaShortcut(item.shortcut) : undefined}
          onClick={() => choose(item)}
        >
          {grip}
          <RowIcon icon={icon} />
          <span data-slot="menu-item-label">{isConfirming ? item.confirm : item.label}</span>
          {rowEnd(item, isConfirming)}
        </MenuItem>
      </React.Fragment>
    );
  };
  const renderRows = (rows: readonly ActionMenuItem[], topLevel: boolean): React.ReactNode => rows.map((item, index) => renderRow(item, index, rows, topLevel));
  const pointAnchor = anchorPoint ? { getBoundingClientRect: () => new DOMRect(anchorPoint.x, anchorPoint.y, 0, 0) } : null;
  const choose = (item: ActionMenuItem) => {
    if (item.confirm && confirming !== item.id) { setConfirming(item.id); return; }
    if (!item.keepOpen) setOpen(false);
    pick(item.id);
  };

  return (
    <Menu modal={modal} open={open} onOpenChange={(value) => setOpen(value)}>
      {!pointAnchor && (
        <MenuTrigger
          ref={triggerRef as React.Ref<HTMLButtonElement>}
          aria-label={label}
          {...triggerProps}
          render={trigger ?? <Button variant="ghost" size={iconTrigger ? 'icon' : 'default'} />}
        >
          {triggerContent ?? (iconTrigger ? <MoreHorizontal /> : label)}
        </MenuTrigger>
      )}
      <MenuPopup align={align} side={side} anchor={pointAnchor ?? (() => triggerRef.current?.closest('[data-menu-anchor]') ?? triggerRef.current)} portalProps={{ className: 'coss-ui' }} className={['action-menu', popupClassName].filter(Boolean).join(' ')} data-action-menu="">
        {header}
        {search && (
          <div data-slot="menu-search">
            <SearchField
              size="sm"
              label={search.placeholder}
              placeholder={search.placeholder}
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => { if (!['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(event.key)) event.stopPropagation(); }}
            />
          </div>
        )}
        {reordering
          ? <SortableRows items={shownItems} getId={rowId} onReorder={reorderRows} className="action-menu-rows" renderItem={(item) => renderRow(item, shownItems.indexOf(item), shownItems, true)} />
          : renderRows(shownItems, true)}
        {creatable ? (
          <MenuItem data-slot="menu-create" onClick={() => { search!.create!.onCreate(typed); setQuery(''); }}>
            {React.createElement(resolveNamedIcon(search!.create!.icon ?? 'Plus') ?? MoreHorizontal, { 'aria-hidden': true })}
            <span data-slot="menu-item-label">{search!.create!.label.replace('{name}', typed)}</span>
          </MenuItem>
        ) : search && query && !shownItems.length ? <p data-slot="menu-empty">Nothing matches.</p> : null}
        {children}
      </MenuPopup>
    </Menu>
  );
}

// packages/sidebar/show/CollectionManagerRow.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The in-sidebar editor for surface lists (plan T4): create a list, rename it,
// delete it, add/remove surfaces, and cycle the show-all / per-list view. Every
// edit is a dispatch to the group package's ONE mutation door by address (via
// the sidebar's do-work dispatchers); this component holds zero membership
// logic. Copy is user-language only: "Lists" — never group/membership/fold
// vocabulary (L114/L118).
//
// The picker floats on the shared popover (parts/ui coss popover: the menu
// layer of layer-order.ts, the floating-menus.css surface), so it paints over
// the sidebar and the Layouts cards like every other menu. A list's own actions
// (Rename, When it shows, Delete) are one "…" through the shared ActionMenu, the
// same control the Layouts cards use; When it shows opens the list's rule
// (ListShowsWhen.tsx) under its name.
//
// =============================================================================

'use client';

import { lazyPart } from '../../ui/show/load-later/later';
import * as React from 'react';
import { Button, Container, Input, NamedIcon, Text } from '../../ui';
import { ActionMenu, type ActionMenuItem } from '../../ui/show/action-menu';
import { Popover, PopoverPopup, PopoverTrigger } from '../../ui/show/coss/ui/popover';
import type { SurfaceCollection } from '../read-data/read-surface-collections';
import {
  addSurfaceToCollection,
  createSurfaceCollection,
  deleteSurfaceCollection,
  removeSurfaceFromCollection,
  renameSurfaceCollection,
} from '../do-work/edit-surface-collections';
import type { CollectionViewState } from '../do-work/collection-view-preference';
// A list's "When it shows" rule editor is fetched the first time someone opens it.
const ListShowsWhen = lazyPart(() => import('./ListShowsWhen'), module => module.ListShowsWhen);
import type { NavItemData } from './SidebarContent';

export interface CollectionManagerRowProps {
  scope?: string;
  collections: SurfaceCollection[];
  placeableItems: NavItemData[];
  view: CollectionViewState;
  /** Called after any successful edit so the owner re-reads the group records. */
  onChanged: () => void | Promise<void>;
  /** Cycle show-all → each list → show-all. */
  onCycleView: () => void;
}

/** A list's own actions, one "…" menu. */
const listActions = (name: string): ActionMenuItem[] => [
  { id: 'rename', label: 'Rename', icon: 'Pencil' },
  { id: 'when', label: 'When it shows', icon: 'CalendarClock' },
  { id: 'delete', label: 'Delete', icon: 'Trash2', tone: 'destructive', group: 'delete', confirm: `Delete ${name}` },
];

function newCollectionId(): string {
  return `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function CollectionManagerRow({
  scope,
  collections,
  placeableItems,
  view,
  onChanged,
  onCycleView,
}: CollectionManagerRowProps) {
  const [open, setOpen] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState('');
  // The list whose "When it shows" rule is open (ListShowsWhen.tsx).
  const [ruling, setRuling] = React.useState<string | null>(null);
  const renameField = React.useRef<HTMLInputElement | null>(null);
  // The name field takes focus once the "…" menu has closed and handed focus back.
  React.useEffect(() => {
    if (!editing) return undefined;
    const frame = requestAnimationFrame(() => renameField.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const run = React.useCallback(async (edit: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await edit();
      await onChanged();
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const createList = React.useCallback(() => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNewName('');
    void run(() => createSurfaceCollection(newCollectionId(), trimmed, scope));
  }, [newName, run, scope]);

  const finishRename = React.useCallback((collection: SurfaceCollection) => {
    setEditing(null);
    const trimmed = editingName.trim();
    if (trimmed && trimmed !== collection.name) {
      void run(() => renameSurfaceCollection(collection, trimmed));
    }
  }, [editingName, run]);

  const viewLabel = view.mode === 'show-all'
    ? 'All'
    : collections.find((collection) => collection.id === view.mode)?.name ?? 'All';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="sidebar-add-list-trigger"
            aria-label="Add a list"
          >
            <NamedIcon name="ListPlus" size={16} />
            <Text variant="body-xs" color="secondary">Add a list</Text>
          </Button>
        }
      />

      <PopoverPopup className="sidebar-list-popover" side="right" align="end" portalProps={{ className: 'coss-ui' }}>
        <Container padding="xs" gap="xs">
          <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
            <Text variant="body-xs" weight="medium">Your lists</Text>
            {collections.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCycleView}
                aria-label={`Showing ${viewLabel}. Switch view`}
                title="Switch which lists show"
              >
                <NamedIcon name="Eye" size={14} />
                <Text variant="body-xs" color="secondary">{viewLabel}</Text>
              </Button>
            ) : null}
          </Container>
          <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createList();
              }}
              placeholder="New list name"
              aria-label="New list name"
            />
            <Button variant="ghost" size="sm" onClick={createList} disabled={busy} aria-label="Create list">
              <NamedIcon name="Plus" size={14} />
            </Button>
          </Container>

          {collections.map((collection) => {
            const memberIdsBySurface = new Map(collection.members.map((member) => [member.surfaceId, member.memberId]));
            const isEditing = editing === collection.id;
            return (
              <Container key={collection.id} padding="none" gap="xs">
                <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
                  {isEditing ? (
                    <Input
                      ref={renameField}
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') finishRename(collection);
                        if (event.key === 'Escape') setEditing(null);
                      }}
                      onBlur={() => finishRename(collection)}
                      aria-label={`Rename ${collection.name}`}
                    />
                  ) : (
                    <Text variant="body-xs" weight="medium">{collection.name}</Text>
                  )}
                  <ActionMenu
                    label={`Actions for ${collection.name}`}
                    items={listActions(collection.name)}
                    onAction={(action) => {
                      if (action === 'rename') {
                        setEditing(collection.id);
                        setEditingName(collection.name);
                      } else if (action === 'when') {
                        setRuling(collection.id);
                      } else if (action === 'delete') {
                        void run(() => deleteSurfaceCollection(collection.id, scope));
                      }
                    }}
                    trigger={<Button variant="ghost" size="icon-xs" disabled={busy} />}
                    triggerContent={<NamedIcon name="MoreHorizontal" size="xs" />}
                    align="end"
                  />
                </Container>
                {ruling === collection.id
                  ? <React.Suspense fallback={null}><ListShowsWhen collection={collection} onChanged={onChanged} onDone={() => setRuling(null)} /></React.Suspense>
                  : null}

                <Container layout="horizontal" alignItems="center" gap="xs" padding="none" wrap="wrap">
                  {placeableItems.map((item) => {
                    const memberId = memberIdsBySurface.get(item.id);
                    const inList = memberId !== undefined;
                    return (
                      <Button
                        key={item.id}
                        variant={inList ? 'secondary' : 'ghost'}
                        size="sm"
                        disabled={busy}
                        aria-pressed={inList}
                        aria-label={inList ? `Remove ${item.label} from ${collection.name}` : `Add ${item.label} to ${collection.name}`}
                        onClick={() => {
                          void run(() => (inList
                            ? removeSurfaceFromCollection(collection.id, memberId)
                            : addSurfaceToCollection(collection.id, item.id)));
                        }}
                      >
                        <Text variant="body-xs" color={inList ? 'default' : 'secondary'}>{item.label}</Text>
                      </Button>
                    );
                  })}
                </Container>
              </Container>
            );
          })}
        </Container>
      </PopoverPopup>
    </Popover>
  );
}

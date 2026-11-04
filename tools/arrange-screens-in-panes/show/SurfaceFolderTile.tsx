// packages/screen-arrangement/show/SurfaceFolderTile.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// New-tab picker tiles for user collections (plan T5): a Folder tile shows a
// 2x2 mini-preview of its member surfaces (iOS-folder anatomy, via the shared
// ui PickerTile) and opens its contents in a floating, viewport-clamped panel
// anchored to the clicked tile (shared ui AnchoredOverlay — the same
// positioning primitive ColorTagPickerOverlay uses). Presentation only — the
// folder IS one list of the sidebar's own recursive tree (`SurfaceCollection`,
// read by the sidebar's `useSurfaceCollections`); a list inside it shows as a
// titled group of its own things, to any depth. Layouts are the shared
// LayoutPicker's, not a tile here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The folder contents render in an AnchoredOverlay portal, never inline in
//    the grid flow — an inline expansion pushes every sibling tile below it
//    and cannot escape the picker's scroll clipping. Deleted the old
//    OpenScale-in-flow anatomy entirely (L030 — no fallback path).
// 2. The overlay is viewport-aware (auto-flip above/below, height-clamped
//    with internal scroll) via AnchoredOverlay — this file owns zero
//    positioning math.
// 3. Row anatomy inside the overlay is the compact PickerTile, same idiom as
//    the top-level grid — one tile component, two densities.
// 5. Depth is the list tree's, never flattened away: a nested list renders as
//    its own titled group; a nested list with nothing this app can open is
//    left out (the sidebar hides it the same way).
// 4. OPEN-INTENT rows (plan A12/A13) are rendered from the caller-supplied
//    `openIntents` catalog verbatim — this file owns zero named strategies,
//    zero hardcoded "Open selected" button. "Open selected" is just another
//    catalog row whose own `scope` field is `'selected'`; a member's
//    selection toggle only ever feeds `selectedIds` into
//    do-work/execute-open-intent.ts's `resolveMembers`. New options are
//    added/removed/reordered by editing DATA — zero code change here.
//
// =============================================================================

'use client';

import React from 'react';
import { AnchoredOverlay } from '../../ui/show/anchored-overlay';
import { Button } from '../../ui/show/button';
import { Container } from '../../ui/show/container';
import { NamedIcon } from '../../ui/show/icon';
import { PickerTile } from '../../ui/show/picker-tile/PickerTile';
import { Text } from '../../ui/show/text';
import type { PlaceableSurfaceRecord } from '../read-data/read-published-records';
import type { SurfaceCollection } from '../../sidebar/read-data/read-surface-collections';
import { surfaceIdsInList } from '../read-data/read-tab-collections';
import type { LayoutActions } from '../do-work/layout-operations';
import type { OpenIntentRow } from '../read-data/read-open-intents';
import { executeOpenIntent } from '../do-work/execute-open-intent';

export interface SurfaceFolderTileProps {
  /** One list of the sidebar's tree. */
  folder: SurfaceCollection;
  /** Catalog join index (surface id → catalog row). Unresolvable refs skipped. */
  surfacesById: ReadonlyMap<string, PlaceableSurfaceRecord>;
  open: boolean;
  onToggle: () => void;
  onPickSurface: (surface: PlaceableSurfaceRecord) => void;
  /** Global open-intent catalog rows (plan A12/A13) — same list rendered under every folder. */
  openIntents?: readonly OpenIntentRow[];
  layoutActions?: LayoutActions | null;
  /** The container this picker is currently showing in — stable anchor for every strategy. */
  containerId?: string;
  /** The picker's own empty tab id, if known — index 0 of any open-intent replaces it in place. */
  emptyTabId?: string | null;
}

export function SurfaceFolderTile({
  folder,
  surfacesById,
  open,
  onToggle,
  onPickSurface,
  openIntents = [],
  layoutActions = null,
  containerId,
  emptyTabId,
}: SurfaceFolderTileProps) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(new Set());
  const members = React.useMemo(() => surfaceIdsInList(folder)
    .map((id) => surfacesById.get(id))
    .filter((surface): surface is PlaceableSurfaceRecord => Boolean(surface)), [folder, surfacesById]);

  const toggleSelected = React.useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const canRunIntents = Boolean(layoutActions && containerId);

  const runIntent = React.useCallback((intent: OpenIntentRow) => {
    if (!layoutActions || !containerId) return;
    const applied = executeOpenIntent({
      actions: layoutActions,
      containerId,
      emptyTabId,
      intent,
      members: members.map((surface) => ({ id: surface.id, surface })),
      selectedIds,
    });
    if (applied) onToggle();
  }, [containerId, emptyTabId, layoutActions, members, onToggle, selectedIds]);

  return (
    <>
      <PickerTile
        ref={triggerRef}
        title={folder.name}
        subtitle={members.length === 1 ? '1 thing' : `${members.length} things`}
        icon="Folder"
        previewIcons={members.slice(0, 4).map((surface) => surface.icon ?? 'Square')}
        trailing={<NamedIcon name={open ? 'ChevronUp' : 'ChevronDown'} size="sm" />}
        onClick={onToggle}
        aria-label={`Open folder ${folder.name}`}
        aria-expanded={open}
      />
      <AnchoredOverlay anchorRef={triggerRef} open={open} placement="below" onDismiss={onToggle}>
        <Container
          layout="vertical"
          gap="xs"
          padding="sm"
          aria-label={`${folder.name} contents`}
          role="menu"
        >
          <FolderMembers
            list={folder}
            surfacesById={surfacesById}
            canSelect={canRunIntents}
            selectedIds={selectedIds}
            onToggleSelected={toggleSelected}
            onPickSurface={onPickSurface}
            depth={0}
          />
          {members.length === 0 ? (
            <Text variant="body-xs" color="secondary" align="center">
              This list is empty. Add things from the sidebar.
            </Text>
          ) : null}
          {canRunIntents && openIntents.length > 0 && members.length > 0 ? (
            <Container layout="vertical" gap="xs" padding="none" aria-label="Open as">
              <Text variant="body-xs" color="secondary">
                Open as
              </Text>
              {openIntents.map((intent) => {
                const needsSelection = intent.scope === 'selected' && selectedIds.size === 0;
                return (
                  <PickerTile
                    key={intent.id}
                    compact
                    title={intent.label}
                    subtitle={needsSelection ? 'Select things first' : undefined}
                    icon={intent.icon ?? 'LayoutGrid'}
                    onClick={() => runIntent(intent)}
                  />
                );
              })}
            </Container>
          ) : null}
        </Container>
      </AnchoredOverlay>
    </>
  );
}

function FolderMembers({
  list,
  surfacesById,
  canSelect,
  selectedIds,
  onToggleSelected,
  onPickSurface,
  depth,
}: {
  list: SurfaceCollection;
  surfacesById: ReadonlyMap<string, PlaceableSurfaceRecord>;
  canSelect: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelected: (id: string) => void;
  onPickSurface: (surface: PlaceableSurfaceRecord) => void;
  depth: number;
}) {
  return (
    <>
      {list.members.map((member) => {
        if (member.kind === 'collection') {
          const child = member.childCollection;
          if (!child || depth > 8) return null;
          if (!surfaceIdsInList(child).some((id) => surfacesById.has(id))) return null;
          return (
            <Container key={member.memberId} layout="vertical" gap="xs" padding="none" aria-label={child.name}>
              <Text variant="label" color="secondary">{child.name}</Text>
              <FolderMembers
                list={child}
                surfacesById={surfacesById}
                canSelect={canSelect}
                selectedIds={selectedIds}
                onToggleSelected={onToggleSelected}
                onPickSurface={onPickSurface}
                depth={depth + 1}
              />
            </Container>
          );
        }
        const surface = surfacesById.get(member.surfaceId);
        if (!surface) return null;
        return (
          <Container key={member.memberId} layout="horizontal" gap="xs" padding="none" alignItems="center" width="full">
            {canSelect ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                active={selectedIds.has(surface.id)}
                onClick={() => onToggleSelected(surface.id)}
                aria-label={selectedIds.has(surface.id) ? `Deselect ${surface.label}` : `Select ${surface.label}`}
              >
                <NamedIcon name={selectedIds.has(surface.id) ? 'CircleCheck' : 'Circle'} size="sm" />
              </Button>
            ) : null}
            <Container flex={1} padding="none">
              <PickerTile
                compact
                title={surface.label}
                icon={surface.icon ?? 'Square'}
                onClick={() => onPickSurface(surface)}
              />
            </Container>
          </Container>
        );
      })}
    </>
  );
}

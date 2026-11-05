// packages/group/show/BoardLayersPanel.tsx
//
// The Objects / Layers panel — a Figma/Miro side TREE of every placed item on the
// board, TOP-MOST z first, with sections expand/collapse and their children
// indented (#153, extending the flat #151 list). The capstone that COMPOSES the
// three per-item DATA flags already shipped: z-order (#111/#112/#152), lock
// (#135/#136), visibility (#149/#150). Each row: an optional expand chevron (for
// sections), a visibility toggle, a lock toggle, and a label that selects the item.
//
// Blind renderer (L090): it knows nothing about the board — it renders the nodes
// it is handed (`boardLayerTree`) and emits id-keyed select/toggle/expand intents.
// Composed entirely from `ui` primitives (Container/Button/Text/Icon/DragReorderList),
// no raw HTML (L065). Positioning is owned by the caller's AnchoredOverlay (same
// pattern as the board background picker) — this component is just the popover body.
//
// Indentation is STRUCTURAL: a section's children render inside the section row's
// content (already inset by the grip + content), so depth needs no arbitrary px.
// Drag-reorder is SIBLING-SCOPED: each level is its own DragReorderList; a drop
// emits (parentId, newTopFirstIds) so the caller restacks within that parent only
// (native-DnD cross-fire between levels is prevented by DragReorderList's per-row
// stopPropagation). The eye/lock/label/chevron buttons still click (a native-DnD
// click without a drag stays a click).

import React from 'react';
import { Container, Button, ExpandableTabs, Text, Icon, DragReorderList } from '../../ui/index.ts';
import { Layers, X, ChevronRight, ChevronDown } from 'lucide-react';
import type { BoardLayerNode } from './board-layer-rows.ts';

export interface BoardLayersPanelProps {
  nodes: readonly BoardLayerNode[];
  /** Select a node's item (additive = shift/cmd → toggle into the multi-selection). */
  onSelect: (id: string, additive: boolean) => void;
  onToggleHidden: (id: string) => void;
  onToggleLocked: (id: string) => void;
  /** Rename a node (double-click its label) — the in-app text overlay opens. */
  onRename: (id: string) => void;
  /** Expand/collapse a section node (only sections carry children). */
  onToggleExpand: (id: string) => void;
  /** Drag-reorder (#152/#153): the COMPLETE new TOP-most-first id order WITHIN a
   *  parent. `parentId` is null at the board root, else the section's id. */
  onReorder: (parentId: string | null, newTopFirstIds: string[]) => void;
  onClose: () => void;
}

export function BoardLayersPanel({
  nodes,
  onSelect,
  onToggleHidden,
  onToggleLocked,
  onRename,
  onToggleExpand,
  onReorder,
  onClose,
}: BoardLayersPanelProps) {
  // One node's controls (chevron + eye + lock + label) — the `content` the
  // DragReorderList renders to the right of its grip handle.
  const rowBody = (node: BoardLayerNode): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    return (
      <Container layout="horizontal" gap="xs" alignItems="center">
        {hasChildren ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={node.expanded ? `Collapse ${node.label}` : `Expand ${node.label}`}
            aria-expanded={node.expanded}
            onClick={() => onToggleExpand(node.id)}
          >
            <Icon icon={node.expanded ? ChevronDown : ChevronRight} size="xs" />
          </Button>
        ) : null}
        <ExpandableTabs
          mode="action"
          size="sm"
          ariaLabel={`${node.label} layer`}
          items={[
            { id: 'hidden', label: node.hidden ? `Show ${node.label}` : `Hide ${node.label}`, icon: node.hidden ? 'EyeOff' : 'Eye', pinned: node.hidden },
            { id: 'locked', label: node.locked ? `Unlock ${node.label}` : `Lock ${node.label}`, icon: node.locked ? 'Lock' : 'LockOpen', pinned: node.locked },
          ]}
          onSelect={(id) => (id === 'hidden' ? onToggleHidden(node.id) : onToggleLocked(node.id))}
        />
        <Container layout="horizontal" flex={1}>
          <Button
            variant={node.selected ? 'primary' : 'ghost'}
            size="menu"
            aria-label={`Select ${node.label}`}
            aria-pressed={node.selected}
            onClick={(e) => onSelect(node.id, e.shiftKey || e.metaKey || e.ctrlKey)}
            onDoubleClick={() => onRename(node.id)}
          >
            <Text variant="body-xs" color={node.hidden ? 'muted' : undefined} truncate>
              {node.label}
            </Text>
          </Button>
        </Container>
      </Container>
    );
  };

  // One sibling level → a DragReorderList whose each row may itself contain the
  // next level (when expanded). Recursion gives arbitrary depth with one renderer.
  const renderLevel = (levelNodes: readonly BoardLayerNode[], parentId: string | null): React.ReactNode => (
    <DragReorderList
      items={levelNodes.map((node) => ({
        id: node.id,
        content:
          node.expanded && node.children.length > 0 ? (
            <Container layout="vertical" gap="none">
              {rowBody(node)}
              {renderLevel(node.children, node.id)}
            </Container>
          ) : (
            rowBody(node)
          ),
      }))}
      onReorder={(ids) => onReorder(parentId, ids)}
    />
  );

  return (
    <Container layout="vertical" gap="sm" padding="sm" aria-label="On this board panel">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Icon icon={Layers} size="sm" />
          <Text variant="label">On this board ({nodes.length})</Text>
        </Container>
        <Button variant="ghost" size="sm" aria-label="Close the board list" onClick={onClose}>
          <Icon icon={X} size="xs" />
        </Button>
      </Container>
      {/* One-line explainer (R30) — what this list IS, in plain words. */}
      <Text variant="body-xs" color="muted">Every card on this board, in one list — click a name to select it.</Text>

      {nodes.length === 0 ? (
        <Text variant="body-xs" color="muted">Nothing on this board yet</Text>
      ) : (
        <Container layout="vertical" gap="none" maxHeight="50vh" overflow="y-auto" aria-label="Cards on this board">
          {renderLevel(nodes, null)}
        </Container>
      )}
    </Container>
  );
}

BoardLayersPanel.displayName = 'BoardLayersPanel';

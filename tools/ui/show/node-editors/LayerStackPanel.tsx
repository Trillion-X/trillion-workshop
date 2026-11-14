// packages/ui/show/node-editors/LayerStackPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The layer-tree editor hosted in the NodeContextMenu popover: a region's
// visual layer stack rendered as a draggable tree (documents-grade)
// — front-most layer at the top, a drag handle to reorder, per-row visibility,
// opacity, and remove, plus an "Add" menu. It is a PURE presentational shell:
// value (layers) in, callbacks out. It knows nothing about regions, nodes, or
// the screen-arrangement — the caller maps a layer to a human label/icon and
// supplies the add options as DATA (L090).
//
// Composes the shared DragReorderList (grip handle + drop indicator + FLIP-ish
// reflow) and Dropdown (the Add menu) — zero bespoke DnD.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Pure browser-local UI. No reads/writes/feeds/package behavior/I/O.
// 2. Zero closed enum of layer kinds — the row label/icon come from the
//    caller-supplied `describeLayer`, never a switch on capabilityId here.
// 3. Layers are caller-owned; this panel holds no persistent state.
// =============================================================================

import React from 'react';
import { DragReorderList } from '../drag-reorder-list/DragReorderList';
import { Dropdown } from '../dropdown/Dropdown';
import { ExpandableTabs } from '../expandable-tabs';
import { NamedIcon } from '../icon';
import type { VisualLayerDescriptor } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

export interface LayerRowInfo {
  readonly label: string;
  readonly icon?: string;
}

export interface LayerAddOption {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly run: () => void;
}

export interface LayerStackPanelProps {
  /** The region's decoration layers (the content layer is excluded by the caller). */
  readonly layers: readonly VisualLayerDescriptor[];
  /** Caller maps a layer to a human label + icon (DATA, not a switch here). */
  readonly describeLayer: (layer: VisualLayerDescriptor) => LayerRowInfo;
  /** New front-to-back id order after a drag. */
  readonly onReorder: (orderedIds: string[]) => void;
  readonly onSetOpacity: (id: string, opacity: number) => void;
  readonly onToggleVisible: (id: string, visible: boolean) => void;
  readonly onRemove: (id: string) => void;
  /** "Add layer" choices (Color / Image / Grain / …) — DATA from the caller. */
  readonly addOptions: readonly LayerAddOption[];
  /** Per-layer settings editor (color wheel for a fill, amount slider for grain,
   *  fit for media), shown in an expandable drawer under the row. The panel
   *  stays blind to which editor renders — the caller maps the capability. */
  readonly renderLayerSettings?: (layer: VisualLayerDescriptor) => React.ReactNode;
  /** Empty-state copy, caller-supplied so the generic panel names no domain
   *  vocabulary (Physics-vs-Society). Defaults to a neutral prompt. */
  readonly emptyMessage?: string;
  readonly onDone: () => void;
}

/** Effective z for sort: explicit z, else array index. Front-most = highest z. */
function effectiveZ(layer: VisualLayerDescriptor, index: number): number {
  return layer.order?.z ?? index;
}

export function LayerStackPanel({
  layers,
  describeLayer,
  onReorder,
  onSetOpacity,
  onToggleVisible,
  onRemove,
  addOptions,
  renderLayerSettings,
  emptyMessage = 'No layers yet.',
  onDone,
}: LayerStackPanelProps) {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Display front-most first (top of the tree = nearest the viewer).
  const frontToBack = React.useMemo(
    () => layers.map((layer, index) => ({ layer, index })).sort((a, b) => effectiveZ(b.layer, b.index) - effectiveZ(a.layer, a.index)).map((entry) => entry.layer),
    [layers],
  );

  const items = frontToBack.map((layer) => {
    const info = describeLayer(layer);
    const visible = layer.enabled !== false;
    const opacity = layer.composite?.opacity ?? 1;
    const settings = renderLayerSettings?.(layer);
    const expanded = expandedId === layer.id;
    return {
      id: layer.id,
      content: (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 pr-1">
            <NamedIcon name={info.icon ?? 'Square'} size="sm" />
            <button
              type="button"
              onClick={() => settings && setExpandedId(expanded ? null : layer.id)}
              className="min-w-0 flex-1 truncate text-left text-xs text-[var(--text-primary)] hover:text-[var(--text-strong)]"
              title={settings ? 'Edit layer settings' : undefined}
            >
              {info.label}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacity}
              onChange={(e) => onSetOpacity(layer.id, Number(e.currentTarget.value))}
              aria-label={`${info.label} opacity`}
              className="w-16 accent-[var(--accent-purple,#8b5cf6)]"
              title={`Opacity ${Math.round(opacity * 100)}%`}
            />
            <ExpandableTabs
              mode="action"
              size="sm"
              ariaLabel={`${info.label} layer`}
              items={[
                ...(settings ? [{ id: 'settings', label: expanded ? 'Collapse settings' : 'Expand settings', icon: expanded ? 'ChevronUp' : 'ChevronDown', pinned: expanded }] : []),
                { id: 'visible', label: visible ? 'Hide layer' : 'Show layer', icon: visible ? 'Eye' : 'EyeOff' },
                { id: 'remove', label: 'Remove layer', icon: 'Trash2' },
              ]}
              onSelect={(id) => {
                if (id === 'settings') setExpandedId(expanded ? null : layer.id)
                else if (id === 'visible') onToggleVisible(layer.id, !visible)
                else if (id === 'remove') onRemove(layer.id)
              }}
            />
          </div>
          {expanded && settings && (
            <div className="mt-1 rounded-lg bg-[var(--glass-bg-subtle)] p-2">{settings}</div>
          )}
        </div>
      ),
    };
  });

  return (
    <div className="flex w-72 flex-col gap-2 p-1">
      <div className="flex items-center justify-between">
        <span className="text-[length:var(--font-size-caption)] font-medium text-[var(--text-muted)]">Layers</span>
        <Dropdown
          items={addOptions.map((option) => ({ value: option.id, label: option.label, icon: option.icon }))}
          value=""
          onValueChange={(id) => addOptions.find((option) => option.id === id)?.run()}
          customTrigger={
            <button
              type="button"
              aria-label="Add layer"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            >
              <NamedIcon name="Plus" size="sm" /> Add
            </button>
          }
          align="end"
        />
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-primary)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">
          {emptyMessage}
        </div>
      ) : (
        <DragReorderList items={items} onReorder={onReorder} />
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onDone}
          className="h-7 rounded-md px-2.5 text-xs bg-[var(--glass-bg-subtle)] text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)] transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// packages/addressed-marks/show/MarkToolbar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The drawing toolbar. Visible only while the mark session is enabled.
// Everything it offers is DATA: tools come from mark-tool records (label,
// icon, mapper/mode), colors come from mark-style records (screen-look tokens
// or saved custom colors), widths and fill are per-stroke style data carried
// on the operation. The color wheel SAVES custom colors as appended
// addressed-mark-style records through `action:record-addressed-mark-style` —
// a saved color is a record in current log state, persisted and shared like
// every other record. Undo appends a reference-effect operation hiding the
// newest visible path of the most recently drawn target — append-only,
// nothing is mutated.
//
// The toolbar is draggable by its grip: position is ephemeral session UI
// state (a CSS transform), not record truth.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero hardcoded tool/shape/color lists — records drive every control
// 2. All visuals through screen-look tokens + ui primitives (inline styles
//    only for data-driven values: drag transform, data-driven dot sizes,
//    color input value — the ColorDot exception class)
// 3. Undo/erase/custom-color write through package workflow actions
// 4. The toolbar never knows what space it floats above
// 5. Every control is shrink-0 — children are never squeezed invisible
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import React from 'react';
import {
  markTargetKey,
  materializeMarkRecords,
  readMarkOperationRecords,
  readMarkStyles,
  readMarkTools,
  type MarkStyleRecord,
  type MarkTarget,
  type MarkToolRecord,
} from '../read-data/addressed-marks';
import { recordMarkOperation } from '../do-work/record-mark-operation';
import { recordMarkStyle } from '../do-work/record-mark-style';
import { recordMarkTool } from '../do-work/record-mark-tool';
import { useMarkSession } from './MarkSessionContext';
import { useMarkOperations, useMarkStyles, useMarkTools } from './use-mark-data';
import {
  NamedIcon,
  ColorDot,
  ColorPickerPopover,
  cn,
  PositionCompass,
  createDockablePlacementStore,
  useDockablePlacement,
  selectDockIsVertical,
  type DockablePlacementState,
  type DockablePlacementStore,
} from '../../ui';

// Ephemeral toolbar placement: same generic dockable primitive the sidebar
// uses, with no persistence (session UI state, not record truth). Docked
// bottom is the default; the grip undocks into floating drag.
const TOOLBAR_PLACEMENT_DEFAULT: DockablePlacementState = {
  position: 'bottom',
  dockState: 'docked',
  mode: 'expanded',
  size: 0,
  floatRect: { x: 160, y: 160, w: 0, h: 0 },
};

const STROKE_WIDTH_CHOICES = [2, 3, 6, 12] as const;

const TOOL_BUTTON_CLASS = cn(
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors',
  'text-[var(--text-secondary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]',
);

const DIVIDER_CLASS = 'mx-1 h-6 w-px shrink-0 bg-[var(--border-primary)]';
const DIVIDER_CLASS_VERTICAL = 'my-1 h-px w-6 shrink-0 bg-[var(--border-primary)]';

function styleColor(style: MarkStyleRecord): string {
  if (style.stroke) return style.stroke;
  if (style.strokeToken) return `var(${style.strokeToken})`;
  return 'var(--color-info)';
}

function toolIsActive(tool: MarkToolRecord, activeToolRef: string, tools: readonly MarkToolRecord[]): boolean {
  return activeToolRef ? tool.id === activeToolRef : tool.id === tools[0]?.id;
}

export function MarkToolbar({ className, onDone }: {
  className?: string;
  /** Reports that the user finished drawing (Done). When the mounting owner
   *  derives the session's enabled state from its own mode (e.g. an active
   *  tool), it closes that mode here — the toolbar stays blind to what the
   *  owner's mode is. Standalone consumers may omit it; setEnabled(false)
   *  still runs either way. */
  onDone?: () => void;
}) {
  const session = useMarkSession();
  const feedTools = useMarkTools();
  const feedStyles = useMarkStyles();
  const operations = useMarkOperations();
  // Custom colors/shapes saved this session, shown immediately while the live
  // feed catches up (the record is the truth; this is just optimistic display).
  const [pendingStyles, setPendingStyles] = React.useState<readonly MarkStyleRecord[]>([]);
  const [pendingTools, setPendingTools] = React.useState<readonly MarkToolRecord[]>([]);
  const [colorPanelOpen, setColorPanelOpen] = React.useState(false);
  const [draftColor, setDraftColor] = React.useState('#4da3ff');
  // Anchor for the in-app color picker so it floats next to the Palette button
  // (portaled + auto-flipped) instead of the OS native picker landing top-of-screen.
  const colorTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [shapePanelOpen, setShapePanelOpen] = React.useState(false);
  const [draftSides, setDraftSides] = React.useState(6);

  const tools = React.useMemo(() => {
    const feedIds = new Set(feedTools.map((tool) => tool.id));
    return [...feedTools, ...pendingTools.filter((tool) => !feedIds.has(tool.id))];
  }, [feedTools, pendingTools]);

  // Placement: generic ui dockable primitive (per-instance store, ephemeral).
  const placementStoreRef = React.useRef<DockablePlacementStore | null>(null);
  if (!placementStoreRef.current) {
    placementStoreRef.current = createDockablePlacementStore(TOOLBAR_PLACEMENT_DEFAULT);
  }
  const placement = useDockablePlacement(placementStoreRef.current, TOOLBAR_PLACEMENT_DEFAULT);
  const floating = placement.dockState === 'floating';
  const vertical = !floating && selectDockIsVertical(placement);
  const pillRef = React.useRef<HTMLDivElement | null>(null);
  // Grip drag: when docked, the first drag undocks into floating at the
  // toolbar's current spot; while floating, drags move the float rect.
  const dragStateRef = React.useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const styles = React.useMemo(() => {
    const feedIds = new Set(feedStyles.map((style) => style.id));
    return [...feedStyles, ...pendingStyles.filter((style) => !feedIds.has(style.id))];
  }, [feedStyles, pendingStyles]);

  const undo = React.useCallback(() => {
    if (!session?.lastTarget) return;
    const feedIds = new Set(operations.map((operation) => operation.id));
    const optimistic = (session.optimisticOperations ?? []).filter((operation) => !feedIds.has(operation.id));
    const material = materializeMarkRecords({
      operations: [...operations, ...optimistic],
      styles,
      target: session.lastTarget,
    });
    const newest = [...material.paths].sort((left, right) => right.order - left.order
      || (right.operation.createdAt ?? '').localeCompare(left.operation.createdAt ?? ''))[0];
    if (!newest) return;
    const id = `mark:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    const write = {
      id,
      target: session.lastTarget,
      createdAt: new Date().toISOString(),
      body: { coordinate_sets: [], effects: { hide_refs: [newest.ref] } },
    };
    const echo = readMarkOperationRecords([{
      id: write.id,
      target: write.target,
      created_at: write.createdAt,
      body: write.body,
    }])[0];
    if (echo) session.addOptimisticOperation(echo);
    recordMarkOperation(write).catch((error) => {
      console.error('[AddressedMarks] undo failed', error);
    });
  }, [session, operations, styles]);

  // Clear all: hide every visible path on every drawn target. Append-only —
  // one hide_refs operation per target, ink history stays in the log. This is
  // the user's own recovery from accidental screen-covering ink (no agent,
  // no log surgery needed).
  const clearAll = React.useCallback(() => {
    if (!session) return;
    const feedIds = new Set(operations.map((operation) => operation.id));
    const all = [
      ...operations,
      ...(session.optimisticOperations ?? []).filter((operation) => !feedIds.has(operation.id)),
    ];
    const byTarget = new Map<string, { target: MarkTarget; refs: Set<string>; hidden: Set<string> }>();
    for (const operation of all) {
      const key = markTargetKey(operation.target);
      if (!byTarget.has(key)) byTarget.set(key, { target: operation.target, refs: new Set(), hidden: new Set() });
      const entry = byTarget.get(key)!;
      operation.body.coordinateSets.forEach((set, index) => {
        const ref = set.refs?.[0] ?? `${operation.id}:set:${index}`;
        if (set.points.length) entry.refs.add(ref);
      });
      const hideRefs = (operation.body.effects as Record<string, unknown>).hide_refs;
      if (Array.isArray(hideRefs)) {
        for (const ref of hideRefs) {
          if (typeof ref === 'string') entry.hidden.add(ref);
        }
      }
    }
    for (const { target, refs, hidden } of byTarget.values()) {
      const visible = [...refs].filter((ref) => !hidden.has(ref));
      if (!visible.length) continue;
      const write = {
        id: `mark:clear:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`,
        target,
        createdAt: new Date().toISOString(),
        body: { coordinate_sets: [], effects: { hide_refs: visible } },
      };
      const echo = readMarkOperationRecords([{
        id: write.id,
        target: write.target,
        created_at: write.createdAt,
        body: write.body,
      }])[0];
      if (echo) session.addOptimisticOperation(echo);
      recordMarkOperation(write).catch((error) => {
        console.error('[AddressedMarks] clear failed', error);
      });
    }
  }, [session, operations]);

  const saveCustomShape = React.useCallback(() => {
    if (!session) return;
    const sides = Math.max(3, Math.min(36, Math.round(draftSides)));
    const id = `tool:custom:${sides}gon:${Date.now().toString(36)}`;
    const write = {
      id,
      label: `${sides}-gon`,
      icon: 'Hexagon',
      order: 50,
      body: {
        coordinate_set: { closed: true },
        mapper: { kind: 'polygon', sides, closed: true, inscribed: true },
      },
    };
    setPendingTools((current) => [...current, ...readMarkTools([{
      id: write.id,
      label: write.label,
      icon: write.icon,
      order: write.order,
      body: write.body,
    }])]);
    session.setToolRef(id);
    setShapePanelOpen(false);
    recordMarkTool(write).catch((error) => {
      console.error('[AddressedMarks] save shape failed', error);
    });
  }, [session, draftSides]);

  const saveCustomColor = React.useCallback(() => {
    if (!session) return;
    const id = `style:custom:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
    const write = {
      id,
      label: 'Saved color',
      stroke: draftColor,
      strokeWidth: session.strokeWidth ?? 3,
      fill: 'none',
      order: 100,
    };
    setPendingStyles((current) => [...current, ...readMarkStyles([{
      id: write.id,
      label: write.label,
      stroke: write.stroke,
      stroke_width: write.strokeWidth,
      fill: write.fill,
      order: write.order,
    }])]);
    session.setStyleRef(id);
    setColorPanelOpen(false);
    recordMarkStyle(write).catch((error) => {
      console.error('[AddressedMarks] save color failed', error);
    });
  }, [session, draftColor]);

  if (!session?.enabled) return null;

  const activeWidth = session.strokeWidth
    ?? styles.find((style) => style.id === session.styleRef)?.strokeWidth
    ?? styles[0]?.strokeWidth
    ?? 3;

  // Sidebar-parity placement rendering:
  // - DOCKED: flush full-length strip touching its edge — no padding gap, no
  //   radius, no shadow, border only on the inner edge, NO grip.
  // - FLOATING: rounded glass panel with the drag grip (grip exists only here,
  //   exactly like the sidebar).
  // - COLLAPSED: slim strip with just the expand control.
  const wrapperClass = floating
    ? 'pointer-events-none absolute z-[10020]'
    : placement.position === 'bottom'
      ? 'pointer-events-none absolute inset-x-0 bottom-0 z-[10020]'
      : placement.position === 'top'
        ? 'pointer-events-none absolute inset-x-0 top-0 z-[10020]'
        : placement.position === 'left'
          ? 'pointer-events-none absolute left-0 inset-y-0 z-[10020]'
          : 'pointer-events-none absolute right-0 inset-y-0 z-[10020]';
  const dockedEdgeBorder = placement.position === 'bottom'
    ? 'border-t'
    : placement.position === 'top'
      ? 'border-b'
      : placement.position === 'left'
        ? 'border-r'
        : 'border-l';
  const panelAnchorClass = vertical
    ? (placement.position === 'left' ? 'left-full top-0 ml-2' : 'right-full top-0 mr-2')
    : placement.position === 'top' || (floating && placement.floatRect.y < 160)
      ? 'top-full left-1/2 mt-2 -translate-x-1/2'
      : 'bottom-full left-1/2 mb-2 -translate-x-1/2';
  const collapsed = placement.mode === 'collapsed';
  const expandChevron = placement.position === 'bottom'
    ? 'ChevronUp'
    : placement.position === 'top'
      ? 'ChevronDown'
      : placement.position === 'left' ? 'ChevronRight' : 'ChevronLeft';
  const collapseChevron = placement.position === 'bottom'
    ? 'ChevronDown'
    : placement.position === 'top'
      ? 'ChevronUp'
      : placement.position === 'left' ? 'ChevronLeft' : 'ChevronRight';

  const undock = () => {
    const pill = pillRef.current;
    const parent = pill?.offsetParent as HTMLElement | null;
    let base = { x: placement.floatRect.x, y: placement.floatRect.y };
    if (pill && parent) {
      const pillRect = pill.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      // Float near where the docked strip's center was.
      base = {
        x: Math.max(16, pillRect.left - parentRect.left + pillRect.width / 2 - 320),
        y: Math.max(16, pillRect.top - parentRect.top - 8),
      };
    }
    placement.set({ dockState: 'floating', floatRect: { ...placement.floatRect, ...base } });
  };

  if (collapsed) {
    return (
      <div className={wrapperClass} style={floating ? { left: placement.floatRect.x, top: placement.floatRect.y } : undefined}>
        <div
          data-testid="mark-toolbar"
          role="toolbar"
          aria-label="Drawing tools"
          className={cn(
            'pointer-events-auto flex items-center justify-center',
            floating
              ? 'rounded-2xl border shadow-2xl'
              : cn('rounded-none', dockedEdgeBorder, vertical ? 'h-full w-8 flex-col' : 'w-full h-8'),
            'border-[var(--border-primary)] bg-[var(--glass-bg-popover)] backdrop-blur-2xl',
            className,
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            title="Expand"
            aria-label="Expand"
            className={TOOL_BUTTON_CLASS}
            onClick={() => placement.setMode('expanded')}
          >
            <NamedIcon name={expandChevron} size="sm" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={wrapperClass}
      style={floating ? { left: placement.floatRect.x, top: placement.floatRect.y } : undefined}
    >
    <div
      ref={pillRef}
      data-testid="mark-toolbar"
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn(
        'pointer-events-auto relative flex items-center justify-center gap-1',
        floating
          ? 'max-w-[calc(100vw-2rem)] flex-wrap rounded-2xl border px-2 py-1.5 shadow-2xl'
          : cn(
              'rounded-none',
              dockedEdgeBorder,
              vertical
                ? 'h-full max-h-full flex-col overflow-y-auto px-1 py-2'
                : 'w-full max-w-full flex-wrap px-2 py-1',
            ),
        'border-[var(--border-primary)] bg-[var(--glass-bg-popover)] backdrop-blur-2xl',
        className,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {floating ? (
        <span
          role="button"
          aria-label="Move toolbar"
          title="Move toolbar"
          className={cn(
            'inline-flex h-9 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg',
            'text-[var(--text-muted)] hover:text-[var(--text-primary)] active:cursor-grabbing',
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            dragStateRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              baseX: placement.floatRect.x,
              baseY: placement.floatRect.y,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragStateRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            placement.setFloatRect({
              x: drag.baseX + (event.clientX - drag.startX),
              y: drag.baseY + (event.clientY - drag.startY),
            });
          }}
          onPointerUp={() => { dragStateRef.current = null; }}
          onPointerCancel={() => { dragStateRef.current = null; }}
        >
          <NamedIcon name="GripVertical" size="sm" />
        </span>
      ) : null}

      {tools.map((tool) => (
        <button
          key={tool.id}
          type="button"
          title={tool.label ?? tool.id}
          aria-label={tool.label ?? tool.id}
          aria-pressed={toolIsActive(tool, session.toolRef, tools)}
          className={cn(
            TOOL_BUTTON_CLASS,
            toolIsActive(tool, session.toolRef, tools) && 'bg-[var(--glass-bg-active)] text-[var(--text-primary)] ring-1 ring-inset ring-[var(--accent-primary)]',
          )}
          onClick={() => session.setToolRef(tool.id)}
        >
          <NamedIcon name={tool.icon ?? 'Pencil'} size="sm" />
        </button>
      ))}

      <button
        type="button"
        title="New shape"
        aria-label="New shape"
        aria-pressed={shapePanelOpen}
        className={cn(
          TOOL_BUTTON_CLASS,
          shapePanelOpen && 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]',
        )}
        onClick={() => setShapePanelOpen((open) => !open)}
      >
        <NamedIcon name="Shapes" size="sm" />
      </button>

      {shapePanelOpen ? (
        <div
          className={cn(
            cn('absolute z-10 flex items-center gap-2 rounded-2xl px-3 py-2', panelAnchorClass),
            'border border-[var(--border-primary)] bg-[var(--glass-bg-popover)] shadow-2xl backdrop-blur-2xl',
          )}
        >
          <label className="flex shrink-0 items-center gap-2 text-sm text-[var(--text-secondary)]">
            <span>Sides</span>
            <input
              type="number"
              min={3}
              max={36}
              value={draftSides}
              onChange={(event) => setDraftSides(Number(event.currentTarget.value))}
              className={cn(
                'h-9 w-16 shrink-0 rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]',
                'px-2 text-sm text-[var(--text-primary)] outline-none',
                'focus:border-[var(--accent-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]',
              )}
            />
          </label>
          <button
            type="button"
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition-colors',
              'bg-[var(--glass-bg-active)] text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]',
            )}
            onClick={saveCustomShape}
          >
            <span>Save shape</span>
            <NamedIcon name="Plus" size="sm" />
          </button>
        </div>
      ) : null}

      <button
        type="button"
        title="Fill shapes"
        aria-label="Fill shapes"
        aria-pressed={session.fillEnabled}
        className={cn(
          TOOL_BUTTON_CLASS,
          session.fillEnabled && 'bg-[var(--glass-bg-active)] text-[var(--text-primary)] ring-1 ring-inset ring-[var(--accent-primary)]',
        )}
        onClick={() => session.setFillEnabled(!session.fillEnabled)}
      >
        <NamedIcon name="PaintBucket" size="sm" />
      </button>

      <span aria-hidden="true" className={vertical ? DIVIDER_CLASS_VERTICAL : DIVIDER_CLASS} />

      {styles.map((style) => {
        const selected = session.styleRef ? style.id === session.styleRef : style.id === styles[0]?.id;
        return (
          <button
            key={style.id}
            type="button"
            title={style.label ?? style.id}
            aria-label={style.label ?? style.id}
            aria-pressed={selected}
            className={cn(
              'inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-xl transition-colors',
              'hover:bg-[var(--glass-bg-hover)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]',
              selected && 'bg-[var(--glass-bg-active)] ring-1 ring-inset ring-[var(--accent-primary)]',
            )}
            onClick={() => session.setStyleRef(style.id)}
          >
            <ColorDot color={styleColor(style)} size="lg" label={style.label ?? style.id} className="ring-1 ring-[var(--border-primary)]" />
          </button>
        );
      })}

      <button
        type="button"
        title="Custom color"
        aria-label="Custom color"
        aria-pressed={colorPanelOpen}
        className={cn(
          TOOL_BUTTON_CLASS,
          'w-8',
          colorPanelOpen && 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]',
        )}
        ref={colorTriggerRef}
        onClick={() => setColorPanelOpen((open) => !open)}
      >
        <NamedIcon name="Palette" size="sm" />
      </button>

      <ColorPickerPopover
        anchorRef={colorTriggerRef}
        open={colorPanelOpen}
        value={draftColor}
        onChange={setDraftColor}
        onDismiss={() => setColorPanelOpen(false)}
        onSave={saveCustomColor}
        presets={styles.map(styleColor)}
        placement={placement.position === 'top' ? 'below' : 'above'}
      />

      <span aria-hidden="true" className={vertical ? DIVIDER_CLASS_VERTICAL : DIVIDER_CLASS} />

      {STROKE_WIDTH_CHOICES.map((width) => (
        <button
          key={width}
          type="button"
          title={`Stroke ${width}px`}
          aria-label={`Stroke ${width} pixels`}
          aria-pressed={activeWidth === width}
          className={cn(
            TOOL_BUTTON_CLASS,
            'w-8',
            activeWidth === width && 'bg-[var(--glass-bg-active)] ring-1 ring-inset ring-[var(--accent-primary)]',
          )}
          onClick={() => session.setStrokeWidth(width)}
        >
          <span
            aria-hidden="true"
            className="shrink-0 rounded-full bg-[var(--text-primary)]"
            style={{ width: `${Math.min(width + 4, 16)}px`, height: `${Math.min(width + 4, 16)}px` }}
          />
        </button>
      ))}

      <span aria-hidden="true" className={vertical ? DIVIDER_CLASS_VERTICAL : DIVIDER_CLASS} />

      <button
        type="button"
        title={session.marksVisible ? 'Hide marks' : 'Show marks'}
        aria-label={session.marksVisible ? 'Hide marks' : 'Show marks'}
        aria-pressed={!session.marksVisible}
        className={cn(
          TOOL_BUTTON_CLASS,
          !session.marksVisible && 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]',
        )}
        onClick={() => session.setMarksVisible(!session.marksVisible)}
      >
        <NamedIcon name={session.marksVisible ? 'Eye' : 'EyeOff'} size="sm" />
      </button>

      <button
        type="button"
        title="Undo"
        aria-label="Undo"
        className={TOOL_BUTTON_CLASS}
        onClick={undo}
      >
        <NamedIcon name="Undo2" size="sm" />
      </button>

      <button
        type="button"
        title="Clear all marks"
        aria-label="Clear all marks"
        className={TOOL_BUTTON_CLASS}
        onClick={clearAll}
      >
        <NamedIcon name="Trash2" size="sm" />
      </button>

      {/* Placement controls — sidebar parity: Position compass, Collapse,
          Dock/Undock. Selecting an edge re-docks a floating toolbar. */}
      <span className="inline-flex shrink-0 items-center justify-center" title="Toolbar position">
        <PositionCompass
          current={placement.position}
          onSelect={(position) => placement.set({ position, dockState: 'docked' })}
        />
      </span>

      <button
        type="button"
        title="Collapse"
        aria-label="Collapse"
        className={TOOL_BUTTON_CLASS}
        onClick={() => placement.setMode('collapsed')}
      >
        <NamedIcon name={collapseChevron} size="sm" />
      </button>

      <button
        type="button"
        title={floating ? 'Dock' : 'Undock'}
        aria-label={floating ? 'Dock' : 'Undock'}
        className={TOOL_BUTTON_CLASS}
        onClick={() => {
          if (floating) placement.setDockState('docked');
          else undock();
        }}
      >
        <NamedIcon name={floating ? 'Pin' : 'PinOff'} size="sm" />
      </button>

      <button
        type="button"
        className={cn(
          'ml-1 inline-flex h-9 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors',
          'bg-[var(--glass-bg-active)] text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]',
        )}
        onClick={() => {
          session.setEnabled(false);
          onDone?.();
        }}
      >
        <span>Done</span>
        <NamedIcon name="Check" size="sm" />
      </button>
    </div>
    </div>
  );
}

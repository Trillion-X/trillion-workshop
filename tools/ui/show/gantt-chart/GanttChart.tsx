// parts/ui/show/gantt-chart/GanttChart.tsx
//
// PURPOSE
//   Bars on a time axis: a name column that stays in view, a two-row heading (months, then days or weeks), weekend
//   shading, a line for today, one bar per row and curves between the bars that follow one another. Product-neutral:
//   it draws rows, bars and an axis already worked out (trillion-workshop/tools/keep-lists-of-rows/read-data/schedule-bars.ts); it reads no
//   records and says no words of its own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every measure arrives as data (`rowPx`, the axis, each bar's left and width); nothing here is a fixed size.
//   2. The names are a sticky column in the same scroller as the bars, so they cannot drift from their rows.
//   3. Every bar and name is a real button; the chart draws no colour (a bar's colour arrives as `color`).
//   4. A bar changes only when its row says it may (`bar.edit`): dragged by its body or an end, or nudged from the keyboard
//      (Left/Right a day, Shift a day on the last end, Alt a day on the first end). The chart reports whole days and the
//      end taken hold of (`onReschedule`) and writes nothing; a bar that may not change says so when one is tried
//      (`onRefused`). A drag shorter than a few pixels is a press, which opens the record.

import * as React from 'react';
import '../../../screen-look/show/gantt-chart.css';

export interface GanttHeading {
  label: string;
  left: number;
  width: number;
  today?: boolean;
}

export interface GanttAxis {
  width: number;
  dayPx: number;
  months: readonly GanttHeading[];
  ticks: readonly GanttHeading[];
  weekends: readonly number[];
  weekLines: readonly number[];
  todayLeft: number | null;
}

export interface GanttRow {
  key: string;
  /** A heading that opens a group of rows, or a row that is one record. */
  kind: 'group' | 'record';
  label: string;
  /** How many rows a group holds. */
  count?: number;
  /** The bar for a record row; none for a record that has no dates. */
  bar?: { left: number; width: number; color: string; clipped: boolean; edit?: 'move' | 'resize' | 'refused' } | null;
  /** The words a bar says inside itself when it is wide enough. */
  barText?: boolean;
}

export interface GanttJoin {
  key: string;
  d: string;
  outOfOrder: boolean;
}

export interface GanttChartHandle {
  scrollToToday: (behavior: ScrollBehavior) => void;
}

export interface GanttChartProps {
  rows: readonly GanttRow[];
  axis: GanttAxis;
  joins: readonly GanttJoin[];
  rowPx: number;
  /** How far before today the scroll stops when it goes there. */
  leadPx: number;
  /** The heading over the name column. */
  namesLabel: string;
  /** When this changes the chart scrolls back to today (the axis is another width). */
  resetKey: string;
  onOpen?: (key: string) => void;
  /** A bar was changed: the end taken hold of and the whole days it moved (negative is earlier). */
  onReschedule?: (key: string, edge: GanttEdge, days: number) => void;
  /** A change was tried on a bar that may not change. */
  onRefused?: (key: string) => void;
  /** What a screen reader calls the two ends of a bar. */
  edgeLabels?: { start: string; end: string };
}

export type GanttEdge = 'move' | 'start' | 'end';
/** A pointer that moves less than this many pixels pressed the bar, it did not drag it. */
const DRAG_THRESHOLD_PX = 4;

type Drag = { key: string; edge: GanttEdge; x: number; days: number; moved: boolean };

export const GanttChart = React.forwardRef<GanttChartHandle, GanttChartProps>(function GanttChart({ rows, axis, joins, rowPx, leadPx, namesLabel, resetKey, onOpen, onReschedule, onRefused, edgeLabels }, ref) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const scrollToToday = React.useCallback((behavior: ScrollBehavior) => {
    if (axis.todayLeft !== null) scroller.current?.scrollTo({ left: Math.max(0, axis.todayLeft - leadPx), behavior });
  }, [axis.todayLeft, leadPx]);
  React.useImperativeHandle(ref, () => ({ scrollToToday }), [scrollToToday]);
  // Opens at today, and again at today when the axis changes width.
  React.useLayoutEffect(() => scrollToToday('auto'), [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const dragRef = React.useRef<Drag | null>(null);
  const suppressClick = React.useRef(false);
  const setDragged = (next: Drag | null) => { dragRef.current = next; setDrag(next); };
  const begin = (event: React.PointerEvent, row: GanttRow, edge: GanttEdge) => {
    if (event.button !== 0 || !row.bar) return;
    suppressClick.current = false;
    if (row.bar.edit !== 'move' && row.bar.edit !== 'resize') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragged({ key: row.key, edge, x: event.clientX, days: 0, moved: false });
  };
  const track = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    setDragged({ ...current, days: Math.round(dx / axis.dayPx), moved: current.moved || Math.abs(dx) >= DRAG_THRESHOLD_PX });
  };
  const finish = () => {
    const current = dragRef.current;
    // A handle's pointer-up also reaches the bar; preserve the first finish's click suppression.
    if (!current) return;
    setDragged(null);
    suppressClick.current = Boolean(current?.moved);
    if (current?.moved && current.days !== 0) onReschedule?.(current.key, current.edge, current.days);
  };
  const press = (row: GanttRow) => {
    // The click that ends a drag is not a press.
    if (suppressClick.current) { suppressClick.current = false; return; }
    onOpen?.(row.key);
  };
  const nudge = (event: React.KeyboardEvent, row: GanttRow) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!direction || event.metaKey || event.ctrlKey || !row.bar) return;
    event.preventDefault();
    if (row.bar.edit !== 'move' && row.bar.edit !== 'resize') { onRefused?.(row.key); return; }
    const edge: GanttEdge = event.altKey ? 'start' : event.shiftKey ? 'end' : 'move';
    if (edge !== 'move' && row.bar.edit !== 'resize') { onRefused?.(row.key); return; }
    onReschedule?.(row.key, edge, direction);
  };
  const shown = (row: GanttRow) => {
    const bar = row.bar!;
    if (!drag || drag.key !== row.key) return { left: bar.left, width: bar.width };
    const shift = drag.days * axis.dayPx;
    if (drag.edge === 'move') return { left: bar.left + shift, width: bar.width };
    if (drag.edge === 'start') { const left = Math.min(bar.left + shift, bar.left + bar.width - axis.dayPx); return { left, width: bar.left + bar.width - left }; }
    return { left: bar.left, width: Math.max(axis.dayPx, bar.width + shift) };
  };
  const height = rows.length * rowPx;
  return (
    <div className="gantt-chart-scroll" data-gantt-chart="" ref={scroller} style={{ '--gantt-row': `${rowPx}px`, '--gantt-width': `${axis.width}px` } as React.CSSProperties}>
      <div className="gantt-chart-names" role="rowgroup">
        <div className="gantt-chart-corner">{namesLabel}</div>
        {rows.map(row => row.kind === 'group'
          ? <div key={row.key} className="gantt-chart-name" data-group=""><span className="gantt-chart-name-text">{row.label}</span><span className="gantt-chart-count">{row.count}</span></div>
          : <button key={row.key} type="button" className="gantt-chart-name" data-undated={row.bar ? undefined : ''} onClick={() => onOpen?.(row.key)}><span className="gantt-chart-name-text">{row.label}</span></button>)}
      </div>
      <div className="gantt-chart-time">
        <div className="gantt-chart-head">
          <div className="gantt-chart-months">{axis.months.map(month => <span key={month.left} style={{ left: month.left, width: month.width }}>{month.label}</span>)}</div>
          <div className="gantt-chart-ticks">{axis.ticks.map(tick => <span key={tick.left} data-today={tick.today ? '' : undefined} style={{ left: tick.left, width: tick.width }}>{tick.label}</span>)}</div>
        </div>
        <div className="gantt-chart-grid" style={{ height }}>
          {axis.weekends.map(left => <i key={`weekend:${left}`} className="gantt-chart-weekend" style={{ left, width: axis.dayPx }} />)}
          {axis.weekLines.map(left => <i key={`week:${left}`} className="gantt-chart-weekline" style={{ left }} />)}
          {rows.map((row, index) => row.kind === 'group' ? <i key={row.key} className="gantt-chart-group" style={{ top: index * rowPx }} /> : null)}
          {axis.todayLeft !== null ? <i className="gantt-chart-today" style={{ left: axis.todayLeft }} aria-hidden="true" /> : null}
          {rows.map((row, index) => {
            if (row.kind !== 'record' || !row.bar) return null;
            const box = shown(row);
            const live = drag?.key === row.key;
            const resizable = row.bar.edit === 'resize';
            return (
              <button key={row.key} type="button" className="gantt-chart-bar" data-clipped={row.bar.clipped ? '' : undefined} data-edit={row.bar.edit} data-dragging={live && drag.moved ? '' : undefined} aria-label={row.label}
                style={{ left: box.left, width: box.width, top: index * rowPx, '--gantt-bar': row.bar.color } as React.CSSProperties}
                onClick={() => press(row)} onKeyDown={event => nudge(event, row)}
                onPointerDown={event => begin(event, row, 'move')} onPointerMove={track} onPointerUp={finish} onPointerCancel={() => setDragged(null)}>
                {resizable ? <span className="gantt-chart-handle" data-edge="start" role="presentation" aria-label={edgeLabels?.start}
                  onPointerDown={event => { event.stopPropagation(); begin(event, row, 'start'); }} onPointerMove={track} onPointerUp={finish} onPointerCancel={() => setDragged(null)} /> : null}
                {row.barText ? <span className="gantt-chart-bar-text">{row.label}</span> : null}
                {resizable ? <span className="gantt-chart-handle" data-edge="end" role="presentation" aria-label={edgeLabels?.end}
                  onPointerDown={event => { event.stopPropagation(); begin(event, row, 'end'); }} onPointerMove={track} onPointerUp={finish} onPointerCancel={() => setDragged(null)} /> : null}
              </button>
            );
          })}
          <svg className="gantt-chart-joins" width={axis.width} height={height} viewBox={`0 0 ${axis.width} ${height}`} aria-hidden="true">
            <defs><marker id="gantt-chart-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="currentColor" /></marker></defs>
            {joins.map(join => <path key={join.key} d={join.d} data-out-of-order={join.outOfOrder ? '' : undefined} markerEnd="url(#gantt-chart-arrow)" />)}
          </svg>
        </div>
      </div>
    </div>
  );
});

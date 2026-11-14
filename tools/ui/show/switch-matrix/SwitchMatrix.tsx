// parts/ui/show/switch-matrix/SwitchMatrix.tsx
//
// PURPOSE
//   One table of switches: rows (a kind of thing) by columns (a way, a place), each cell an on/off switch. Built on the
//   shared Table and Switch. The label column has a fixed width and stays in place while the columns scroll sideways,
//   every cell is the same width so switches line up under their column, and when columns run past the edge a fade at
//   that edge says there is more. Anatomy follows Slack's and Linear's notification settings and 21st.dev #22226
//   (Notification Channel Matrix); original code.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every cell's switch has an accessible name "<row>: <column>"; nothing is only colour.
//   2. A row label never wraps to one word per line: the label column is never narrower than `labelWidth`.
//   3. Appearance lives in screen-look/show/switch-matrix.css; this file names the parts only.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Switch } from '../switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table';

export type SwitchMatrixColumn = { id: string; label: string };
export type SwitchMatrixRow = { id: string; label: string; on: string[] };
export type SwitchMatrixProps = {
  columns: SwitchMatrixColumn[];
  rows: SwitchMatrixRow[];
  onChange: (row: SwitchMatrixRow, columnId: string, on: boolean) => void;
  /** The label column's width in CSS pixels (default 224). */
  labelWidth?: number;
  /** Each switch column's width in CSS pixels (default 112). */
  cellWidth?: number;
  /** The accessible name of the whole table. */
  label?: string;
};

export function SwitchMatrix({ columns, rows, onChange, labelWidth = 224, cellWidth = 112, label }: SwitchMatrixProps) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [more, setMore] = React.useState(false);
  React.useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const measure = () => setMore(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => { element.removeEventListener('scroll', measure); observer?.disconnect(); };
  }, [columns.length]);
  const sizes = { '--matrix-label': `${labelWidth}px`, '--matrix-cell': `${cellWidth}px` } as React.CSSProperties;
  return (
    <div className="ui-switch-matrix" data-more={more || undefined} style={sizes}>
      <div ref={scroller} className="ui-switch-matrix-scroll" tabIndex={more ? 0 : undefined} role={more ? 'region' : undefined} aria-label={more ? label : undefined}>
        <Table className="ui-switch-matrix-table" aria-label={label}>
          <TableHeader>
            <TableRow className="ui-switch-matrix-row">
              <TableHead className="ui-switch-matrix-label" scope="col"><span className="ui-switch-matrix-hidden">{label}</span></TableHead>
              {columns.map(column => <TableHead key={column.id} className="ui-switch-matrix-head" scope="col">{column.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => (
              <TableRow key={row.id} className="ui-switch-matrix-row">
                <TableHead className="ui-switch-matrix-label" scope="row">{row.label}</TableHead>
                {columns.map(column => (
                  <TableCell key={column.id} className="ui-switch-matrix-cell" coarsePointerTarget>
                    <Switch size="sm" label={`${row.label}: ${column.label}`} checked={row.on.includes(column.id)} onCheckedChange={on => onChange(row, column.id, on)} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

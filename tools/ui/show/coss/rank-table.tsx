// parts/ui/show/coss/rank-table.tsx
//
// PURPOSE
//   People or things by place, drawn from a guide section's `table` DATA as a table: a quiet uppercase header (#, the
//   name column's label, then the caller's columns, an accent column in the accent colour), and one row each with its
//   place as an ordinal ("1st"), the person's mark (show/display-mark), the name with a small tag badge, then the cells
//   right-aligned. The reader's own row is lit, and where places are left out a quiet centred uppercase line says so
//   after the place the caller names (`gap.after_place`). Anatomy follows the Promethee leaderboard from the community captures: "1st" in a narrow first column, avatar, name and tag
//   badge, numbers right-aligned with the last column in the accent, and the "46 more people are not shown" line.
//   Checked against 21st.dev's "Leaderboard Table" (arihantcodes, id 30672): tabular numbers, a name with a quiet line
//   under it, and a tinted mark for the first three places. Dropped from them: photo avatars, streak stars, up/down
//   movement chevrons the caller rarely has honestly, and the dark palette.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words: every column label, cell, name and gap line is the caller's DATA. The only
//      words it adds are the ordinal endings of a place.
//   2. Nothing is shown that the caller did not send: a missing cell is left empty, never zero.
//   3. Controls are the licensed Coss sources (Table, Badge, Button through press-action.tsx); appearance lives
//      in screen-look/show/guide.css (`.rank-table-*`).

import * as React from 'react';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { DisplayMark } from '../display-mark';
import { PressAction } from './press-action';
import type { GuideActionHandler, GuideTable } from './guide';

const ORDINAL_RULES = new Intl.PluralRules('en', { type: 'ordinal' });
const ORDINAL_ENDINGS: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export function ordinalOf(place: number): string {
  return `${place}${ORDINAL_ENDINGS[ORDINAL_RULES.select(place)] ?? 'th'}`;
}

type TableRowData = GuideTable['rows'][number];

function NameCell({ row, onAction }: { row: TableRowData; onAction: GuideActionHandler }) {
  const name = (
    <span className="rank-table-person">
      <DisplayMark spec={{ name: row.name }} size="md" />
      <span className="rank-table-names">
        <span className="rank-table-name">
          <span className="rank-table-name-text">{row.name}</span>
          {row.tag ? <Badge variant="outline" className="rank-table-tag">{row.tag}</Badge> : null}
        </span>
        {row.detail ? <span className="rank-table-detail">{row.detail}</span> : null}
      </span>
    </span>
  );
  return row.action ? <PressAction action={row.action} onAction={onAction} className="rank-table-open">{name}</PressAction> : name;
}

export function RankTable({ table, onAction }: { table: GuideTable; onAction: GuideActionHandler }) {
  const width = 2 + table.columns.length;
  if (!table.rows.length) return table.empty ? <p className="rank-table-empty">{table.empty}</p> : null;
  return (
    <Table className="rank-table">
      <TableHeader>
        <TableRow className="rank-table-head-row">
          <TableHead className="rank-table-place-head">#</TableHead>
          <TableHead className="rank-table-name-head">{table.name_label ?? ''}</TableHead>
          {table.columns.map(column => (
            <TableHead key={column.id} className="rank-table-column-head" data-align={column.align ?? 'end'} data-accent={column.accent ? '' : undefined}>{column.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.rows.map(row => (
          <React.Fragment key={row.id}>
            <TableRow className="rank-table-row" data-highlight={row.highlight ? '' : undefined} data-place={row.place && row.place <= 3 ? row.place : undefined}>
              <TableCell className="rank-table-place">{typeof row.place === 'number' ? ordinalOf(row.place) : ''}</TableCell>
              <TableCell className="rank-table-name-cell"><NameCell row={row} onAction={onAction} /></TableCell>
              {table.columns.map(column => (
                <TableCell key={column.id} className="rank-table-cell" data-align={column.align ?? 'end'} data-accent={column.accent ? '' : undefined}>{row.cells[column.id] ?? ''}</TableCell>
              ))}
            </TableRow>
            {table.gap && row.place === table.gap.after_place ? (
              <TableRow className="rank-table-gap-row">
                <TableCell className="rank-table-gap" colSpan={width}>{table.gap.text}</TableCell>
              </TableRow>
            ) : null}
          </React.Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

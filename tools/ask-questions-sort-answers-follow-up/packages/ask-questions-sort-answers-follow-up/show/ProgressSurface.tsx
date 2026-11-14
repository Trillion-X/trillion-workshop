// packages/ask-questions-sort-answers-follow-up/show/ProgressSurface.tsx
//
// The RESPONDENT'S OWN progress surface: their session-quality / focus over time,
// plus a per-session log. A generic projection of the respondent's answer-facts
// (ProgressModel) — reuses ui Card / StatStrip / LineChart / Table, zero inline
// styling, ZERO dashboard-package import (the data owner renders its own history
// with shared primitives, L098/L093). Honest-empty until the student submits (no
// fabricated sessions, L117). Columns + the trend label are DATA (from the view
// descriptor), never hardcoded domain fields (L090).

import React from 'react';
import { LineChart } from 'lucide-react';
import { Card } from '@/packages/ui/show/card/Card';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';
import { StatStrip } from '@/packages/ui/show/stat-strip/StatStrip';
import { LineChart as LineChartViz } from '@/packages/ui/show/line-chart/LineChart';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/packages/ui/show/table/Table';
import { WorkStartState } from '@/packages/ui/show/work-start-state/WorkStartState';
import type { ProgressModel } from '@/packages/ask-questions-sort-answers-follow-up/read-data/progress-model';

/** A column of the session log: which output field, and its human header. DATA. */
export interface ProgressColumn {
  field: string;
  label: string;
}

export interface ProgressSurfaceProps {
  model: ProgressModel;
  /** Column defs from the view descriptor. Absent -> derive from the rows' fields. */
  columns?: ProgressColumn[];
  /** Header for the built-in session-date column. */
  dateLabel?: string;
  /** Header/label for the trend chart. */
  trendLabel?: string;
}

/** Derive columns from the rows when none are declared: every mapped field key,
 *  minus the answeredAt time axis (shown as the Date column). No domain enum. */
function deriveColumns(model: ProgressModel): ProgressColumn[] {
  const keys = new Set<string>();
  for (const row of model.rows) for (const k of Object.keys(row.fields)) if (k !== 'answeredAt') keys.add(k);
  return [...keys].map((field) => ({ field, label: field }));
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return '—';
  return String(value);
}

export function ProgressSurface({ model, columns, dateLabel = 'Date', trendLabel }: ProgressSurfaceProps) {
  if (model.count === 0) {
    return (
      <Card padding="lg">
        <WorkStartState
          icon={LineChart}
          title="Your progress starts with your first session"
          description="Log a practice session and your focus and goals will chart here over time."
        />
      </Card>
    );
  }

  const cols = columns && columns.length > 0 ? columns : deriveColumns(model);

  return (
    <Card padding="lg">
      <Container layout="vertical" gap="md" alignItems="stretch">
        <StatStrip
          stats={[
            { label: 'Sessions', value: String(model.count) },
            ...(model.trend && model.trend.points.length > 0
              ? [{ label: trendLabel ?? model.trend.field, value: String(model.trend.points[model.trend.points.length - 1]) }]
              : []),
          ]}
        />
        {model.trend ? (
          <LineChartViz
            points={model.trend.points}
            height="md"
            emptyTitle="Not enough sessions yet"
            emptyDescription="Two sessions draw your first trend line."
          />
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{dateLabel}</TableHead>
              {cols.map((c) => (
                <TableHead key={c.field}>{c.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...model.rows].reverse().map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Text variant="body-xs" color="muted">
                    {typeof row.fields.answeredAt === 'string' ? row.fields.answeredAt.slice(0, 10) : row.label}
                  </Text>
                </TableCell>
                {cols.map((c) => (
                  <TableCell key={c.field}>
                    <Text variant="body-xs">{cell(row.fields[c.field])}</Text>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Container>
    </Card>
  );
}

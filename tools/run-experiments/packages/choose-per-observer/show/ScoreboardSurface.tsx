// packages/choose-per-observer/show/ScoreboardSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The experiment scoreboard — a CONFIGURATION of the shared visual-database, not a
// bespoke screen. Rows are page versions; columns are DATA metric descriptors;
// the hero is the leader + win probability; per-row + hero status come from the
// DATA status descriptor's option tones (L090). The only owner action is
// "Choose winner".
//
// THE GENERIC TEST (must stay YES): a new metric column or a new result status
// appears by adding a DATA row in data/scoreboard-descriptors.ts — ZERO change
// here. This file names no metric, no status, no candidate concept. Cardinality
// is emergent: N=0 -> empty copy, N=1 -> a plain single row (no experiment
// chrome), N>=2 -> the full board — ONE render path, no branch on count around
// the board itself.
//
// Render states (all designed): loading (skeleton), error, empty (N=0), sparse
// (N=1 note), dense, no-significance ("not enough data yet" — never a fake
// winner, L117), mobile (table -> stacked cards via useNarrowViewport), desktop
// (table).
//
// fey-grade via @/packages/ui + @/packages/visual-database only. Zero raw HTML,
// zero inline styles, zero className hacking (L065/L066).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Trophy, BarChart3 } from 'lucide-react';
import {
  Badge,
  Bar,
  Button,
  Card,
  Container,
  EmptyPlaceholder,
  Icon,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  WorkSkeletonRows,
  useNarrowViewport,
} from '@/packages/ui';
import {
  decodeVisualDatabaseModel,
  extractFieldValue,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '@/packages/visual-database/read-data/visual-database';
import { displayTitle, statusTone } from '@/packages/visual-database/show/field-editors';
import { RecordMetricRow } from '@/packages/visual-database/show/RecordMetricRow';
import {
  SCOREBOARD_COPY,
  SCOREBOARD_STATUS_FIELD_ID,
  type ScoreboardCopy,
} from '@/packages/choose-per-observer/data/scoreboard-descriptors';
import { formatMetric } from '@/packages/choose-per-observer/show/metric-format';
import type { ScoreboardViewModel } from '@/packages/choose-per-observer/show/scoreboard-view-model';

export interface ScoreboardSurfaceProps {
  /** The decoded view-model (read-data owns I/O; this surface is blind). */
  viewModel: ScoreboardViewModel;
  /** True while results are loading. */
  loading?: boolean;
  /** Set when results failed to load. */
  error?: boolean;
  /** Owner action — promote the leading version to everyone. Absent disables it. */
  onChooseWinner?: () => void;
  /** Copy override (DATA). Defaults to the ethos first-use copy. */
  copy?: ScoreboardCopy;
}

/** Metric columns = every descriptor the DATA marked as role 'metric'. The
 *  surface never names a metric; it reads them from the decoded model. */
function metricColumns(model: VisualDatabaseModel): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((field) => field.role === 'metric');
}

// ---------------------------------------------------------------------------
// Hero — leader + win probability + significance. No fake winner.
// ---------------------------------------------------------------------------

function ScoreboardHero({ viewModel, copy }: { viewModel: ScoreboardViewModel; copy: ScoreboardCopy }) {
  const { hero } = viewModel;
  const pct = hero.winProbability != null ? Math.round(hero.winProbability * 100) : null;
  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="md" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap padding="none">
          <Text variant="overline" color="faint">
            {hero.decided ? copy.leaderLabel : copy.winProbabilityLabel}
          </Text>
          <Badge variant={hero.decided ? 'success' : 'muted'} size="sm">
            {hero.decided ? copy.leaderLabel : copy.noSignificance}
          </Badge>
        </Container>
        <Container layout="horizontal" gap="md" alignItems="end" wrap padding="none">
          {pct != null ? (
            <Text variant="display" color="strong" mono tabular leading="tight">{`${pct}%`}</Text>
          ) : (
            <Text variant="display" color="strong" leading="tight">{hero.leaderLabel ?? '—'}</Text>
          )}
          {pct != null && hero.leaderLabel && (
            <Text variant="heading-lg" color="secondary">{hero.leaderLabel}</Text>
          )}
        </Container>
        {pct != null && (
          <Bar
            height="sm"
            segments={[{ percent: pct, variant: hero.decided ? 'success' : 'info', title: copy.winProbabilityLabel }]}
          />
        )}
        {!hero.decided && <Text variant="caption" color="faint">{copy.noSignificance}</Text>}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One metric cell, formatted through the DATA-driven registry.
// ---------------------------------------------------------------------------

function MetricCellValue({ record, descriptor, currencySymbol }: {
  record: VisualDatabaseRecord;
  descriptor: VisualDatabaseFieldDescriptor;
  currencySymbol: string;
}) {
  const { value } = formatMetric(extractFieldValue(record, descriptor), descriptor, { currencySymbol });
  return <Text variant="body-xs" mono tabular>{value}</Text>;
}

// ---------------------------------------------------------------------------
// Desktop table: version + status dot, then metric columns.
// ---------------------------------------------------------------------------

function ScoreboardTable({ model, copy, currencySymbol }: {
  model: VisualDatabaseModel;
  copy: ScoreboardCopy;
  currencySymbol: string;
}) {
  const columns = metricColumns(model);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{copy.versionColumnLabel}</TableHead>
          {columns.map((column) => (
            <TableHead key={column.id}>{column.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {model.records.map((record) => {
          const status = statusTone(record, model, SCOREBOARD_STATUS_FIELD_ID);
          return (
            <TableRow key={record.id}>
              <TableCell>
                <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
                  {status && <StatusDot status={status.status} color={status.color} size="sm" pulse={status.active} />}
                  <Text variant="body-xs" weight="semibold" truncate>{displayTitle(record)}</Text>
                </Container>
              </TableCell>
              {columns.map((column) => (
                <TableCell key={column.id}>
                  <MetricCellValue record={record} descriptor={column} currencySymbol={currencySymbol} />
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Mobile cards: each version stacks its metric strip (RecordMetricRow).
// ---------------------------------------------------------------------------

function ScoreboardCards({ model, copy, currencySymbol }: {
  model: VisualDatabaseModel;
  copy: ScoreboardCopy;
  currencySymbol: string;
}) {
  const columns = metricColumns(model);
  return (
    <Container layout="vertical" gap="sm" padding="none">
      {model.records.map((record) => {
        const status = statusTone(record, model, SCOREBOARD_STATUS_FIELD_ID);
        return (
          <Card key={record.id} variant="nested" padding="sm" layout="column">
            <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
              {status && <StatusDot status={status.status} color={status.color} size="sm" pulse={status.active} />}
              <Text variant="body" weight="semibold" truncate>{displayTitle(record)}</Text>
            </Container>
            <RecordMetricRow
              record={record}
              descriptors={columns}
              formatValue={(value, descriptor) => formatMetric(value, descriptor, { currencySymbol })}
              align="start"
            />
          </Card>
        );
      })}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function ScoreboardSurface({ viewModel, loading, error, onChooseWinner, copy = SCOREBOARD_COPY }: ScoreboardSurfaceProps) {
  const model = React.useMemo(() => decodeVisualDatabaseModel(viewModel.boardInput), [viewModel.boardInput]);
  const narrow = useNarrowViewport();

  if (loading) {
    return (
      <Container layout="vertical" gap="lg" data-testid="scoreboard-surface">
        <Card variant="surface" padding="lg"><WorkSkeletonRows rows={2} /></Card>
        <Card variant="surface" padding="lg"><WorkSkeletonRows rows={4} /></Card>
      </Container>
    );
  }

  if (error) {
    return (
      <Container layout="vertical" gap="lg" data-testid="scoreboard-surface">
        <Card variant="surface" padding="lg">
          <EmptyPlaceholder icon={BarChart3} message={copy.errorMessage} />
        </Card>
      </Container>
    );
  }

  // Empty (N=0): no versions to compare yet.
  if (viewModel.candidateCount === 0) {
    return (
      <Container layout="vertical" gap="lg" data-testid="scoreboard-surface">
        <Card variant="surface" padding="lg" layout="column">
          <Container layout="vertical" gap="md" padding="none">
            <Text variant="heading-lg">{copy.emptyTitle}</Text>
            <EmptyPlaceholder icon={BarChart3} message={copy.emptyMessage} />
          </Container>
        </Card>
      </Container>
    );
  }

  // Sparse (N=1): a plain page, no experiment chrome — but the SAME board render
  // path (cardinality is emergent; this only swaps copy/chrome, not the board).
  const sparse = viewModel.candidateCount === 1;

  return (
    <Container layout="vertical" gap="lg" data-testid="scoreboard-surface">
      {!sparse && <ScoreboardHero viewModel={viewModel} copy={copy} />}

      <Card variant="surface" padding="lg" layout="column">
        <Container layout="vertical" gap="md" padding="none">
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap padding="none">
            <Text variant="heading-lg">{copy.heading}</Text>
            {!sparse && onChooseWinner && (
              <Button variant="primary" size="md" onClick={onChooseWinner}>
                <Icon icon={Trophy} size="sm" />
                {copy.chooseWinner}
              </Button>
            )}
          </Container>

          {sparse && <Text variant="caption" color="faint">{copy.sparseNote}</Text>}

          {narrow ? (
            <ScoreboardCards model={model} copy={copy} currencySymbol={copy.currencySymbol} />
          ) : (
            <ScoreboardTable model={model} copy={copy} currencySymbol={copy.currencySymbol} />
          )}
        </Container>
      </Card>
    </Container>
  );
}

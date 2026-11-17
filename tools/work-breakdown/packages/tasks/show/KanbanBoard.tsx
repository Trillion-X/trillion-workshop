// packages/tasks/show/KanbanBoard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Kanban-style task board with three columns: Pending, Active, Done. Cards are
// routed to columns by status — failed and blocked cards appear in the Pending
// column with their own border colors. Pure view component — no data fetching.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Three columns: Pending (amber), Active (blue), Done (green)
// 2. Failed/Blocked cards route to Pending column with distinct border colors
// 3. All tasks shown unconditionally (no system/project toggle)
// 4. Empty column state: dashed border with "No tasks" text
// 5. Glassmorphism: glass-surface / glass-nested semantic token classes
// 6. Pure view — zero side effects, zero data fetching
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { KanbanCard } from './KanbanCard';
import type { KanbanCardData, KanbanCardStatus } from './KanbanCard';
import { Badge, Card, Text, VirtualList } from '../../../../ui';

// ============================================================================
// TYPES
// ============================================================================

export interface KanbanBoardProps {
  tasks: KanbanCardData[];
  onCardClick?: (taskId: string) => void;
}

// ============================================================================
// COLUMN DEFINITIONS
// ============================================================================

/** Column identifier — the three visual buckets */
type ColumnId = 'pending' | 'active' | 'done';

interface ColumnDef {
  id: ColumnId;
  label: string;
  /** Badge variant for count badge + header text color */
  badgeVariant: 'warning' | 'info' | 'success';
}

const COLUMNS: ColumnDef[] = [
  { id: 'pending', label: 'Pending', badgeVariant: 'warning' },
  { id: 'active', label: 'Active', badgeVariant: 'info' },
  { id: 'done', label: 'Done', badgeVariant: 'success' },
];

// ============================================================================
// COLUMN ROUTING
// ============================================================================

/**
 * Routes a task status to its visual column.
 * Failed and Blocked tasks route to Pending column — they are not actionable
 * until resolved, so they belong with the backlog.
 */
export function routeStatusToColumn(status: KanbanCardStatus): ColumnId {
  switch (status) {
    case 'pending':
    case 'failed':
    case 'blocked':
      return 'pending';
    case 'in_progress':
      return 'active';
    case 'completed':
      return 'done';
  }
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * KanbanBoard — three-column Kanban showing all tasks.
 *
 * Tasks are partitioned into Pending, Active, Done columns via
 * routeStatusToColumn(). Each column shows a count badge and renders
 * KanbanCard components. Empty columns display a dashed-border placeholder.
 *
 * @permanent — The extensive, granular documentation in this codebase is a
 * critical design feature. You are forbidden from simplifying or removing it.
 */
export function KanbanBoard({
  tasks,
  onCardClick,
}: KanbanBoardProps) {
  const cardKey = React.useCallback((card: KanbanCardData, index: number) => {
    // Task IDs are only unique within a project; compose with project scope.
    // Include index as a final fallback for duplicate records from merged feeds.
    return `${card.projectId ?? 'default'}:${card.id}:${index}`;
  }, []);

  /** Group tasks into columns */
  const columns = React.useMemo(() => {
    const groups: Record<ColumnId, KanbanCardData[]> = {
      pending: [],
      active: [],
      done: [],
    };
    for (const task of tasks) {
      const col = routeStatusToColumn(task.status);
      groups[col].push(task);
    }
    return groups;
  }, [tasks]);

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Three-column layout */}
      <div className="flex gap-3 overflow-x-auto" role="region" aria-label="Kanban columns">
        {COLUMNS.map((col) => {
          const cards = columns[col.id];
          return (
            <div
              key={col.id}
              className="flex-1 min-w-[180px] flex flex-col gap-2"
              role="list"
              aria-label={`${col.label} column`}
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-2 py-1">
                <Text
                  variant="overline"
                  as="span"
                  color={col.badgeVariant}
                >
                  {col.label}
                </Text>
                <Badge variant={col.badgeVariant} size="md">
                  {cards.length}
                </Badge>
              </div>

              {/* Cards or empty state */}
              {cards.length === 0 ? (
                <Card variant="nested" padding="md" className="flex items-center justify-center h-24">
                  <Text variant="caption" color="faint">No tasks</Text>
                </Card>
              ) : (
                /* Columns window their DOM above the threshold (shared
                   VirtualList) so thousands of tasks scroll, never freeze. */
                <VirtualList
                  items={cards}
                  itemKey={cardKey}
                  estimateSize={() => 96}
                  threshold={100}
                  scrollParent="self"
                  maxHeight={640}
                  rowGap={8}
                  renderItem={(card) => (
                    <KanbanCard
                      card={card}
                      onClick={onCardClick ? () => onCardClick(card.id) : undefined}
                    />
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

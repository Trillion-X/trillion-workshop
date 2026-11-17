// packages/tasks/show/KanbanCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A single Kanban card representing a task. Renders task ID, title, truncated
// description, status indicator (left border color), agent count badge, and
// optional completion date. Pure view component — no data fetching, no side
// effects.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Left border color determined by task status:
//    pending=amber-400, in_progress=blue-400, completed=emerald-400,
//    failed=red-400, blocked=orange-400
// 2. Glassmorphism card: bg-[var(--glass-bg-subtle)], hover:bg-[var(--glass-bg-hover)], rounded-lg
// 3. Description truncated to 2 lines via line-clamp-2
// 4. Pure view — zero side effects, zero data fetching
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Users } from 'lucide-react';
import { Badge, Card, Text, Icon } from '../../../../ui';

// ============================================================================
// TYPES
// ============================================================================

/** Status values a Kanban card can have */
export type KanbanCardStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked';

/** Data shape for a single Kanban card */
export interface KanbanCardData {
  id: string;
  /** Optional project scope used for stable React keys in multi-project boards */
  projectId?: string;
  title: string;
  status: KanbanCardStatus;
  agentCount: number;
  completedAt: string | null;
  isSystemTask: boolean;
  description: string;
}

export interface KanbanCardProps {
  card: KanbanCardData;
  onClick?: () => void;
}

// ============================================================================
// STATUS STYLING
// ============================================================================

/** Maps task status to a CSS border color */
function statusBorderColor(status: KanbanCardStatus): string {
  switch (status) {
    case 'pending':
      return 'var(--color-warning)';
    case 'in_progress':
      return 'var(--color-info)';
    case 'completed':
      return 'var(--color-success)';
    case 'failed':
      return 'var(--color-error)';
    case 'blocked':
      return '#EA860F';
  }
}

/** Maps task status to a short display label */
export function statusLabel(status: KanbanCardStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'in_progress':
      return 'Active';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Blocked';
  }
}

/** Maps task status to Badge variant */
function statusBadgeVariant(status: KanbanCardStatus): 'warning' | 'info' | 'success' | 'error' {
  switch (status) {
    case 'pending':
    case 'blocked':
      return 'warning';
    case 'in_progress':
      return 'info';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
  }
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * KanbanCard — renders a single task as a compact glassmorphism card.
 *
 * The left border color indicates status. A status pill badge appears in the
 * top-right corner. The bottom row shows agent count and completion date.
 *
 * @permanent — The extensive, granular documentation in this codebase is a
 * critical design feature. You are forbidden from simplifying or removing it.
 */
export function KanbanCard({ card, onClick }: KanbanCardProps) {
  return (
    <Card
      variant="surface"
      padding="md"
      interactive
      onClick={onClick}
      className="w-full text-left border-l-2"
      style={{ borderLeftColor: statusBorderColor(card.status) }}
      aria-label={`Task ${card.id}: ${card.title}`}
    >
      {/* Top row: task ID + status badge */}
      <div className="flex items-center justify-between mb-1">
        <Text variant="caption" mono color="muted" as="span">{card.id}</Text>
        <Badge variant={statusBadgeVariant(card.status)} size="md">
          {statusLabel(card.status)}
        </Badge>
      </div>

      {/* Title */}
      <Text variant="body" className="leading-tight mb-1">
        {card.title}
      </Text>

      {/* Description — truncated to 2 lines */}
      {card.description && (
        <Text variant="label" color="muted" className="line-clamp-2 mb-2">
          {card.description}
        </Text>
      )}

      {/* Bottom row: agent count + completion date */}
      <div className="flex items-center justify-between">
        <Text variant="caption" color="muted" as="span" className="flex items-center gap-1">
          <Icon icon={Users} size="xs" />
          {card.agentCount}
        </Text>
        {card.completedAt && (
          <Text variant="caption" color="muted" as="span">{card.completedAt}</Text>
        )}
      </div>
    </Card>
  );
}

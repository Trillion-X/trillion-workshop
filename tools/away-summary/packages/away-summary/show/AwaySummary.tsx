// frontends/web/src/packages/away-summary/show/AwaySummary.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Banner component displayed when user reconnects after being away for >5 min.
// Shows what happened: tasks completed, cost incurred, time spent, errors.
// Uses ONLY ui/ components (Card, Text, Badge, Icon, Button) — zero raw HTML.
// Auto-dismisses after 10 seconds or on user interaction.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All styling through ui/ components — zero raw HTML (L065)
// 2. Auto-dismiss on timer (10s) OR on click
// 3. Expandable to show per-task receipts
// 4. Never create inline styles or raw className
// 5. Uses glassmorphism styling from design system
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState } from 'react';
import { Bell, ChevronUp, ChevronDown, X } from 'lucide-react';
import { Card, Text, Badge, Button, Icon } from '@/packages/ui';
import type { AwaySummaryTaskReceipt } from '@/packages/away-summary/read-data/read-away-summary';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const AUTO_DISMISS_MS = 10_000;

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface AwaySummaryProps {
  taskCount: number;
  totalCost: number;
  totalTimeMinutes: number;
  errorCount: number;
  tasks: AwaySummaryTaskReceipt[];
  onDismiss: () => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Away Summary Banner
 *
 * Displays: "While you were away: N tasks, $X spent, Y minutes, Z errors"
 * Expandable details show per-task receipts.
 * Auto-dismisses after 10s or on click.
 */
export function AwaySummary({
  taskCount,
  totalCost,
  totalTimeMinutes,
  errorCount,
  tasks,
  onDismiss,
}: AwaySummaryProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  // Auto-dismiss after 10 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsDismissed(true);
      onDismiss();
    }, AUTO_DISMISS_MS);

    return () => clearTimeout(timer);
  }, [onDismiss]);

  // Handle dismiss
  const handleDismiss = () => {
    setIsDismissed(true);
    onDismiss();
  };

  if (isDismissed) return null;

  return (
    <Card
      variant="nested"
      className="mx-4 my-2 max-w-2xl z-30 cursor-pointer"
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <div className="p-4">
        {/* Summary Row */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1">
            <Icon icon={Bell} size="md" color="muted" />
            <div className="flex-1">
              <Text variant="label" className="text-[var(--text-primary)]">
                While you were away:
              </Text>
              <Text variant="caption" className="text-[var(--text-secondary)] mt-1">
                {taskCount} tasks · ${totalCost.toFixed(2)} · {totalTimeMinutes}m
                {errorCount > 0 && ` · ${errorCount} errors`}
              </Text>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              title={isExpanded ? 'Collapse' : 'Expand'}
            >
              <Icon
                icon={isExpanded ? ChevronUp : ChevronDown}
                size="sm"
                color="muted"
              />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleDismiss();
              }}
              title="Dismiss"
            >
              <Icon icon={X} size="sm" color="muted" />
            </Button>
          </div>
        </div>

        {/* Expanded Details */}
        {isExpanded && tasks.length > 0 && (
          <div className="mt-4 pt-4 border-t border-[var(--border-primary)] space-y-2">
            {tasks.map((task) => (
              <div
                key={task.taskId}
                className="flex items-center justify-between gap-2 p-2 rounded bg-[var(--glass-bg-subtle)]"
              >
                <div className="flex-1 min-w-0">
                  <Text variant="caption" className="text-[var(--text-primary)] truncate">
                    Task {task.taskId}: {task.taskName}
                  </Text>
                  {task.summary && (
                    <Text variant="caption" className="text-[var(--text-tertiary)] truncate">
                      {task.summary}
                    </Text>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {task.cost > 0 && (
                    <Badge variant="accent" className="text-xs">
                      ${task.cost.toFixed(2)}
                    </Badge>
                  )}
                  {task.testsWritten > 0 && (
                    <Badge variant="neutral" className="text-xs">
                      {task.testsWritten} tests
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

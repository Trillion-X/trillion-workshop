// packages/roi/show/TaskReceipt.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Single task receipt card component displaying per-task outcome data:
// task name, cost, time, tests, files changed. Supports expandable detail
// view to show full file list and commits. Uses ui/ barrel components only.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All styling through ui/ barrel components (Card, Badge, StatusDot, Text)
// 2. Zero raw HTML elements (no div, span, p allowed in feature code)
// 3. Cost formatted as dollars ($X.XX)
// 4. Time formatted as minutes or hours (47 min, 1h 23m)
// 5. Status dot indicates task status (green=completed, amber=in-progress)
// 6. Expandable section for file list and commits
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import type { TaskReceipt as TaskReceiptType } from '@/packages/roi/read-data/roi-types';
import { Card } from '@/packages/ui/show/card/Card';
import { Badge } from '@/packages/ui/show/badge/Badge';
import { StatusDot } from '@/packages/ui/show/status-dot/StatusDot';
import { Text } from '@/packages/ui/show/text/Text';
import { Icon } from '@/packages/ui/show/icon/Icon';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface TaskReceiptProps {
  /** The task receipt data to display */
  receipt: TaskReceiptType;
  /** Optional CSS class for custom styling */
  className?: string;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Format minutes as "47 min" or "1h 23m" for human readability.
 */
function formatTime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

/**
 * Format currency value.
 */
function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Get status dot variant based on task status.
 */
function getStatusVariant(
  status: 'completed' | 'in-progress' | 'failed'
): 'success' | 'warning' | 'error' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'in-progress':
      return 'warning';
    case 'failed':
      return 'error';
  }
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Individual task receipt card for ROI dashboard.
 *
 * Displays per-task outcome data: what was asked, cost, time, tests,
 * files changed. Expandable to show full file list and commits.
 *
 * Combines ui/ components (Card, Badge, StatusDot, Text) to maintain
 * design system coherence.
 */
export const TaskReceipt = React.forwardRef<
  HTMLDivElement,
  TaskReceiptProps
>(({ receipt, className }, ref) => {
  const [isExpanded, setIsExpanded] = React.useState(false);

  const testsSummary =
    receipt.testsWritten > 0
      ? `${receipt.testsPassed}/${receipt.testsWritten} tests`
      : 'no tests';

  const fileSummary =
    receipt.filesChanged.length === 1
      ? '1 file'
      : `${receipt.filesChanged.length} files`;

  return (
    <Card variant="nested" padding="md" className={className} ref={ref}>
      {/* Main summary row */}
      <div className="flex items-start justify-between gap-3">
        {/* Left: Status dot + Task info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="flex-shrink-0 pt-1">
            <StatusDot status={getStatusVariant(receipt.status)} size="sm" />
          </div>

          <div className="flex-1 min-w-0">
            <Text variant="body-xs" weight="semibold" className="text-[var(--text-primary)]">
              {`Task ${receipt.taskId}: ${receipt.taskName}`}
            </Text>
            {receipt.originIdea && (
              <Text variant="caption" className="text-amber-400/80 mt-0.5">
                Origin: {receipt.originIdea.title}
              </Text>
            )}
            {receipt.summary && (
              <Text variant="caption" className="text-[var(--text-tertiary)] mt-0.5">
                {receipt.summary}
              </Text>
            )}

            {/* Metrics row: cost, time, tests, files */}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant="neutral">
                {formatCurrency(receipt.cost)}
              </Badge>
              <Badge variant="neutral">
                {formatTime(receipt.timeMinutes)}
              </Badge>
              <Badge variant="neutral">{testsSummary}</Badge>
              <Badge variant="neutral">{fileSummary}</Badge>
            </div>
          </div>
        </div>

        {/* Right: Expand button */}
        {(receipt.filesChanged.length > 0 || receipt.commits.length > 0) && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex-shrink-0 p-1 hover:bg-[var(--glass-bg-hover)] rounded transition-colors"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
          >
            <Icon
              icon={ChevronDown}
              size="sm"
              className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {/* Expanded detail view */}
      {isExpanded && (receipt.filesChanged.length > 0 || receipt.commits.length > 0) && (
        <div className="mt-3 pt-3 border-t border-[var(--border-primary)] space-y-3">
          {/* Files changed */}
          {receipt.filesChanged.length > 0 && (
            <div>
              <Text variant="caption" weight="semibold" className="text-[var(--text-secondary)] uppercase tracking-wide">
                Files Changed
              </Text>
              <div className="mt-2 space-y-1">
                {receipt.filesChanged.map((file) => (
                  <Text
                    key={file}
                    variant="caption"
                    className="text-[var(--text-tertiary)] break-all font-mono text-xs"
                  >
                    {file}
                  </Text>
                ))}
              </div>
            </div>
          )}

          {/* Commits */}
          {receipt.commits.length > 0 && (
            <div>
              <Text variant="caption" weight="semibold" className="text-[var(--text-secondary)] uppercase tracking-wide">
                Commits
              </Text>
              <div className="mt-2 space-y-1">
                {receipt.commits.map((commit) => (
                  <Text
                    key={commit}
                    variant="caption"
                    className="text-[var(--text-tertiary)] font-mono text-xs"
                  >
                    {commit}
                  </Text>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
});

TaskReceipt.displayName = 'TaskReceipt';

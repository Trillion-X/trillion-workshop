// packages/group/show/CriticalPathPanel.tsx
//
// The bottleneck surface for the critical-path primitive: the chain of dependent goals that gates a vision,
// over the generic RankedJumpList (the TENTH caller). Each row is a goal on the critical chain with its
// remaining effort; the goal that dominates the chain is marked the bottleneck. The header answers "how
// much work stands between me and this vision, and what is holding it up" — or, honestly, "add an estimate"
// when a goal has no measured pace, or "circular dependency" when the plan cannot finish. Effort labels
// reuse the time-log leaf's formatDuration (hours -> ms), so there is no new formatter. `now` is injected.
// A row jumps to that goal. ui only.

import { RankedJumpList, type RankedRow } from './RankedJumpList';
import { formatDuration } from '../read-data/board-time-log';
import type { CriticalPathResult } from '../read-data/board-critical-path';

export interface CriticalPathPanelProps {
  readonly result: CriticalPathResult;
  readonly labelOf: (id: string) => string;
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

const HOUR_MS = 3_600_000;
const hoursLabel = (h: number): string => formatDuration(h * HOUR_MS);

function subtitleOf(result: CriticalPathResult, labelOf: (id: string) => string): string {
  if (result.cycleDetected) return 'Circular dependency — this plan cannot finish.';
  if (result.finishHours === null) {
    const n = result.unknownDurationIds.length;
    return `Add an estimate to ${n} goal${n === 1 ? '' : 's'} to schedule (${hoursLabel(result.knownFinishHours)} known so far).`;
  }
  const bottleneck = result.primaryBottleneckId ? labelOf(result.primaryBottleneckId) : null;
  return bottleneck
    ? `${hoursLabel(result.finishHours)} of work on the critical chain · bottleneck: ${bottleneck}`
    : `${hoursLabel(result.finishHours)} of work on the critical chain`;
}

export function CriticalPathPanel({ result, labelOf, onJumpTo, onClose }: CriticalPathPanelProps): JSX.Element {
  const rows: RankedRow[] = result.criticalPath.map((id) => {
    const node = result.nodes.find((n) => n.id === id);
    const hours = node?.durationHours ?? null;
    return {
      id,
      label: labelOf(id),
      badge: hours !== null ? hoursLabel(hours) : 'no estimate',
      note: id === result.primaryBottleneckId ? 'bottleneck' : undefined,
    };
  });
  return (
    <RankedJumpList
      title="Critical path"
      subtitle={subtitleOf(result, labelOf)}
      rows={rows}
      emptyText="Link goals as sub-goals to see what gates this vision."
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}

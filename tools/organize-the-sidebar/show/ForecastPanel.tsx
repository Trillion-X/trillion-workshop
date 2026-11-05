// packages/group/show/ForecastPanel.tsx
//
// The projection surface for the forecast primitive: every goal with a pace, ordered risk-first, over the
// generic RankedJumpList (the NINTH caller). Each row reads in the user's language — a verdict badge ("On
// track" / "Behind" / "Stalled" / "Done" / "On pace") and a plain ETA line ("finishes in 9 days") or, when
// stalled, the pace it would take ("needs 3/hr to make it"). The header tallies at-risk vs on-pace. The ETA
// label reuses the due-date leaf's relativeDue reader, so there is no new date formatter. `now` is injected
// by the shell (no clock here). A row jumps to that goal. ui only.

import { RankedJumpList, type RankedRow } from './RankedJumpList.tsx';
import { relativeDue } from '../read-data/board-due-date.ts';
import type { PaceVerdict } from '../read-data/board-forecast.ts';
import type { ForecastRow, ForecastSummary } from '../do-work/board-forecast-actions.ts';

export interface ForecastPanelProps {
  readonly rows: readonly ForecastRow[];
  readonly summary: ForecastSummary;
  readonly now: number;
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

const VERDICT_LABEL: Record<PaceVerdict, string> = {
  complete: 'Done',
  ahead: 'On track',
  behind: 'Behind',
  stalled: 'Stalled',
  moving: 'On pace',
};

/** The muted second line: an ETA for a moving goal, or the pace a stalled goal needs. */
function noteOf(row: ForecastRow, now: number): string | undefined {
  const f = row.forecast;
  if (f.verdict === 'complete') return undefined;
  if (f.verdict === 'stalled') {
    return f.requiredVelocityPerHour !== null
      ? `needs ${Math.round(f.requiredVelocityPerHour * 10) / 10}/hr to make it`
      : 'no recent progress';
  }
  return f.projectedMs !== null ? `finishes ${relativeDue(f.projectedMs, now).label}` : undefined;
}

export function ForecastPanel({ rows, summary, now, onJumpTo, onClose }: ForecastPanelProps): JSX.Element {
  const listRows: RankedRow[] = rows.map((r) => ({
    id: r.memberId,
    label: r.label,
    badge: VERDICT_LABEL[r.forecast.verdict],
    note: noteOf(r, now),
  }));
  const subtitle = `${summary.atRisk} at risk · ${summary.onPace} on pace`;
  return (
    <RankedJumpList
      title="Forecast"
      subtitle={subtitle}
      rows={listRows}
      emptyText="Add a goal with a target + logged time to forecast a finish."
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}

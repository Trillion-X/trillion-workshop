// parts/ui/show/coss/trend-lines.tsx
//
// PURPOSE
//   A few numbers over time, each a tile: its label, where it stands now in the display face, a line under it saying
//   what changed, and the line of every point drawn by the shared chart (parts/ui/show/chart). The line is
//   green when it moved the way that counts as better for that number and amber when it did not, so "faster" and
//   "more often" read the same way whichever direction the number runs.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: labels, values, details and points are the caller's DATA; `unit` only picks how a point reads.
//   2. Fewer than two points draws no line, never an invented one; the tile still says where it stands.
//   3. Appearance lives in screen-look/show/guide.css (`.trend-*`).

import * as React from 'react';
import { Chart } from '../chart/Chart';
import { chartOfPoints } from '../chart/chart-from-records';

export type TrendLine = { id: string; label: string; value: string; detail?: string; points: { t: number; value: number }[]; unit?: string; better?: 'lower' | 'higher' };

// The chart tone of a line that moved the better way, the worse way, or not at all.
const TONES = { success: 'good', error: 'warning', neutral: undefined } as const;

const toneOf = (line: TrendLine) => {
  if (line.points.length < 2) return 'neutral' as const;
  const first = line.points[0].value, last = line.points[line.points.length - 1].value;
  if (first === last) return 'neutral' as const;
  return (line.better === 'higher' ? last > first : last < first) ? 'success' as const : 'error' as const;
};

export function TrendLines({ lines }: { lines: TrendLine[] }) {
  return (
    <div className="trend-lines">
      {lines.map(line => (
        <div key={line.id} className="trend-tile" data-tone={toneOf(line)}>
          <p className="trend-label">{line.label}</p>
          <p className="trend-value">{line.value}</p>
          {line.detail ? <p className="trend-detail">{line.detail}</p> : null}
          {line.points.length >= 2 ? (
            <Chart className="trend-chart" mark="sparkline" height={48} label={`${line.label}: ${line.value}`} data={chartOfPoints(line.points, { label: line.label, value_kind: line.unit, tone: TONES[toneOf(line)] })} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

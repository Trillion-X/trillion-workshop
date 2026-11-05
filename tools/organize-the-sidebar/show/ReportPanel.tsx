// packages/group/show/ReportPanel.tsx
//
// The board REPORT / insights panel — the product surface for the generic reducer family (board-report.ts,
// b179/b180). Pick a reduction (Count / Aggregate / Distribution / Matrix) × dimension × measure and see the
// grouped rows; CLICK a row to select its cards (b180 — reportRows.cardIds → onSelect), tying reports into the
// selection subsystem. Fully BLIND (L090): the pickers fold `REDUCTION_OPTIONS`/`DIMENSION_OPTIONS`/
// `MEASURE_OPTIONS` from the b179 catalogs, so a new reduction/dimension/measure appears here with ZERO panel
// code, and irrelevant pickers are hidden per reduction (L118). One generic panel replaces the ~dozen hardcoded
// single-report readouts (BoardBalanceReadout, BoardCyclesReadout, …) as DATA.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { useState, type ReactNode } from 'react';
import { Button, Container, Text } from '../../ui/index.ts';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { reportRows } from '../read-data/board-report.ts';
import { reportToCsv } from '../read-data/report-export.ts';
import { ReportRowSelectControl } from './ReportRowSelectControl.tsx';
import {
  REDUCTION_OPTIONS, DIMENSION_OPTIONS, MEASURE_OPTIONS, type ReportOption,
  reportControlRelevance, buildReportDescriptor, formatReportValue,
  type ReportControls, DEFAULT_REPORT_CONTROLS,
} from './report-controls.ts';

export interface ReportPanelProps {
  readonly items: readonly BoardItem[];
  /** Called with the card ids of a report row when it's clicked — the board selects that group. */
  readonly onSelect: (ids: string[]) => void;
  /** Controlled picker state — provide with `onControlsChange` to drive the panel externally (e.g. to re-open a
   *  saved report). When absent the panel manages its own state (starting at census × kind). */
  readonly controls?: ReportControls;
  readonly onControlsChange?: (controls: ReportControls) => void;
  /** A slot rendered above the pickers — used for the saved-reports strip. */
  readonly children?: ReactNode;
  /** When provided, an "Export CSV" button appears; it's called with the current report serialised to CSV (the
   *  board copies it to the clipboard / downloads it). */
  readonly onExportCsv?: (csv: string) => void;
}

/** A single-choice segmented control over `options` — a row of ghost buttons, the chosen one `primary`. */
function Picker({ label, options, value, onChange }: { label: string; options: readonly ReportOption[]; value: string; onChange: (key: string) => void }) {
  return (
    <Container layout="vertical" gap="xs">
      <Text variant="label">{label}</Text>
      <Container layout="horizontal" gap="xs" style={{ flexWrap: 'wrap' }}>
        {options.map((o) => (
          <Button key={o.key} variant={o.key === value ? 'primary' : 'ghost'} size="sm" aria-label={`${label}: ${o.label}`} onClick={() => onChange(o.key)}>
            {o.label}
          </Button>
        ))}
      </Container>
    </Container>
  );
}

/** The insights panel: pickers (only the relevant ones shown) + the grouped rows for the current report.
 *  Controlled (via `controls`/`onControlsChange`) or self-managed. */
export function ReportPanel({ items, onSelect, controls: controlledControls, onControlsChange, children, onExportCsv }: ReportPanelProps) {
  const [internal, setInternal] = useState<ReportControls>(DEFAULT_REPORT_CONTROLS);
  const controls = controlledControls ?? internal;
  const set = (patch: Partial<ReportControls>) => {
    const next = { ...controls, ...patch };
    if (onControlsChange) onControlsChange(next);
    else setInternal(next);
  };
  const { reduction, dimension, colDimension, measure } = controls;

  const rel = reportControlRelevance(reduction);
  const desc = buildReportDescriptor(reduction, dimension, measure, colDimension);
  const rows = reportRows(items, desc);

  return (
    <Container layout="vertical" gap="sm" padding="sm" aria-label="Board report">
      {children}
      <Picker label="Report" options={REDUCTION_OPTIONS} value={reduction} onChange={(k) => set({ reduction: k })} />
      {rel.dimension && <Picker label="Group by" options={DIMENSION_OPTIONS} value={dimension} onChange={(k) => set({ dimension: k })} />}
      {rel.colDimension && <Picker label="Columns" options={DIMENSION_OPTIONS} value={colDimension} onChange={(k) => set({ colDimension: k })} />}
      {rel.measure && <Picker label="Measure" options={MEASURE_OPTIONS} value={measure} onChange={(k) => set({ measure: k })} />}
      <Container layout="vertical" gap="xs" aria-label="Report rows">
        {rows.length === 0 ? (
          <Text variant="body-sm">No data for this report yet.</Text>
        ) : (
          rows.map((r, i) => (
            <Button key={`${r.label}-${i}`} variant="ghost" size="sm" aria-label={`row ${r.label}`} onClick={() => onSelect([...r.cardIds])}>
              <Container layout="horizontal" gap="sm" style={{ justifyContent: 'space-between', width: '100%' }}>
                <Text variant="body-sm">{r.label}</Text>
                <Text variant="body-sm" style={{ fontWeight: 700 }}>{formatReportValue(desc, r.value)}</Text>
              </Container>
            </Button>
          ))
        )}
      </Container>
      <ReportRowSelectControl rows={rows} onSelect={onSelect} />
      {onExportCsv && rows.length > 0 && (
        <Button variant="ghost" size="sm" aria-label="Export CSV" onClick={() => onExportCsv(reportToCsv(items, desc))}>
          Export CSV
        </Button>
      )}
    </Container>
  );
}

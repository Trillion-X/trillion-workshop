// packages/group/read-data/report-export.ts
//
// Export a board REPORT (b179/b180) to portable formats — take an insight to a spreadsheet. `reportToCsv`
// serialises the report's grouped rows (label + value) to RFC-4180 CSV, reusing `board-csv`'s `csvField` quoting
// (one CSV-escaping SSOT, L100). The column headers come from the report's own DATA catalogs (dimension label →
// group column, reduction label → value column), so the export names nothing specific (L090). Markdown export
// already exists — that IS `runReport` (this adds the CSV form). Pure, deterministic.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { BoardItem } from './group-board-model.ts';
import { type ReportDescriptor, reportRows, dimensionDefById, reductionDefByKey } from './board-report.ts';
import { csvField } from '../do-work/board-csv.ts';

/**
 * Serialise a report's rows to CSV. The header is `<dimension label>,<reduction label>` (falling back to
 * `Group,Value`); each row is `<group label>,<value>` with the raw numeric value (blank for a null/unmeasured
 * value — a spreadsheet wants the number, not a formatted "50%"). Reuses `board-csv`'s RFC-4180 quoting. Pure.
 */
export function reportToCsv(items: readonly BoardItem[], desc: ReportDescriptor): string {
  const dim = desc.dimension ? dimensionDefById(desc.dimension) : null;
  const red = reductionDefByKey(desc.reduction);
  const header = `${csvField(dim?.label ?? 'Group')},${csvField(red?.label ?? 'Value')}`;
  const body = reportRows(items, desc).map((r) => `${csvField(r.label)},${r.value === null ? '' : String(r.value)}`);
  return [header, ...body].join('\n');
}

/** Markdown form of a report — an alias for `runReport` so callers have a symmetric `reportTo*` export surface. */
export { runReport as reportToMarkdown } from './board-report.ts';

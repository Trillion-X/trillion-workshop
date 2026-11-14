// parts/ui/show/comparison-table/ComparisonTable.tsx
//
// Purpose: a side-by-side comparison. One row per feature, one column per option. Each cell is a
// yes/no mark or a written value ("5 decisions/month", "Unlimited decisions/month"). It is a real
// <table> with column headers and scoped row headers, so a screen reader and an AI reading the page
// get the same structured grid a person sees.
//
// Source: adapted from the 21st.dev "Feature Comparison Table" (component id 21218, by 7ovr): the
// column header, check / cross / value cells and the tinted recommended column. Rewritten on the
// page's own tokens (--surface-base, --text-primary, --border-primary, and --plan-accent, falling back to --accent-purple), with no
// table kit and no hard-coded plans: columns and rows are props. Layout cues also follow the Mobbin
// references Mora and Hashnode "Compare plans" (feature column left, one column per plan, values
// written out, ticks and crosses for yes/no).
//
// Invariants:
// 1. Knows no feature, plan or price: every word arrives in `columns` and `rows`.
// 2. A row has one cell per column, in column order; a missing cell reads as not included.
// 3. A yes/no cell always carries readable text ("Included" / "Not included").
// 4. The highlighted column is tinted in the header and in every cell.
// 5. Phone widths fit every column on screen (tighter padding and type); anything still wider scrolls
//    sideways with the feature column pinned.

import { Fragment } from 'react';
import { Check, X } from 'lucide-react';

/** One option compared: a plan, a tier, a product. */
export type ComparisonColumn = {
  id: string;
  name: string;
  /** The price or short line under the name. */
  detail?: string;
  highlighted?: boolean;
};

/** A cell: a yes/no mark, or a written value (which also counts as included). */
export type ComparisonCell = { included: boolean; value?: string };

export type ComparisonRow = { id: string; label: string; cells: readonly ComparisonCell[] };

export type ComparisonTableProps = {
  /** What the table compares, read out as its caption. */
  caption: string;
  /** The heading of the feature column. */
  featureHeading: string;
  columns: readonly ComparisonColumn[];
  rows: readonly ComparisonRow[];
  /** Row spacing and type size: `compact` for a table that sits under fuller cards. */
  density?: 'comfortable' | 'compact';
};

function Cell({ cell }: { cell: ComparisonCell }) {
  // A value may break after a slash ("decisions/" then "month") so a narrow column never overflows.
  if (cell.included && cell.value) {
    return (
      <span className="comparison-table__value">
        {cell.value.split('/').map((part, index) => (index ? <Fragment key={index}>/<wbr />{part}</Fragment> : part))}
      </span>
    );
  }
  return (
    <span className="comparison-table__mark" data-included={cell.included ? 'true' : 'false'}>
      {cell.included ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <X size={13} strokeWidth={3} aria-hidden="true" />}
      <span className="comparison-table__sr">{cell.included ? 'Included' : 'Not included'}</span>
    </span>
  );
}

const STYLE = `
  .comparison-table { width: 100%; overflow-x: auto; border: 1px solid var(--border-primary); border-radius: 16px; background: var(--ground-surface, var(--surface-base)); }
  .comparison-table table { width: 100%; min-width: 34rem; border-collapse: collapse; table-layout: fixed; font-size: 0.98rem; }
  .comparison-table caption { caption-side: top; text-align: left; padding: 1.1rem 1.25rem 0.4rem; color: var(--words-secondary, var(--text-secondary)); font-size: 0.8rem; font-weight: 800; }
  .comparison-table th, .comparison-table td { padding: 0.9rem 1.25rem; border-top: 1px solid var(--border-primary); text-align: center; vertical-align: middle; }
  .comparison-table thead th { border-top: 0; background: var(--ground-surface, var(--surface-base)); vertical-align: bottom; }
  .comparison-table th[scope="row"], .comparison-table thead th:first-child { position: sticky; left: 0; z-index: 1; width: 44%; text-align: left; background: var(--ground-surface, var(--surface-base)); color: var(--words-primary, var(--text-primary)); font-weight: 700; line-height: 1.45; }
  .comparison-table__name { display: block; color: var(--words-primary, var(--text-primary)); font-family: var(--font-display); font-size: 1.2rem; font-weight: 750; }
  .comparison-table__detail { display: block; margin-top: 0.25rem; color: var(--words-secondary, var(--text-secondary)); font-size: 0.9rem; font-weight: 650; }
  .comparison-table__feature-heading { color: var(--words-secondary, var(--text-secondary)); font-size: 0.8rem; font-weight: 800; }
  .comparison-table [data-highlighted="true"] { background: color-mix(in srgb, var(--ground-surface, var(--surface-base)) 90%, var(--plan-accent, var(--accent-purple)) 10%); }
  .comparison-table__value { color: var(--words-primary, var(--text-primary)); font-weight: 800; }
  .comparison-table__mark { display: inline-flex; width: 1.4rem; height: 1.4rem; align-items: center; justify-content: center; border-radius: 999px; }
  .comparison-table__mark[data-included="true"] { background: var(--ground-ink, var(--text-primary)); color: var(--words-on-ink, var(--surface-base)); }
  .comparison-table [data-highlighted="true"] .comparison-table__mark[data-included="true"] { background: var(--plan-accent, var(--accent-purple)); }
  .comparison-table__mark[data-included="false"] { border: 1px solid var(--border-primary); color: var(--text-muted); }
  @media (forced-colors: active) {
    .comparison-table, .comparison-table thead th, .comparison-table th[scope="row"], .comparison-table [data-highlighted="true"] { background: Canvas; }
    .comparison-table, .comparison-table th, .comparison-table td { border-color: CanvasText; }
    .comparison-table__mark[data-included="true"], .comparison-table [data-highlighted="true"] .comparison-table__mark[data-included="true"] { background: CanvasText; color: Canvas; forced-color-adjust: none; }
    .comparison-table__mark[data-included="false"] { border-color: CanvasText; color: CanvasText; }
  }
  @media (max-width: 40rem) {
    .comparison-table table { min-width: 0; font-size: 0.88rem; }
    .comparison-table th, .comparison-table td { padding: 0.75rem 0.55rem; }
    .comparison-table th[scope="row"], .comparison-table thead th:first-child { width: 40%; }
    .comparison-table caption { padding: 1rem 0.55rem 0.4rem; }
    .comparison-table__name { font-size: 1rem; }
    .comparison-table__value { font-size: 0.82rem; }
  }
  .comparison-table[data-density="compact"] table { font-size: 0.86rem; }
  .comparison-table[data-density="compact"] th, .comparison-table[data-density="compact"] td { padding: 0.5rem 0.9rem; }
  .comparison-table[data-density="compact"] .comparison-table__name { font-size: 1rem; }
  .comparison-table[data-density="compact"] .comparison-table__detail { font-size: 0.8rem; }
  .comparison-table__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

export function ComparisonTable({ caption, featureHeading, columns, rows, density = 'comfortable' }: ComparisonTableProps) {
  return (
    <div className="comparison-table" data-density={density}>
      <style>{STYLE}</style>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col"><span className="comparison-table__feature-heading">{featureHeading}</span></th>
            {columns.map((column) => (
              <th scope="col" key={column.id} data-highlighted={column.highlighted ? 'true' : 'false'}>
                <span className="comparison-table__name">{column.name}</span>
                {column.detail ? <span className="comparison-table__detail">{column.detail}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              {columns.map((column, index) => (
                <td key={column.id} data-highlighted={column.highlighted ? 'true' : 'false'}>
                  <Cell cell={row.cells[index] ?? { included: false }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Project ONE visual-database record + a set of metric field descriptors into the
// shared ui MetricRow (a hairline strip of mono metric cells). The metric strip
// of any surface (an account's buying-power/positions/today figures, a market's
// scan stats, …) is just: pick the descriptors that are metrics, read each one's
// value off the record with the SAME generic `extractFieldValue` the table/rows
// use, and let the caller turn each raw value into a display string + tone.
//
// This is the visual-database form of a metric strip: WHICH metrics + their order
// are DATA (the descriptor set); the only code is the projection. A surface adds
// a metric by adding a descriptor — zero code here. Formatting (currency vs
// integer vs percent, gain/loss tone) is the CALLER's `formatValue`, because the
// human rendering of a number is presentation the data owner decides, not record-
// board's business to enumerate.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reads values ONLY through `extractFieldValue` (descriptor `paths`) — never
//    by hardcoded key. A renamed/added metric is a descriptor change, not code.
// 2. Carries ZERO domain vocabulary: no metric ids, no currency/percent logic,
//    no gain/loss thresholds. The caller's `formatValue` owns all of that.
// 3. Pure projection + the shared MetricRow. No new layout, no className.
// =============================================================================

import React from 'react';
import { MetricRow, type MetricCell } from '../../ui';
import { extractFieldValue, type VisualDatabaseFieldDescriptor, type VisualDatabaseRecord } from '../read-data/visual-database';

/** The display result for one metric: the formatted string + optional tone. The
 *  caller returns this from the raw value it read for a descriptor. */
export interface RecordMetricFormat {
  readonly value: string;
  readonly tone?: MetricCell['tone'];
}

export interface RecordMetricRowProps {
  /** The record whose values feed the strip (e.g. the account snapshot record). */
  record: VisualDatabaseRecord;
  /** Metric field descriptors, in display order — the strip's columns are DATA. */
  descriptors: readonly VisualDatabaseFieldDescriptor[];
  /** Turn one descriptor's raw value into a display string + tone. Presentation
   *  is the caller's (currency/percent/integer, gain/loss tone) — visual-database
   *  never enumerates it. */
  formatValue: (value: unknown, descriptor: VisualDatabaseFieldDescriptor) => RecordMetricFormat;
  /** 'between' (default) spaces cells evenly; 'start' hugs the left. */
  align?: RecordMetricRowProps_Align;
  /** DATA-selected anatomy: a hairline strip or compact two-column grid. */
  layout?: 'row' | 'grid';
}

type RecordMetricRowProps_Align = 'between' | 'start';

/**
 * Render a record's metric descriptors as a ui MetricRow.
 *
 * @example
 * ```tsx
 * <RecordMetricRow
 *   record={accountRecord}
 *   descriptors={metricDescriptors}
 *   formatValue={(value, d) => ({ value: formatForDescriptor(value, d), tone: toneFor(value, d) })}
 * />
 * ```
 */
export function RecordMetricRow({ record, descriptors, formatValue, align = 'between', layout = 'row' }: RecordMetricRowProps) {
  const cells: MetricCell[] = descriptors.map((descriptor) => {
    const formatted = formatValue(extractFieldValue(record, descriptor), descriptor);
    return { label: descriptor.label, value: formatted.value, tone: formatted.tone };
  });
  return <MetricRow cells={cells} align={align} layout={layout} />;
}

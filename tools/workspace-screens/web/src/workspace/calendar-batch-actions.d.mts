export interface CalendarBatchRemovalFailure<Row> {
  row: Row;
  error: unknown;
}

export interface CalendarBatchRemovalResult<Row> {
  removed: Row[];
  failed: CalendarBatchRemovalFailure<Row>[];
}

/** Run every row once in input order and return successes and failures separately. */
export function runCalendarBatchRemoval<Row>(
  rows: readonly Row[],
  remove: (row: Row) => Promise<unknown>,
): Promise<CalendarBatchRemovalResult<Row>>;

// tools/ask-questions-sort-answers-follow-up/read-data/record-rows.ts
//
// The seam between the person's tables and the package's readers. A table of this tool holds rows read as { id, type, value };
// every reader here (foldAnswerFacts, readDecideConfig, buildResultsModel, the sequence decoders) reads
// payload-wrapped rows, { address?, payload }. This is the one place the two shapes meet.

/** One kept row: its id, its kind (which table holds it) and its value. */
export interface KeptRow {
  id: string;
  type: string;
  value: unknown;
}

/** A row the package asks to be kept. */
export type RecordWrite = KeptRow;

/** Kept rows as the payload-wrapped rows the readers take. A row with no value is left out. */
export function payloadRows(records: readonly KeptRow[]): Array<{ address: string; payload: unknown }> {
  return records.filter((record) => record.value !== null && record.value !== undefined).map((record) => ({ address: record.id, payload: record.value }));
}

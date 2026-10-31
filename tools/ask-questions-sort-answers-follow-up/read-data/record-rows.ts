// tools/ask-questions-sort-answers-follow-up/read-data/record-rows.ts
//
// The seam between the records door and the package's readers. The door lists records as { id, type, value };
// every reader here (foldAnswerFacts, readDecideConfig, buildResultsModel, the sequence decoders) reads
// payload-wrapped rows, { address?, payload }. This is the one place the two shapes meet.

/** One record as the person's records door gives it and takes it. */
export interface DoorRecord {
  id: string;
  type: string;
  value: unknown;
}

/** A record the package asks the door to write. */
export type RecordWrite = DoorRecord;

/** Door records as the payload-wrapped rows the readers take. A removed record (value null) is left out. */
export function payloadRows(records: readonly DoorRecord[]): Array<{ address: string; payload: unknown }> {
  return records.filter((record) => record.value !== null && record.value !== undefined).map((record) => ({ address: record.id, payload: record.value }));
}

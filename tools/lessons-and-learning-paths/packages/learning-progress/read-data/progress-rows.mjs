// tools/lessons-and-learning-paths/packages/learning-progress/read-data/progress-rows.mjs
//
// PURPOSE
//   The rows the learner progress screen draws, as { address, payload } in the shape read-learning-progress.ts takes,
//   from the records of each list read-data/progress-row-types.json declares. The retired screen was handed every
//   published record; here each kind is its own list of the person's own rows. Pure: the records arrive as a parameter.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A progress state or an evaluation receipt counts only from its own list: its row is given the owner address the
//      reader requires (`package::learning-progress::`), and no other row is, so a row of a track, step, evidence or
//      presentation list never counts as one, whatever its payload says it is.
//   2. A row without a `kind` takes the kind its list declares; a row without a value is left out.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export const OWNER_ADDRESS = 'package::learning-progress::';

/** The rows of every declared list. `recordsByType` maps a list's type to the records read from it. */
export function progressRowsOf(rowTypes, recordsByType) {
  return rowTypes.lists.flatMap((list) => (recordsByType[list.type] ?? []).flatMap((record) => (
    record.value && typeof record.value === 'object'
      ? [{ address: list.owner ? `${OWNER_ADDRESS}${record.id}` : record.id, payload: { kind: list.kind, ...record.value } }]
      : []
  )));
}

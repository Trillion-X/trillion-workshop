// tools/listen-for-a-while/read-data/keep-hearing-session.mjs
//
// Purpose
//   Keeps one session record of tool:hear-sources. The old tool wrote each record into the person's session file automatically
//   (computer/hearing-sources.mjs:50-57 @b7dc53d08a); the hearing tool now only answers it, so this step names it as a keep
//   row for the export runner (records-door/do-work/run-an-export.mjs, --keep-into hearing_sessions), which writes it through
//   the connection mounted on the row when the run's input names a `database`. The function writes nothing itself.
//
// Non-negotiable invariants
//   1. The keep row is the record the hearing tool answered, unchanged: its id is the record's own content id.
//   2. A record that is not there is refused in words; nothing is kept on a guess.
//   3. The `expected` value is null: a new record is written only where none is kept yet (the writer refuses otherwise).

/** The keep list for one session record: `{ keep: [{ id, type, value, expected }] }`. */
export function keepHearingSession(input = {}) {
  const session = input.session;
  if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id) {
    throw Object.assign(new Error('Give `session`: the session record tool:hear-sources answered, with its id.'), { status: 400 });
  }
  return { keep: [{ id: session.id, type: 'hearing-session', value: session, expected: null }] };
}

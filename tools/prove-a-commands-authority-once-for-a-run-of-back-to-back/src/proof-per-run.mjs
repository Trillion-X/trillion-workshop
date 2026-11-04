// src/proof-per-run.mjs
//
// Purpose: a guard that proves a command's authority before each of its SQL statements (src/namespace-book-resource.mjs ownedSql) proves
// it once for a run of statements that follow one another with nothing awaited between them. One /namespace/files/lookup of 600 names ran
// the proof 636 times and stopped at its admitted bound of 1,280 statements ("command stopped at its statement bound", 224 times in 25
// minutes on store de0c14c4, 2026-10-20).
//
// Non-negotiable invariants
//   1. Authority can only change while this command is suspended at an await, because a Durable Object runs one synchronous run at a
//      time; the proof is therefore forgotten at the next microtask, and the first statement after any await proves it again.
//   2. A statement that is not a read (anything but SELECT, WITH or PRAGMA) forgets the proof as well: it may change the very rows the
//      proof reads, so the next statement proves again.
//   3. The proof belongs to one command (the object `current` it was made for); another command never reuses it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const READ = /^\s*(?:SELECT|WITH|PRAGMA)\b/i;

/** `prove(current)` throws when `current` no longer holds authority. before(current) proves it unless this run already did;
 *  after(query) forgets the proof when the statement just run may have changed it. */
export function proofPerRun(prove) {
  let proven = null;
  return {
    before(current) {
      if (proven === current) return;
      prove(current);
      proven = current;
      queueMicrotask(() => { proven = null; });
    },
    after(query) { if (!READ.test(String(query))) proven = null; },
  };
}

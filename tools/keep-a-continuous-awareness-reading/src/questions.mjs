// src/questions.mjs
//
// Purpose: the person's questions the reading could not answer from their inputs, kept in the reading's own table
// `awareness_questions` with plain SQL. Ported from awarenessQuestions (src/awareness.mjs:248-282 of the old repository,
// commit b6ae0ebf8), which kept them as rows of a list through the engine's lists() API.
//
// Non-Negotiable Invariants:
//   1. A question's row id is its words (lower-cased, non-alphanumerics to '-'), so the same question is never written twice.
//   2. A reading adds at most `per_reading`, and never more than `open_cap` questions wait at once.
//   3. The person's answer outweighs what the inputs suggest: asked() hands every reading the answered questions first.
//
// Table (created by this owner on first use):
//   awareness_questions (id TEXT PRIMARY KEY, question TEXT NOT NULL, about TEXT, guess TEXT, why TEXT,
//                        answer TEXT, kept_at TEXT NOT NULL)
// `query(sql, params)` runs the store's SQL and resolves to its rows (sync or promise).

const CREATE = `CREATE TABLE IF NOT EXISTS awareness_questions (
  id TEXT PRIMARY KEY, question TEXT NOT NULL, about TEXT, guess TEXT, why TEXT, answer TEXT, kept_at TEXT NOT NULL
)`;
// A question waits until the person answers it with words (a blank answer still waits, as the old list rule had it).
const UNANSWERED = "(answer IS NULL OR TRIM(answer) = '')";

const rowId = words => words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'question';

export function awarenessQuestions({ query, settings, now = () => new Date().toISOString() }) {
  const q = settings.questions;
  let ready = null;
  // The table is made the first time anything reads or writes it, once per process.
  const setup = () => (ready ??= query(CREATE, []));
  const label = id => [...settings.traits, ...(q?.about ?? [])].find(item => item.id === id)?.label ?? id;

  return {
    /** Every question with its answer: the answered ones first, at most answered_read of them, for the next reading. */
    async asked() {
      await setup();
      const rows = await query(`SELECT question, answer FROM awareness_questions ORDER BY CASE WHEN ${UNANSWERED} THEN 1 ELSE 0 END, kept_at LIMIT $1`, [q.answered_read]);
      return rows.map(row => ({ question: row.question ?? '', answer: row.answer ?? '' }));
    },
    /** The questions not answered yet: how many, and their words. */
    async waiting() {
      await setup();
      const open = await query(`SELECT question FROM awareness_questions WHERE ${UNANSWERED} ORDER BY kept_at`, []);
      return { label: q.list.label, count: open.length, questions: open.map(row => row.question).filter(Boolean) };
    },
    /** Writes the new questions the reading asked: never one already there, never past open_cap waiting. Returns how many were kept. */
    async keep(found = []) {
      if (!found.length) return { kept: 0 };
      await setup();
      const have = new Set((await query('SELECT id FROM awareness_questions', [])).map(row => row.id));
      const open = (await query(`SELECT COUNT(*) AS n FROM awareness_questions WHERE ${UNANSWERED}`, []))[0]?.n ?? 0;
      const room = Math.max(0, q.open_cap - Number(open));
      const fresh = found
        .filter((item, index) => !have.has(rowId(item.question)) && found.findIndex(other => rowId(other.question) === rowId(item.question)) === index)
        .slice(0, room);
      const kept_at = now();
      for (const item of fresh) {
        await query('INSERT INTO awareness_questions (id, question, about, guess, why, kept_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
          [rowId(item.question), item.question, label(item.about), item.guess || null, item.why || null, kept_at]);
      }
      return { kept: fresh.length };
    },
  };
}

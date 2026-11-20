// tools/introduce-two-people/do-work/record-introduction-state.mjs
//
// The state tool of the old request_introduction (old descriptor: tools.mjs.held at a476dd597, lines 297-308). It records
// one introduction's state in the person's own database, and records nothing else. It sends nothing to any person and sets
// no route, wake or notice: live sending waits for the owner's word.
//
// Non-negotiable invariants:
//   1. A move must be one the introduction lifecycle allows (src/introduction-states.json; 409 otherwise).
//   2. The state the introduction is in now must be the `from` the caller names; a first state is `proposed`.
//   3. A move to `sent` or `one_yes` carries the consent of the introduction as it was shown; a changed introduction is
//      refused (check-consent-to-an-introduction/src/consent-fingerprint.mjs, 409).
import { moveIntroduction, introductionView, INTRODUCTION_STATES } from '../src/introduction-states.mjs';
import { refuseChangedConsent } from '../../check-consent-to-an-introduction/src/consent-fingerprint.mjs';

const fail = (message, status) => Object.assign(new Error(message), { status });
const CONSENTED = new Set(['sent', 'one_yes']);
// The same DDL runs in SQLite and Postgres, as the label tool's does.
const TABLES = [
  'CREATE TABLE IF NOT EXISTS introduction_states(id TEXT PRIMARY KEY,status TEXT NOT NULL,at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS introduction_state_history(id TEXT NOT NULL,from_status TEXT NOT NULL,to_status TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(id,at,to_status))',
];

// `db.exec(sql, ...values)` answers (a promise of) the rows of a select, an empty list for a write.
export async function recordIntroductionState({ db, input, now = () => new Date().toISOString() }) {
  const { id, from, to, consent, shown } = input ?? {};
  if (typeof id !== 'string' || !id) throw fail('Give the introduction id.', 400);
  if (!INTRODUCTION_STATES.includes(from) || !INTRODUCTION_STATES.includes(to)) throw fail(`A state is one of: ${INTRODUCTION_STATES.join(', ')}`, 400);
  if (CONSENTED.has(to)) {
    if (typeof consent !== 'string' || !consent || !shown || typeof shown !== 'object') throw fail('Give the consent and the introduction as it was shown.', 400);
    refuseChangedConsent(consent, shown, 'The introduction changed since it was shown. Look at it again, then accept it as it is now.');
  }
  for (const sql of TABLES) await db.exec(sql);
  const stored = await db.exec('SELECT status FROM introduction_states WHERE id=?', id);
  const was = stored.length ? stored[0].status : 'proposed';
  if (from !== was) throw fail(`The introduction is ${was}, not ${from}.`, 409);
  moveIntroduction(from, to);
  const at = now();
  if (stored.length) await db.exec('UPDATE introduction_states SET status=?,at=? WHERE id=?', to, at, id);
  else await db.exec('INSERT INTO introduction_states(id,status,at) VALUES(?,?,?)', id, to, at);
  await db.exec('INSERT INTO introduction_state_history(id,from_status,to_status,at) VALUES(?,?,?,?)', id, from, to, at);
  return { id, ...introductionView(to) };
}

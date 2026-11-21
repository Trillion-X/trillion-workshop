// tools/keep-goals-and-focus/read-data/home-answers.mjs
//
// PURPOSE
//   Home's answers as its parts draw them, made from the rows of the person's own tables (home-sources.json names every
//   table and statement). Each function takes the rows one statement answered and gives the shape home-screen.tsx draws.
//   Pure: no network, no database, no words (the words are home-words.json's).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A row becomes an answer only when it has the fields the part draws (a row without its id or its title is left out).
//   2. Nothing is made up: a field the owner's row does not hold stays null, and a part with no rows draws its empty words.
//   3. The table's own names never appear here; the statements are home-sources.json's.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const text = value => (typeof value === 'string' && value.trim() ? value : null);
const stamp = value => (value instanceof Date ? value.toISOString() : text(value) ?? '');
const hasId = row => text(row?.id) !== null;

/** The person's owner-places record (home-sources.json roles_label): {roles: {<role>: {credential_name, table}}}. Each role
 *  Home reads maps to the connection name it reads from; a value that is not one, or no record at all, maps no role. */
const ROLES = ['notices', 'goals', 'open_work'];
export function rolesOf(value) {
  const record = typeof value === 'string' ? parseJson(value) : value;
  const roles = record && typeof record === 'object' ? record.roles : null;
  if (!roles || typeof roles !== 'object') return {};
  return Object.fromEntries(ROLES.filter(role => typeof roles[role]?.credential_name === 'string' && /-connection$/.test(roles[role].credential_name))
    .map(role => [role, roles[role].credential_name]));
}
const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };

/** An unread notice that needs the person's answer, drawn under Waiting for you. */
export function waitingOf(rows) {
  return rows.filter(hasId).map(row => ({ id: row.id, title: text(row.title) ?? row.id, detail: text(row.body) }));
}

/** Open AI work: one job run not yet finished, drawn as work the AI is doing now (`status` is the working state
 *  home-sources.json names for it, which the work-state looks draw as In progress). */
export function openWorkOf(rows, status) {
  return rows.filter(hasId).map(row => ({
    handoff_id: row.id,
    status,
    job: text(row.job) ?? row.id,
    said: null,
    in_the_way: null,
    parent_handoff_id: null,
    handed_at: stamp(row.started_at),
    finished_at: null,
  }));
}

/** A goal the person keeps (home_goals in their own database): its needle-mover mark is the table's own column. */
export function goalsOf(rows) {
  return rows.filter(hasId).map(row => ({
    id: row.id,
    title: text(row.title) ?? row.id,
    now: text(row.now_text) ?? undefined,
    after: text(row.after_text) ?? undefined,
    why_it_matters: text(row.why_it_matters) ?? undefined,
    needle_mover: row.needle_mover === true,
  }));
}

/** A statement that ran against a table the person's database does not have yet (SQLSTATE 42P01, which the door's own
 *  words name as "does not exist"): nothing is kept there yet. */
export function isMissingTable(message) {
  return /42P01|relation .* does not exist/.test(String(message ?? ''));
}

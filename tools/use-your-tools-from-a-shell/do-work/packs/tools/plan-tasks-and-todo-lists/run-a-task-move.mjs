// tools/plan-tasks-and-todo-lists/run-a-task-move.mjs
//
// The one caller of the task rows (task-moves.mjs) for anything that reaches a person's records through addressed
// operations: the shell command, the helper that takes work on a computer, a page. The rows read no store, so a
// call here (1) reads the records the move needs, (2) hands them in as `input.records` with tools:run, and (3) keeps
// every write the row answers (`keep`) with one records:write, each row conditioned on the value it was read at. A
// write refused because a record changed meanwhile is answered `{ kept: false, reason: 'changed' }`: the caller reads
// again and decides again. Nothing here decides who may do what; that is the rows' DATA.
//
//   runTaskMove(resource, { tool, input, key, read }) -> { result, kept, reason? }
//
// `resource(address, method, input, key)` is the caller's addressed transport. `read` says what to hand in:
//   { tasks: { where?, statuses? } }  every task in those stored status words (else every task), a page at a time
//   { ids: [{ type, id }] }           these records by id (the task named, its assignees, its continuation owner, a finish's consumer);
//                                     records:read takes the id, and `type` labels the record for a rule that names one
//   { types: [type] }                 every record of these types (whoever may take work, as the caller's settings name them)
// The bounds are the rows' own: at most `most` records are handed in (task-moves.json most_tasks_read).
import { readFileSync } from 'node:fs';

const RULES = JSON.parse(readFileSync(new URL('./task-moves.json', import.meta.url), 'utf8'));
const RECORDS = '@own-records';
const TOOLS = '@tools';

// Every record of `type` (whose `where` fields equal), page after page, at most `most` of them.
async function every(resource, type, where, most) {
  const found = [];
  let after = null;
  do {
    const page = await resource(RECORDS, 'records:list', { type, ...(where ? { where } : {}), limit: Math.min(100, most - found.length), ...(after ? { after } : {}) });
    if (!Array.isArray(page?.records)) throw new Error(`The account did not return its ${type} records.`);
    for (const row of page.records) found.push({ id: row.id, type, value: row.value ?? null });
    after = page.next ?? null;
  } while (after && found.length < most);
  return found;
}

/** The records one move needs, read through the caller's transport. */
export async function readFor(resource, read = {}, { rules = RULES } = {}) {
  const most = rules.most_tasks_read;
  const held = new Map();
  const add = rows => { for (const row of rows) if (!held.has(row.id)) held.set(row.id, row); };
  if (read.tasks) {
    const statuses = read.tasks.statuses ?? [null];
    for (const status of statuses) add(await every(resource, rules.task_kind, status === null ? read.tasks.where : { ...read.tasks.where, status }, most));
  }
  for (const type of read.types ?? []) add(await every(resource, type, null, rules.most_people_read));
  // records:read answers the record's own value (the engine's read is the value, native-record-consumers.mjs), or null.
  for (const { type, id } of read.ids ?? []) {
    if (held.has(id)) continue;
    const value = await resource(RECORDS, 'records:read', { id });
    if (value !== null && value !== undefined) held.set(id, { id, type, value });
  }
  return [...held.values()];
}

/** The declared states the rules name (every `states` key). */
export const declaredStates = (rules = RULES) => rules.states.map(state => state.key);
/** The state a stored status word means: itself, or what `read_as` maps it to. */
export const stateOfWord = (word, rules = RULES) => rules.read_as?.[word] ?? word;
/** Every stored word that means one of these states: each state itself and each `read_as` word that maps to it. */
export function wordsOfStates(states, rules = RULES) {
  const words = new Set(states);
  for (const [word, state] of Object.entries(rules.read_as ?? {})) if (states.includes(state)) words.add(word);
  return [...words];
}
/** The states an action moves a task out of (its transitions' `from`), so a listing reads every task it may move. */
export const statesFrom = (action, rules = RULES) => [...new Set(rules.transitions.filter(edge => edge.action === action).map(edge => edge.from))];

/** One task row run over the records it needs, its writes kept where they were read. */
export async function runTaskMove(resource, { tool, input = {}, key, read = {}, rules = RULES, reads = 5, waitSeconds = 10 }) {
  const records = await readFor(resource, read, { rules });
  let answer = await resource(TOOLS, 'tools:run', { tool, input: { ...input, records } }, key);
  for (let attempt = 0; answer?.task_id && !['completed', 'failed'].includes(answer.state) && attempt < reads; attempt += 1) {
    answer = await resource(TOOLS, 'tools:read', { task_id: answer.task_id, wait_seconds: waitSeconds });
  }
  if (answer?.state === 'failed' || (answer?.exit_code && answer.exit_code !== 0)) throw new Error(answer.error ?? `${tool} failed.`);
  if (answer?.task_id && answer.state !== 'completed') throw new Error(`${tool} is still running; its request key ${key} reads it again.`);
  const output = answer?.output ?? answer;
  const result = output?.result ?? output;
  const keep = Array.isArray(result?.keep) ? result.keep : [];
  if (!keep.length) return { result, kept: true };
  try {
    await resource(RECORDS, 'records:write', { records: keep }, key && `${key}:keep`);
  } catch (error) {
    if (error?.code === 'original_command_conflict' || String(error?.message ?? '').includes('original_command_conflict')) return { result, kept: false, reason: 'changed' };
    throw error;
  }
  return { result, kept: true };
}

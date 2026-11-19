// tools/use-your-tools-from-a-shell/test-fixtures/task-records.mjs
//
// A stand-in engine for the task commands: the account's records held in memory (records:list, records:read and
// records:write of @own-records, with the engine's rule that a write whose `expected` value no longer holds is refused
// whole), and the Workshop task rows run for real over those records (tools:run at @tools). Every row is the owner's
// own function (tools/plan-tasks-and-todo-lists/task-moves.mjs), so a test proves the rows and the command together.
// The ops answer the fake door (command-cli.test.mjs fakeDoor): handler(input, args) -> answer, or { refused } for a refusal.
import { changeATask, finishATask, giveATask, seeTasks, seeWhoCanTakeWork, takeATask } from '../../plan-tasks-and-todo-lists/task-moves.mjs';
import settings from '../do-work/command.json' with { type: 'json' };

export const RESULT_LIMIT = 60000;
const ROWS = {
  [settings.tasks.tools.see]: seeTasks,
  [settings.tasks.tools.give]: giveATask,
  [settings.tasks.tools.take]: takeATask,
  [settings.tasks.tools.who]: seeWhoCanTakeWork,
  [settings.tasks.tools.change]: changeATask,
  [settings.tasks.tools.finish]: finishATask,
};

/** The records of an account, in memory: `put(id, type, value)`, `get(id)` (the value or null), and `ops` for the door. */
export function recordStore(records = []) {
  const held = new Map();
  const put = (id, type, value) => held.set(id, { id, type, value });
  for (const [id, type, value] of records) put(id, type, value);
  const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ops = {
    '@own-records records:read': ({ id }) => held.get(id)?.value ?? null,
    '@own-records records:list': ({ type, where = {}, limit = 100, after = null }) => {
      const found = [...held.values()].filter(row => row.type === type && Object.entries(where).every(([field, want]) => row.value?.[field] === want))
        .filter(row => after === null || row.id > after).sort((a, b) => (a.id < b.id ? -1 : 1));
      const page = found.slice(0, limit);
      return { records: page.map(row => ({ id: row.id, type: row.type, value: row.value })), next: found.length > limit ? page.at(-1).id : null };
    },
    '@own-records records:write': ({ records }) => {
      for (const { id, expected } of records) {
        const current = held.get(id)?.value ?? null;
        const want = expected?.value ?? null;
        if (!sameValue(current, want)) return { refused: `original_command_conflict: ${id} changed since it was read` };
      }
      for (const { id, type, value } of records) {
        if (value === null) held.delete(id);
        else put(id, type, value);
      }
      return { written: records.length };
    },
  };
  return { put, get: id => held.get(id)?.value ?? null, has: id => held.has(id), ops, all: () => [...held.values()] };
}

/** `tools:run`: the row a tool id names, run over the input's records; a refusal is answered as the door answers one. A
 *  row's answer is the tool run's own `result`, as the door keeps it (its `status` is the row's, not an HTTP status). */
export function taskRowRun({ now = () => new Date() } = {}) {
  return async ({ tool, input = {} }) => {
    const row = ROWS[tool];
    if (!row) return { refused: `No tool ${tool} is a task row here.` };
    try {
      return { exit_code: 0, replayed: false, result: await row({ input, task: {} }, { now }) };
    } catch (error) {
      return { refused: error.message };
    }
  };
}

/** Every op of the fake door a task command needs: the records of `store`, the task rows, and the finishing tool's limit. */
export function taskDoorOps(store, { now, overrides = {} } = {}) {
  return {
    ...store.ops,
    '@tools tools:run': (input, args) => (overrides[input.tool] ?? taskRowRun({ now }))(input, args),
    '@tools tools:list': ({ tool }) => ({ id: tool, input_schema: { type: 'object', properties: { result: { type: 'string', maxLength: RESULT_LIMIT } } } }),
  };
}

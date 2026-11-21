// tools/workflows/test/door-fake.mjs
// A fake of the engine's door for the workflow-run programs: each call is answered from the options, and every call is recorded.
export const DOOR = { url: 'https://engine.test/mcp', capability: 'capability-for-test', resource: '@own-records' };

function reply(structuredContent, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: !ok, structuredContent } }) };
}

/** options: recipe (the recipe exists), waiterOn, wakeListRefusal (the detail a refused wake:list gives), rows (the SQL rows), cancelled. */
export function fakeDoor({ recipe = true, waiterOn = true, wakeListRefusal = null, rows = [], cancelled = true } = {}) {
  const calls = [];
  // The rows an UPDATE returns are the withdrawn ids; a read of a run's envelope returns the rows the options give.
  const sqlAnswer = sql => (sql.includes("set status = 'Withdrawn'") ? [] : null);
  const fetchImpl = async (url, { body, headers }) => {
    const args = JSON.parse(body).params.arguments;
    const { method, input } = args;
    calls.push({ url, auth: headers.authorization, method, input, request_key: args.request_key });
    if (method === 'wake:list') {
      if (wakeListRefusal) return reply({ code: 'resource_envelope_exceeds_limit', detail: wakeListRefusal }, { ok: false, status: 422 });
      return reply({ wakes: [{ id: 'a-workflow-was-chosen', tool: 'tool:run-a-workflow', switched_on: waiterOn }] });
    }
    if (method === 'wake:arrive') return reply({ accepted: true });
    if (method === 'tools:cancel') return reply({ cancelled });
    if (method === 'tools:run' && input.tool === 'tool:run-sql-in-my-database') {
      const { sql, params } = input.input;
      if (sql.startsWith('select recipe from workflow_recipes')) return reply({ exit_code: 0, result: { rows: recipe ? [{ recipe: params[0] }] : [] } });
      return reply({ exit_code: 0, result: { rows: sqlAnswer(sql) ?? rows } });
    }
    throw new Error(`the fake door has no answer for ${method} ${input?.tool ?? ''}`);
  };
  return { door: DOOR, fetchImpl, calls, sent: () => calls.filter(call => call.method === 'wake:arrive') };
}

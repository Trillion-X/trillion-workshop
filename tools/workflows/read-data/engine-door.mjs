// tools/workflows/read-data/engine-door.mjs
//
// The door the workflow-run programs reach the person's engine through: the run's own capability on fd 3 ({url, resource,
// capability}), the same reader the noticer's tell-the-engine.mjs uses. Each call is one operation of the engine's one MCP
// tool, sent with the capability as a bearer token. A wake operation goes to the person's own records (the row names it as a
// right {at, id, operations}); a tool run goes to the Workshop's address, which the engine tells only a row whose records name
// the tool in `runs` (as tools_resource on fd 3). Nothing here holds a key, a connection string or a command name.
import { readFileSync } from 'node:fs';

export const DESCRIPTOR_FD = 3;
// The engine takes a request key of at most this many bytes; every key these programs make is far shorter.
const REQUEST_KEY_BYTES = 255;

/** The run's door, from the descriptor the engine wrote on fd 3. */
export function readDoor(descriptor = DESCRIPTOR_FD) {
  const door = JSON.parse(readFileSync(descriptor, 'utf8'));
  if (typeof door.url !== 'string' || typeof door.capability !== 'string') throw new Error('This run was not handed a door on fd 3.');
  return door;
}

/** One operation `method` with `input`, under `requestKey`. Returns the call's result; throws, saying why, when the engine refuses. */
export async function operate(door, method, input, requestKey, fetchImpl = fetch, address = door.resource ?? '@own-records') {
  if (Buffer.byteLength(requestKey) > REQUEST_KEY_BYTES) throw new Error(`the request key for ${method} is over ${REQUEST_KEY_BYTES} bytes`);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
    arguments: { address, method, request_key: requestKey, input } } });
  const response = await fetchImpl(door.url, { method: 'POST', body, headers: { authorization: `Bearer ${door.capability}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' } });
  const raw = await response.text();
  const json = raw.trim().startsWith('{') ? raw : raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
  const reply = JSON.parse(json || '{}');
  if (reply.error) throw new Error(`the engine refused ${method}: ${reply.error.message ?? reply.error.code ?? 'no reason given'}`);
  const result = reply.result ?? {};
  if (result.isError || !response.ok) {
    const why = result.structuredContent?.detail ?? result.structuredContent?.code ?? `HTTP ${response.status}`;
    throw new Error(`the engine refused ${method}: ${why}`);
  }
  return result.structuredContent ?? {};
}

/** One Workshop tool run through the door (tools:run), its answer as the tool gave it. */
export function runTool(door, tool, input, requestKey, fetchImpl) {
  if (typeof door.tools_resource !== 'string') throw new Error(`This run was not told the Workshop's address, so it cannot run ${tool}: its row names no runs.`);
  return operate(door, 'tools:run', { tool, input }, requestKey, fetchImpl, door.tools_resource);
}

/** The rows of one statement in the named database, through the database's own SQL tool; refused statements throw. */
export async function sqlRows(door, database, sql, params, requestKey, fetchImpl) {
  const answer = await runTool(door, 'tool:run-sql-in-my-database', { database, sql, params }, requestKey, fetchImpl);
  if (answer.exit_code) throw new Error(`the database refused the statement: ${answer.error ?? answer.result?.error ?? 'no reason given'}`);
  return answer.result?.rows ?? [];
}

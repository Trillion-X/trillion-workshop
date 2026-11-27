// tools/run-on-a-persons-computer/run-a-script.mjs
//
// PURPOSE
//   The your-Mac implementation of tool:run-a-script: runs a model's script over this person's Workshop tools.
//   The script runs in the script sandbox (script-sandbox.mjs), started through confined-run's read-only tier from the pinned
//   Node. Its call(toolId, input) is answered here, with one door call made as the person (toolCaller, the road keep-drive-files
//   already uses for the tools no plain route offers).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The account's key stays in this host process. The sandboxed script receives call() and nothing that holds the key.
//   2. Every call a script makes is one tools:run through the person's door, under a request key unique to this run and call.
//   3. The Node program and its pin come from this tool's own program row (what-this-tool-does-and-how-to-run-it.json, invoke.programs.node); this file names none.
//   4. The answer is the script's value, or its refusal in words; a value over the sandbox's result_chars is refused there.
//
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolCaller } from './keep-drive-files.mjs';
import { makeHostCalls, runScript, sandboxSettings } from './script-sandbox.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_ID = 'tool:run-a-script';
const DOOR_TOOL = 'do_one_thing_in_my_account';

/** The Node the script runs in: this process's own Node, which the tool's program row pins by BLAKE3 (checked before it starts). */
export function programNode() {
  const rows = JSON.parse(readFileSync(join(HERE, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8'));
  const tool = rows.records.map(record => record.payload).find(payload => payload.id === TOOL_ID);
  return { path: process.execPath, tier: 'read-only', pin: tool.invoke.programs.node.fetch['macos-aarch64'].executable_blake3 };
}

/**
 * Runs `input.code` (a function body) with `input.input`, answering its call() through the person's door. Returns { result } or
 * { error } in words. `caller` answers one door call (the default is the person's door at `origin` with `key`).
 */
export async function runAScript(input, { origin, key } = {}, { caller = toolCaller(origin, key) } = {}) {
  if (typeof input?.code !== 'string' || input.code === '') {
    throw Object.assign(new Error('`code` is missing or empty: give a function body that returns its answer.'), { status: 400 });
  }
  const runId = randomUUID();
  let calls = 0;
  const callTool = (toolId, args) => caller(DOOR_TOOL, { method: 'tools:run', request_key: `${runId}:${++calls}`, input: { tool: toolId, input: args } });
  const answer = await runScript({ code: input.code, input: input.input ?? null, host: makeHostCalls({ settings: sandboxSettings(), callTool }), node: programNode() });
  return answer.error ? { error: answer.error } : { result: answer.value };
}

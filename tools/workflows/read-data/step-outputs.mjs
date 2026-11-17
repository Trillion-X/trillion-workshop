// tools/workflows/read-data/step-outputs.mjs
//
// A recipe step can say where its output goes: `outputs: [{ port, kind }]`. `port` names a field of the step's answer;
// `kind` is `row:<list>` (the field is kept as a row of that list), `file` (kept as a file) or `none` (returned, kept
// nowhere). Which store serves a kind is the person's own DATA, a cart line `{ kind, store, credential_name }` read
// through the records door (arrivals/step-outputs.json names its row types and the tool that writes for each kind).
// This module holds no store: the runner finds the person's cart line and hands the write to that kind's tool by id.
// A kind with no cart line keeps nothing, returns the value, and says so in the step result.
//
//   stepOutputsProblems(outputs, name) -> string[]      what is wrong with a step's `outputs` (empty when it is fine)
//   parseStepOutputs(outputs, where) -> outputs         the same, thrown as one message
//   keepStepOutputs({ outputs, answer, run, step }, { door, tools }) -> [{ port, kind, kept, said, value }]

import { readFileSync } from 'node:fs';

const SOURCE = JSON.parse(readFileSync(new URL('../arrivals/step-outputs.json', import.meta.url), 'utf8'));
const KIND = /^(?:file|none|row:[a-z0-9][a-z0-9-]*)$/;
const PORT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function stepOutputsProblems(outputs, name = 'step') {
  if (!Array.isArray(outputs) || outputs.length === 0) return [`${name}.outputs must be a non-empty list of { port, kind }.`];
  const problems = [];
  const seen = new Set();
  outputs.forEach((output, at) => {
    const where = `${name}.outputs[${at}]`;
    if (output === null || typeof output !== 'object' || Array.isArray(output)) { problems.push(`${where} must be { port, kind }.`); return; }
    for (const key of Object.keys(output)) if (key !== 'port' && key !== 'kind') problems.push(`${where}.${key} is not a field of an output (port, kind).`);
    if (typeof output.port !== 'string' || !PORT.test(output.port)) problems.push(`${where}.port must name a field of the step's answer.`);
    else if (seen.has(output.port)) problems.push(`${where}.port "${output.port}" is named twice.`);
    else seen.add(output.port);
    if (typeof output.kind !== 'string' || !KIND.test(output.kind)) problems.push(`${where}.kind must be "row:<list>", "file" or "none".`);
  });
  return problems;
}

export function parseStepOutputs(outputs, where) {
  const problems = stepOutputsProblems(outputs, where);
  if (problems.length) throw new Error(problems.join(' '));
  return outputs;
}

// The person's cart lines: every row of the cart-line types, `{ kind, store, credential_name }`.
async function cartLines(door) {
  const lines = [];
  for (const type of SOURCE.cart_line.types) {
    for await (const row of door.list({ type, prefix: SOURCE.cart_line.id_prefix })) {
      const { kind, store, credential_name: credential } = row.value ?? {};
      if (typeof kind === 'string' && typeof store === 'string' && typeof credential === 'string') lines.push({ kind, store, credential_name: credential });
    }
  }
  return lines;
}

// The line that serves a kind: its own kind first, then `row:*` for any list.
const lineFor = (lines, kind) => lines.find(line => line.kind === kind) ?? (kind.startsWith('row:') ? lines.find(line => line.kind === 'row:*') : undefined);

export async function keepStepOutputs({ outputs, answer, run, step }, { door, tools }) {
  const lines = outputs.some(output => output.kind !== 'none') ? await cartLines(door) : [];
  const results = [];
  for (const { port, kind } of outputs) {
    const value = answer?.[port];
    const result = { port, kind, kept: false, value };
    if (kind === 'none') { results.push({ ...result, said: 'kind none: the value is returned and kept nowhere.' }); continue; }
    if (value === undefined) { results.push({ ...result, said: `the answer holds no "${port}": nothing to keep.` }); continue; }
    const line = lineFor(lines, kind);
    if (!line) { results.push({ ...result, said: `no cart line for ${kind}: the value is returned and kept nowhere.` }); continue; }
    const tool = SOURCE.keepers[kind.startsWith('row:') ? 'row' : 'file'];
    if (!tools) { results.push({ ...result, said: `cart line found, but no tool runner is here to call ${tool}: the value is returned and kept nowhere.` }); continue; }
    const where = `${run}:${step}:${port}`;
    const input = kind === 'file'
      ? { store: line.store, credential_name: line.credential_name, name: where, content: value }
      : { store: line.store, credential_name: line.credential_name, list: kind.slice('row:'.length), id: where, value };
    const answered = await tools.run(tool, input, `${where}:output`);
    results.push({ ...result, kept: true, said: `kept through ${tool}.`, tool, answered });
  }
  return results;
}

// src/workspace/list-targets.ts
//
// PURPOSE
//   The targets a list's DATA names, answered by this page: `workshop.run-tool` runs a Workshop tool for an action a
//   list's row names (a column's button, a record's menu row; trillion-workshop/tools/keep-lists-of-rows/do-work/run-record-action.ts), and
//   `slot::formula-engine` computes a column's value with the formula engine for a field a list's row derives
//   (parts/ui/show/record-views/record-set.tsx). Both are the person's own: a tool runs through the one run owner
//   (workshop-tool-api.ts), the formula on their own page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No tool, action or formula is named here: the request carries which tool and which formula.
//   2. A tool receives only the inputs its own input schema declares; the rest of an action's context stays here.
//   3. The formula engine decides every computed value; this file only hands it the binding and the record's values.
//   4. This is the one seam formula cells reach the formula engine through: the list tool
//      (trillion-workshop/tools/keep-lists-of-rows) names only the `slot::formula-engine` target, and `loadEvaluator`
//      is the only place that loads an evaluator. Its bytes are the trillion-rust formula crates
//      (crates/evaluate-over-rows over formula-core and ops-core) compiled for a JavaScript host.

import { answerTarget } from './records';
import { readJson } from './api';
import { newRunKey, runWorkshopTool, type Ran } from './workshop-tool-api';
import evaluatorBytesAddress from 'trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm';

type RunRequest = { operation?: string; input?: Record<string, unknown> };
// The tool as the engine's Workshop lists it (GET /work/api/door/tools:list?input={"tool":<id>}): its row's input_schema among
// its fields. The engine's own describe route was deleted (trillion-rust 2a7a0d50); the listed row is what the run checks.
type Listed = { input_schema?: { properties?: Record<string, unknown> } };
export const TOOL_LIST_PATH = '/work/api/door/tools:list';

/** Run the tool an action names, with the action's input narrowed to what the tool takes. */
export async function runToolForAction(request: unknown): Promise<Ran> {
  const { operation: toolId, input = {} } = (request ?? {}) as RunRequest;
  if (!toolId) throw new Error('This action names no tool to run.');
  const listed = await readJson<Listed>(`${TOOL_LIST_PATH}?input=${encodeURIComponent(JSON.stringify({ tool: toolId }))}`);
  const takes = new Set(Object.keys(listed.input_schema?.properties ?? {}));
  const toolInput = Object.fromEntries(Object.entries(input).filter(([key]) => takes.has(key)));
  return runWorkshopTool(toolId, toolInput, newRunKey('list-action'));
}

type Evaluator = { evaluate: (binding: unknown, input: unknown) => unknown };
let evaluator: Promise<Evaluator> | null = null;
// The evaluator's code and bytes are fetched the first time a computed column asks, never with the page.
const loadEvaluator = () => (evaluator ||= fetch(evaluatorBytesAddress)
  .then(response => { if (!response.ok) throw new Error('Computed columns could not be loaded.'); return response.arrayBuffer(); })
  .then(async bytes => (await import('trillion-workshop/tools/formula-engine/rules/evaluate-over-rows.mjs')).loadRowEvaluator(new Uint8Array(bytes)) as Evaluator)
  .catch(error => { evaluator = null; throw error; }));

/** One computed value: the formula engine evaluates the request's binding over the record's values (its context). */
export async function evaluateFormula(request: unknown): Promise<{ value: unknown }> {
  const { binding, context = {} } = (request ?? {}) as { binding?: unknown; context?: Record<string, unknown> };
  if (!binding) throw new Error('This column names no formula.');
  return { value: (await loadEvaluator()).evaluate(binding, context) };
}

/** Run a DATA-described request against this signed-in person's own API. The
 * screen names a same-origin API path and method; the authenticated API owner
 * still decides the operation, validation and permissions. */
export async function requestOwnApi(request: unknown): Promise<unknown> {
  const input = (request as { input?: Record<string, unknown> } | null)?.input ?? request as Record<string, unknown> | null;
  const path = typeof input?.path === 'string' ? input.path : '';
  const method = typeof input?.method === 'string' ? input.method.toUpperCase() : '';
  const address = new URL(path, 'https://own-api.invalid');
  if (!path.startsWith('/work/api/') || address.origin !== 'https://own-api.invalid' || !address.pathname.startsWith('/work/api/')
    || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    throw new Error('This action needs a supported signed-in API request.');
  const body = input?.body;
  return readJson(`${address.pathname}${address.search}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

export function answerListTargets() {
  answerTarget('workshop.run-tool', runToolForAction);
  answerTarget('own-api.request', requestOwnApi);
  answerTarget('slot::formula-engine', evaluateFormula);
}

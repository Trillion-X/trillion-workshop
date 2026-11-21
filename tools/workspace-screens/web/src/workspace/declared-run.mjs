// src/workspace/declared-run.mjs
//
// PURPOSE
//   The `run` request a parts screen (a screen made of shared parts: parts-screen.tsx) declares: `{ run: { input_schema } }`.
//   It runs the tool that declared the screen, through the page's one tool run (declared-request.ts), under the person's
//   own pass; the door enforces their rights. The tool is the one the shell opened: the screen's declaration and its
//   spec name no tool, so a spec cannot send a call to any other tool.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The declaration names nothing but its input schema: a `tool`, `path`, `method` or any other key is refused.
//   2. The tool is the declaring tool id the shell holds (its descriptor), never a value from the declaration or the spec.
//   3. The input is a plain object of at most MAX_INPUT_BYTES, naming no `tool` or `tool_id` key, with no key its input
//      schema does not list (when it declares one) and with each required key present.
//   4. A declaration with no `run` key is not a run request; the module kind keeps its own checks (module-surface-requests.mjs).
//   5. The surface input (the tab's input: the route's trailing part, the row's own fields) reaches the run only for the fields
//      the input schema names; `tool` and `tool_id` never come from it. A call's own input wins over the surface input.

const MAX_INPUT_BYTES = 32768;
const refused = () => new Error('This screen request is unavailable.');
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Whether a declaration is a `run` request (its `run` key is the whole declaration's kind). */
export const isRunRequest = declaration => plain(declaration) && Object.hasOwn(declaration, 'run');

/** The input a `run` request is sent with: the surface input's fields the declared input schema names (none when it declares
 *  no schema), overlaid by the call's own input. A field the surface holds for `tool` or `tool_id` is never carried. */
export function runInputFor(declaration, surfaceInput = {}, input = {}) {
  const properties = plain(declaration?.run?.input_schema?.properties) ? declaration.run.input_schema.properties : {};
  const carried = Object.entries(plain(surfaceInput) ? surfaceInput : {}).filter(([name, value]) => value !== undefined
    && Object.hasOwn(properties, name) && name !== 'tool' && name !== 'tool_id');
  return { ...Object.fromEntries(carried), ...(plain(input) ? input : {}) };
}

/** The tool run a parts screen's `run` request makes: `{ tool, input }`, with `tool` the declaring tool id. */
export function runFor(declaration, declaringTool, input = {}) {
  if (typeof declaringTool !== 'string' || !declaringTool || declaringTool.length > 200) throw refused();
  if (!plain(declaration) || Object.keys(declaration).some(key => key !== 'run')) throw refused();
  const run = declaration.run;
  if (!plain(run) || Object.keys(run).some(key => key !== 'input_schema')) throw refused();
  if (!plain(input) || Object.hasOwn(input, 'tool') || Object.hasOwn(input, 'tool_id')) throw refused();
  let bytes;
  try { bytes = JSON.stringify(input); } catch { throw refused(); }
  if (new TextEncoder().encode(bytes).byteLength > MAX_INPUT_BYTES) throw refused();
  const schema = run.input_schema;
  if (schema !== undefined) {
    if (!plain(schema) || !plain(schema.properties)) throw refused();
    if (Object.keys(input).some(key => !Object.hasOwn(schema.properties, key))) throw refused();
    if ((schema.required ?? []).some(key => !Object.hasOwn(input, key))) throw refused();
  }
  return { tool: declaringTool, input };
}

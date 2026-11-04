// src/controls-tools.mjs
//
// Purpose
//   The MCP tools over the person store's /controls routes (src/made-controls.mjs), with their titles and hints. Kept
//   apart from the owner so the tool list (src/tools.mjs) stays a list of declarations.
//

const idField = description => ({ type: 'string', description });

/** The MCP tools over the person store's /controls routes. */
export const controlsTools = call => [
  { name: 'make_controls', description: 'Makes a saved interface around what the person wants to adjust themselves and opens it on their Trillion page with an optional demonstration. Give intent in their words, tool_id (from find_tool_for_job) or job, bind (the subject inputs, such as a file or conversation), settings (only the relevant inputs, each a name or { input, label, note }) and values (where each starts). There is no required number of controls. If settings are omitted, the tool\'s suggested settings are used. Controls and their labels come from the tool\'s declared schema and controls data. The declared preview shows supported changes while the person adjusts them; settings it cannot preview are identified. A tool without a visual preview shows its input values, which is not proof of its final result. Undo, Redo and Reset work on control values. Keeping an executable tool runs its checked action and retains its exact task and result; a screen-only tool opens its declared shared screen, whose own controls perform the work. The interface is saved as an owned workflow (interface_id) and reopens without generation. Change it by calling again with id; share it with share_to_space (record workflow:<id>), publish a template with publish_workflow, or remove it with remove_workflow. Private subject bindings and instance values stay outside shared templates. demo false skips the demonstration; open_now false saves without opening.', inputSchema: {
    type: 'object', required: ['intent'],
    properties: {
      intent: idField('What the person wants to adjust, in their words'),
      tool_id: idField('The tool the controls drive (find_tool_for_job gives it); or give job'),
      job: idField('What the tool does, when you have no tool_id: the best match with settings is used'),
      bind: { type: 'object', description: 'What the interface works on, by input name, such as { video: "1f:..." }; never drawn as a control' },
      settings: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] }, description: 'The inputs to show as controls, in order: a name, or { input, label, note } with the person\'s words' },
      semantic_controls: { type: 'array', maxItems: 32, description: 'Meaningful controls that map to several tool inputs. Each has its own JSON value schema and formula-engine bindings selecting from self by control key. Subject bindings and starting values remain private. Omit to preserve the saved definition; send [] to remove them.', items: {
        type: 'object', required: ['key', 'label', 'schema', 'bindings'], additionalProperties: false,
        properties: {
          key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' }, label: { type: 'string', minLength: 1, maxLength: 120 },
          note: { type: 'string', maxLength: 240 }, schema: { type: 'object', description: 'JSON Schema for this control value, such as {type:"number",minimum:0,maximum:1}. Put private starting values in values.' },
          bindings: { type: 'object', minProperties: 1, additionalProperties: { type: 'object' }, description: 'By underlying tool input name, a composition-ast binding, e.g. {warmth:{$kind:"binding",select:{from:"self",path:["mood"]}},saturation:{$kind:"binding",select:{from:"self",path:["mood"]},transform:[{op:"op:core.mul",args:{value:0.2}},{op:"op:core.add",args:{value:1}}]}}.' },
        },
      } },
      views: { type: 'array', maxItems: 16, description: 'Additional registered Trillion views to compose around this task. Each names a screen tool and maps its input names to bound subjects, current values, or checked projected tool inputs. Screen actions use their existing owners. Omit to preserve views; [] removes them.', items: {
        type: 'object', required: ['id', 'tool_id', 'inputs'], additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' }, tool_id: { type: 'string', pattern: '^tool:' },
          inputs: { type: 'object', additionalProperties: { type: 'object', required: ['from', 'key'], additionalProperties: false,
            properties: { from: { enum: ['bind', 'values', 'input'] }, key: { type: 'string' } },
          } },
        },
      } },
      values: { type: 'object', description: 'Where each control starts, by input name' },
      id: idField('An interface_id from an earlier make_controls, to change it'),
      title: idField('Its name in a few words; the intent when left out'),
      layout: idField('beside (preview beside the controls, the default on a wide screen) or above'),
      demo: { type: 'boolean', description: 'false: no demonstration' },
      open_now: { type: 'boolean', description: 'false: save it without opening it now' },
      by: idField('Your name as the person knows you'),
    },
  }, run: input => call('/controls/make', input) },
  { name: 'read_controls', description: 'Reads one saved interface, its controls and the person\'s current values and results. If an action was already requested, reconciles its exact task; a request interrupted before the task identity arrived resumes under its original request key. Reading never starts a new action.', inputSchema: {
    type: 'object', required: ['id'], properties: { id: idField('An interface_id') },
  }, run: input => call('/controls/read', input) },
  { name: 'inspect_controls', description: 'Reads one saved interface, its semantic bindings, current saved values and last observed action state. Changes nothing and never resumes an action. Use read_controls to reconcile an already requested action.', inputSchema: {
    type: 'object', required: ['id'], additionalProperties: false, properties: { id: idField('The saved interface_id') },
  }, run: input => call('/controls/inspect', input) },
  { name: 'keep_controls', description: 'Keeps the person\'s latest control values or bound subject in an existing interface without running its tool. Values are checked against that tool\'s input schema. Use make_controls with the same id to change the interface definition; keep_controls preserves its original Reset baseline.', inputSchema: {
    type: 'object', required: ['id'], additionalProperties: false,
    properties: { id: idField('The saved interface_id'), bind: { type: 'object', description: 'Subject inputs declared by this tool' }, values: { type: 'object', description: 'Shown control inputs to keep, by name' } },
  }, run: input => call('/controls/keep', input) },
  { name: 'run_controls', description: 'Runs the saved interface\'s tool with its bound subject and checked control values. Keeps the exact task and result in that interface, so closing and reopening recovers the same action. Reuse request_key only to retry exactly the same values; a different run needs a different key. Existing account and tool permissions still apply.', inputSchema: {
    type: 'object', required: ['id', 'request_key'], additionalProperties: false,
    properties: { id: idField('The saved interface_id'), values: { type: 'object', description: 'Shown control values for this run; omitted values use the saved ones' }, request_key: { type: 'string', minLength: 1, maxLength: 200, description: 'A unique action key, retained unchanged for retries' } },
  }, run: input => call('/controls/run', input) },
];

export const controlsAnnotations = {
  make_controls: { title: 'Make live controls for something', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_controls: { title: 'Read an interface of controls', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_controls: { title: 'Inspect saved controls', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  keep_controls: { title: 'Keep control values', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run_controls: { title: 'Run saved controls', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

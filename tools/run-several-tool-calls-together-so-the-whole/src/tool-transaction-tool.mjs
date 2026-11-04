// src/tool-transaction-tool.mjs
//
// The MCP tool that runs a plan of other tools together (src/tool-transaction.mjs): it is made from the list of tools it may run,
// so it can run exactly the tools an AI can call, with the same hints and the same answers.
import rules from '../../shared-code/src/tool-transaction.json' with { type: 'json' };
import { runTransaction } from './tool-transaction.mjs';

const name = rules.tool_name;

export const transactionTools = (listed) => [{
  name,
  description: `Makes several of the other tools' calls together, in order, so the whole stands or is put back. Send steps: each { id, tool, input }; any value in an input can be { "$from": "<an earlier step's id>.result.<path>" } to take it from that step's answer ([*] after a list gathers one field from every item). Nothing in a plan is code. If a step fails, the steps already done are put back in reverse order and the answer says what was put back (undone) and what could not be (not_undone). A step that cannot be put back can only be the last step. At most ${rules.limits.steps} steps. Answers committed true, or false with failed (the step and why), plus results by step id.`,
  inputSchema: {
    type: 'object', required: ['steps'],
    properties: { steps: { type: 'array', minItems: 1, maxItems: rules.limits.steps, items: { type: 'object', required: ['id', 'tool'], properties: { id: { type: 'string' }, tool: { type: 'string' }, input: { type: 'object' } } } } },
  },
  run: ({ steps }) => runTransaction({
    steps, tools: listed,
    invoke: async (toolName, input) => {
      const tool = listed.find((candidate) => candidate.name === toolName);
      return tool.run(input);
    },
  }),
}];

export const transactionAnnotations = {
  [name]: { title: 'Run several tools together', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

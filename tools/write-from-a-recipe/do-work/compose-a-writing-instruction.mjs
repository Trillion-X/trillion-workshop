// tools/write-from-a-recipe/do-work/compose-a-writing-instruction.mjs
//
// tool:compose-a-writing-instruction, run before the person's AI writes. One JSON request on standard input:
//   { recipe? | recipe_id?, work_item?, grounding?: [excerpt], blocks?: [{ id, body, label? }] }
// prints { result: { recipe_id, instruction_text, input_refs, output_kind, output_schema, gate_policy, delivery_target } }
// on its last line. The AI writes from instruction_text and then hands what it wrote to
// tool:check-writing-against-its-recipe. Nothing here asks any AI to write.
import { text } from 'node:stream/consumers';
import { composeRunRequest } from '../read-data/compose-instruction.mjs';
import { blocksWith, recipeOf, workItemOf } from '../read-data/library.mjs';

export function composeAWritingInstruction(input = {}) {
  const recipe = recipeOf(input);
  const workItem = workItemOf(recipe, input.work_item);
  const request = composeRunRequest({ recipe, workItem, grounding: Array.isArray(input.grounding) ? input.grounding : [], blocks: blocksWith(input.blocks) });
  return {
    recipe_id: recipe.id ?? null,
    instruction_text: request.instruction_text,
    input_refs: request.input_refs,
    output_kind: request.output_kind,
    output_schema: recipe.output_contract?.schema ?? null,
    gate_policy: recipe.gate_policy ?? null,
    delivery_target: recipe.delivery_target ?? null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: composeAWritingInstruction(JSON.parse((await text(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

// The composer and tool:compose-a-writing-instruction. Carried from bitfield-packages packages/content-generation:
// tests/test_content_generation.py (TestCompose), tests/workflow-input-output-contract.test.mjs (blocks from the Map),
// tests/addressed-input-composition.test.mjs (input references) and tests/compose-and-gate-runtime.test.mjs
// (composing with no output file). All values are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeRunRequest } from '../read-data/compose-instruction.mjs';
import { composeAWritingInstruction } from '../do-work/compose-a-writing-instruction.mjs';

test('recipe data controls the instruction and the output kind', () => {
  const recipe = { instruction_plan: { prompt_template: [{ literal: 'Draft:' }, { slot: 'work_item', path: 'subject' }] }, ai_producer_target: { output_kind: 'editable-writing' } };
  const request = composeRunRequest({ recipe, workItem: { subject: 'a concise memo' }, requestId: 'request:one' });
  assert.equal(request.instruction_text, 'Draft:\na concise memo');
  assert.equal(request.output_kind, 'editable-writing');
  assert.equal(request.request_id, 'request:one');
});

test('one interpreter keeps distinct recipes in their own data', () => {
  for (const [scope, question, expected] of [
    ['scope:one', 'How does this product work?', 'Answer for scope:one:\nHow does this product work?'],
    ['scope:two', 'Where can this service be found?', 'Answer for scope:two:\nWhere can this service be found?'],
  ]) {
    const recipe = { instruction_plan: { prompt_template: [{ literal: `Answer for ${scope}:` }, { slot: 'work_item', path: 'question' }] }, ai_producer_target: { output_kind: 'grounded-answer' } };
    const request = composeRunRequest({ recipe, workItem: { question } });
    assert.equal(request.instruction_text, expected);
    assert.equal(request.output_kind, 'grounded-answer');
  }
});

test('instruction blocks resolve from the canonical Map, and a missing block is refused', () => {
  const recipe = { instruction_plan: { prompt_template: [{ block_ref: 'instruction:opaque' }, { slot: 'work_item', path: 'topic' }] } };
  const blocks = [{ kind: 'ai-instruction-block', id: 'instruction:opaque', body: 'Keep exact citations.' }];
  assert.equal(composeRunRequest({ recipe, workItem: { topic: 'Useful result' }, blocks }).instruction_text, 'Keep exact citations.\nUseful result');
  assert.throws(() => composeRunRequest({ recipe, workItem: { topic: 'x' }, blocks: [] }), /instruction block is unavailable: instruction:opaque/);
  // An object's own property names are not blocks: a recipe naming one is refused, not filled.
  assert.throws(() => composeRunRequest({ recipe: { instruction_plan: { prompt_template: [{ block_ref: 'toString' }] } }, workItem: {}, blocks: [] }), /unavailable: toString/);
});

test('selected input references are kept, and an absent selection is refused', () => {
  const recipe = { context_retrieval: { input_refs_field: 'evidence' }, instruction_plan: { prompt_template: ['Compare the saved evidence.'] } };
  const refs = [{ address: 'synthetic:outcome', expected_revision: 'second', expected_content_hash: 'synthetic-hash' }];
  assert.deepEqual(composeAWritingInstruction({ recipe, work_item: { evidence: refs } }).input_refs, refs);
  for (const evidence of [undefined, [], null, {}]) {
    assert.throws(() => composeAWritingInstruction({ recipe, work_item: { evidence } }), /Saved evidence references are required/);
  }
});

test('the schema, grounding and conditional segments render from the recipe and the supplied excerpts', () => {
  const recipe = {
    instruction_plan: { prompt_template: [
      { literal: 'Return JSON.' }, { slot: 'schema' },
      { slot: 'conditional_grounding', when_present: [{ slot: 'grounding', label: 'Sources:' }], when_absent: ['Say you have no sources.'] },
      { slot: 'conditional_value', path: 'audience', when_present: [{ slot: 'work_item', path: 'audience' }], when_absent: [] },
    ] },
    output_contract: { schema: { type: 'object' } },
  };
  const grounded = composeAWritingInstruction({ recipe, work_item: { audience: 'new readers' }, grounding: [{ ref: 'source:one', text: 'Supported.' }] });
  assert.equal(grounded.instruction_text, 'Return JSON.\n{\n  "type": "object"\n}\nSources:\n[{"ref":"source:one","text":"Supported."}]\nnew readers');
  assert.deepEqual(grounded.output_schema, { type: 'object' });
  assert.equal(composeAWritingInstruction({ recipe, work_item: {} }).instruction_text, 'Return JSON.\n{\n  "type": "object"\n}\nSay you have no sources.');
});

test('a line segment joins its parts with nothing between them, so a value sits inside a sentence', () => {
  const recipe = { instruction_plan: { prompt_template: [{ line: ['Rewrite in a ', { slot: 'work_item', path: 'tone' }, ' tone:\n\n', { slot: 'work_item', path: 'text' }] }] } };
  assert.equal(composeAWritingInstruction({ recipe, work_item: { tone: 'warm', text: 'Hello.' } }).instruction_text, 'Rewrite in a warm tone:\n\nHello.');
});

test('a kept recipe by id fills its defaults, refuses a missing required answer, and dispatches nothing', () => {
  const composed = composeAWritingInstruction({ recipe_id: 'writing-recipe:rewrite-with-options', work_item: { text: 'The meeting moved to Tuesday.' } });
  assert.match(composed.instruction_text, /^Rewrite the following\. Tone: \S/);
  assert.match(composed.instruction_text, /The meeting moved to Tuesday\.$/);
  assert.deepEqual(Object.keys(composed).sort(), ['delivery_target', 'gate_policy', 'input_refs', 'instruction_text', 'output_kind', 'output_schema', 'recipe_id']);
  assert.throws(() => composeAWritingInstruction({ recipe_id: 'writing-recipe:summarize', work_item: {} }), /work_item needs text/);
  assert.throws(() => composeAWritingInstruction({ recipe_id: 'writing-recipe:no-such-thing', work_item: { text: 'x' } }), /tool:list-writing-recipes/);
  assert.throws(() => composeAWritingInstruction({ work_item: { text: 'x' } }), /Give recipe/);
});

test('a person\'s own block replaces a kept block of the same id', () => {
  const recipe = { instruction_plan: { prompt_template: [{ block_ref: 'ai-instruction-block:plain-language' }] } };
  assert.match(composeAWritingInstruction({ recipe }).instruction_text, /^Write in plain language\./);
  assert.equal(composeAWritingInstruction({ recipe, blocks: [{ id: 'ai-instruction-block:plain-language', body: 'Use short words.' }] }).instruction_text, 'Use short words.');
});

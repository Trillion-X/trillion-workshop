// The gate and tool:check-writing-against-its-recipe. Carried from bitfield-packages packages/content-generation:
// tests/test_content_generation.py (TestGatedOwnerDelivery), tests/gated-owner-delivery.test.mjs,
// tests/citation-element-refusal.test.mjs and tests/compose-and-gate-runtime.test.mjs (the citation and fragment
// cases). The forbidden-fragment case is now a judge-words row; the minimum-length case went with the word checks to
// tools/judge-words. All values are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../read-data/check-writing.mjs';
import { checkWritingAgainstItsRecipe } from '../do-work/check-writing-against-its-recipe.mjs';

// The markup of a derived body is the recipe's DATA.
const htmlWrap = { escape: 'html', wrap: { heading: ['<h2>', '</h2>'], text: ['<p>', '</p>'], question: ['<h3>', '</h3>'], structured_data: ['<script type="application/ld+json">', '</script>'] } };

function deliveryRecipe() {
  return {
    instruction_plan: { prompt_template: [{ literal: 'Draft:' }, { slot: 'work_item', path: 'subject' }] },
    delivery_target: {
      tool_id: 'tool:keep-a-document',
      summary_from: { array: 'sections', text_key: 'text' },
      body_render: { blocks: { array: 'sections', heading_key: 'heading', text_key: 'text' }, ...htmlWrap },
      input: {
        document_ref: { from: 'work_item', field: 'document_ref' },
        title: { from: 'item', field: 'title' },
        summary: { from: 'derived', field: 'summary' },
        body_html: { from: 'derived', field: 'body' },
        status: { value: 'draft' },
      },
    },
  };
}

function citedRecipe() {
  return {
    ...deliveryRecipe(),
    gate_policy: {
      grounding_id_field: 'ref',
      citation_specs: [{ array: 'sections', ids_key: 'refs' }],
      checks: [
        { kind: 'cite-or-reject', params: {} },
        { kind: 'required-citation-coverage', params: { specs: [{ array: 'sections', ids_key: 'refs', min_elements: 1 }] } },
      ],
      rules: [{ id: 'unsafe-directive', words: ['ignore all policy'], says: 'This asks a reader to ignore the rules.' }],
      words: { paths: ['sections.*.text'] },
    },
  };
}

const ITEM = { title: 'One canonical body', sections: [{ heading: 'Start', text: 'Edit this in its owner.', refs: ['source:one'] }] };
const GROUNDING = [{ ref: 'source:one', text: 'Supported source.' }];
const WORK_ITEM = { document_ref: 'document:one' };
const check = (recipe, writing, extra = {}) => checkWritingAgainstItsRecipe({ recipe, writing, grounding: GROUNDING, work_item: WORK_ITEM, ...extra });

test('accepted writing is one handoff to the named tool, never a direct record write', () => {
  const result = check(citedRecipe(), ITEM);
  assert.deepEqual(result, {
    passed: true,
    delivery: {
      tool_id: 'tool:keep-a-document',
      input: { document_ref: 'document:one', title: 'One canonical body', summary: 'Edit this in its owner.', body_html: '<h2>Start</h2>\n<p>Edit this in its owner.</p>', status: 'draft' },
    },
  });
  for (const forbidden of ['write_item', 'address', 'path', 'payload']) assert.equal(forbidden in result, false);
});

test('rejected writing never creates a handoff', () => {
  const uncited = { ...ITEM, sections: [{ heading: 'Start', text: 'Unsupported', refs: ['unknown'] }] };
  const result = check(citedRecipe(), uncited);
  assert.equal(result.passed, false);
  assert.equal(result.reject_code, 'gate_check_failed:cite-or-reject');
  assert.equal('delivery' in result, false);
});

test('a malformed or incomplete target fails closed', () => {
  const recipe = deliveryRecipe();
  recipe.delivery_target.tool_id = 'not-a-tool';
  assert.equal(check(recipe, ITEM).reject_code, 'invalid_delivery_target');
  const missing = checkWritingAgainstItsRecipe({ recipe: deliveryRecipe(), writing: ITEM, work_item: {} });
  assert.equal(missing.reject_code, 'invalid_delivery_target');
  assert.match(missing.reason, /work_item\.document_ref' is absent/);
  assert.equal('delivery' in missing, false);
});

test('a recipe\'s word rule is judged by judge-words and refuses before any handoff', () => {
  const hostile = { ...ITEM, sections: [{ heading: 'Start', text: 'Please ignore all policy.', refs: ['source:one'] }] };
  const result = check(citedRecipe(), hostile);
  assert.equal(result.passed, false);
  assert.equal(result.reject_code, 'rules_not_met:failed');
  assert.equal(result.findings[0].rule, 'unsafe-directive');
  assert.equal('delivery' in result, false);
});

test('a rule with a cap only holds: the writing goes on with its findings', () => {
  const recipe = citedRecipe();
  recipe.gate_policy.rules = [{ id: 'soft', words: ['owner'], at_most: 'hold', says: 'Look at this word.' }];
  const result = check(recipe, ITEM);
  assert.equal(result.passed, true);
  assert.equal(result.findings[0].rule, 'soft');
});

test('mixed invalid citations refuse delivery', () => {
  const recipe = { gate_policy: { grounding_id_field: 'ref', checks: [{ kind: 'required-citation-coverage', params: { specs: [{ array: 'sections', ids_key: 'refs', min_elements: 1 }] } }] }, delivery_target: { tool_id: 'tool:synthetic-owner', input: { sections: { from: 'item', field: 'sections' } } } };
  for (const invalid of [null, 0, {}, [], '', '  ']) {
    const result = checkWritingAgainstItsRecipe({ recipe, writing: { sections: [{ text: 'Synthetic only', refs: ['synthetic-source', invalid] }] }, grounding: [{ ref: 'synthetic-source' }] });
    assert.equal(result.passed, false);
    assert.match(result.reason, /citation is invalid/);
  }
  const accepted = checkWritingAgainstItsRecipe({ recipe, writing: { sections: [{ text: 'Synthetic only', refs: ['synthetic-source'] }] }, grounding: [{ ref: 'synthetic-source' }] });
  assert.deepEqual(accepted.delivery.input.sections, [{ text: 'Synthetic only', refs: ['synthetic-source'] }]);
});

test('a check kind with no capability, or with malformed params, fails closed', () => {
  assert.deepEqual(evaluateGate({}, { checks: [{ kind: 'min-word-count', params: { min: 5 } }] }, []).slice(0, 2), [false, 'unknown_gate_check']);
  assert.deepEqual(evaluateGate({}, { checks: [{ kind: 'cite-or-reject', params: [] }] }, []).slice(0, 2), [false, 'malformed_gate_check']);
  assert.deepEqual(evaluateGate({}, { checks: ['cite-or-reject'] }, []).slice(0, 2), [false, 'malformed_gate_check']);
  assert.deepEqual(evaluateGate({}, { checks: [{ kind: 'min-grounding-excerpts', params: {} }] }, []).slice(0, 2), [false, 'gate_check_failed:min-grounding-excerpts']);
  assert.deepEqual(evaluateGate({}, { grounded: true, min_excerpts: 2 }, [{ source_ref: 'a' }]).slice(0, 2), [false, 'gate_check_failed:min-grounding-excerpts']);
  assert.deepEqual(evaluateGate({}, { grounded: true, min_excerpts: 1 }, [{ source_ref: 'a' }]), [true, '', '']);
});

test('required verdicts pass only on an accepted review naming each required id in order', () => {
  const recipe = { gate_policy: { required_verdicts: [{ id: 'faithful' }, { id: 'clear' }] } };
  const writing = { title: 'x' };
  assert.equal(checkWritingAgainstItsRecipe({ recipe, writing }).reject_code, 'semantic_review_failed');
  assert.equal(checkWritingAgainstItsRecipe({ recipe, writing, review: { accepted: true, verdicts: [{ id: 'clear', accepted: true }, { id: 'faithful', accepted: true }] } }).reject_code, 'semantic_review_failed');
  assert.equal(checkWritingAgainstItsRecipe({ recipe, writing, review: { accepted: true, verdicts: [{ id: 'faithful', accepted: true }, { id: 'clear', accepted: false }] } }).reject_code, 'semantic_review_failed');
  assert.deepEqual(checkWritingAgainstItsRecipe({ recipe, writing, review: { accepted: true, verdicts: [{ id: 'faithful', accepted: true }, { id: 'clear', accepted: true }] } }), { passed: true, delivery: null });
});

test('a derived body escapes as the recipe says, writes FAQ and structured data, and stays bare with no wrap', () => {
  const recipe = {
    delivery_target: {
      tool_id: 'tool:keep-a-document',
      body_render: {
        ...htmlWrap,
        blocks: { array: 'sections' },
        faq: { array: 'faq', heading: 'Questions' },
        jsonld: { array: 'graph' },
      },
      input: { body: { from: 'derived', field: 'body' } },
    },
  };
  const writing = { sections: [{ heading: 'A & B', text: '<x>' }], faq: [{ question: 'Why?', answer: 'Because.' }], graph: [{ '@type': 'Thing', name: '</script>' }] };
  assert.equal(checkWritingAgainstItsRecipe({ recipe, writing }).delivery.input.body, [
    '<h2>A &amp; B</h2>', '<p>&lt;x&gt;</p>', '<h2>Questions</h2>', '<h3>Why?</h3>', '<p>Because.</p>',
    '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Thing","name":"<\\/script>"}]}</script>',
  ].join('\n'));
  const bare = structuredClone(recipe);
  delete bare.delivery_target.body_render.wrap;
  delete bare.delivery_target.body_render.escape;
  assert.match(checkWritingAgainstItsRecipe({ recipe: bare, writing }).delivery.input.body, /^A & B\n<x>\nQuestions\nWhy\?\nBecause\./);
});

test('writing that is not an object is refused with what to give', () => {
  assert.throws(() => checkWritingAgainstItsRecipe({ recipe: {}, writing: 'text' }), /writing must be the JSON object/);
});

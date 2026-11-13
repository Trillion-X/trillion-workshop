import test from 'node:test';
import assert from 'node:assert/strict';
import {validateInput, requestPlan} from '../read-data/evaluation-integrity.mjs';

function fixture(split = 'eval') {
  return {schema:'book-voice-decider-challenge-v3', criteria:[{
    id:'reader-fit', question:'Does the explanation name the object?', primitive:'one-of',
    options:[{name:'pass',description:'The object is named.'},{name:'fail',description:'The object is missing.'}],
    reference_context:'Check the literal reader context and target.', applies_to:['paragraph'],
  }], items:[{id:'case-one',family:'example-one',split,source_kind:'constructed_regression',
    block_kind:'paragraph',text:'The package contains twelve pencils.',reader_context:''}]};
}

test('evaluation remains the default and does not admit unlabeled-only input', () => {
  assert.equal(validateInput(fixture()).evalItems.length,1);
  assert.throws(() => validateInput(fixture('unlabeled')),/no eval items/);
});

test('isolated evaluation refuses mixed splits instead of scoring unvalidated rows', () => {
  const input=fixture();input.items.push({...input.items[0],id:'case-two',family:'example-two',
    split:'unlabeled',checks:{'reader-fit':'pass'}});
  assert.equal(validateInput(input).evalItems.length,1);
  assert.throws(()=>validateInput(input,{mode:'scoring-evaluation'}),/requires only v3 eval items/);
  assert.equal(validateInput(fixture(),{mode:'scoring-evaluation'}).evalItems.length,1);
});

test('explicit unlabeled validation preserves the original request and does not mint eval rows', () => {
  const input=fixture('unlabeled'), before=JSON.stringify(input), plan=requestPlan(input,input.items[0]);
  assert.equal(validateInput(input,{mode:'unlabeled'}).evalItems.length,0);
  assert.equal(JSON.stringify(input),before);
  assert.deepEqual(requestPlan(input,input.items[0]),plan);
});

test('unlabeled mode refuses labels, mixed splits, old schemas and unknown modes', () => {
  for (const mutate of [d=>d.items[0].gold='pass',d=>d.items[0].checks={'reader-fit':'pass'},
    d=>d.items.push({...d.items[0],id:'case-two',family:'example-two',split:'eval'}),
    d=>d.schema='book-voice-decider-challenge-v2']) {
    const input=fixture('unlabeled');mutate(input);
    assert.throws(() => validateInput(input,{mode:'unlabeled'}),/requires only v3 unlabeled/);
  }
  assert.throws(() => validateInput(fixture(),{mode:'anything'}),/unsupported input validation mode/);
});

test('both validation modes retain source metadata, block shape and criterion guards', () => {
  for(const [split,mode] of [['eval','evaluation'],['unlabeled','unlabeled']]) {
    const missing=fixture(split);delete missing.items[0].source_kind;
    assert.throws(()=>validateInput(missing,{mode}),/incomplete item/);
    const wrong=fixture(split);wrong.items[0].text='### A heading';
    assert.throws(()=>validateInput(wrong,{mode}),/block kind does not match/);
    const noReference=fixture(split);noReference.criteria[0].reference_context='';
    assert.throws(()=>validateInput(noReference,{mode}),/missing pinned reference/);
  }
});

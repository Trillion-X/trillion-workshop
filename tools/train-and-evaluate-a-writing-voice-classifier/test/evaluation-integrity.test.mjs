import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REQUEST_POLICY, TYPED_REQUEST_POLICY, SERVING_IDENTITY_POLICY, aggregateSectionChunkResults, classifyWritingBlock, expectedDecision, reportCriteria, requestPlan, requestPolicyFor, validateInput, validateReport } from '../read-data/evaluation-integrity.mjs';
import { intoBatchRequest } from '../../ask-a-small-model-for-a-verdict/do-work/ask-a-hosted-classifier.mjs';
import { blake3Hex } from '../do-work/evaluate-voice.mjs';

// Made-up fixtures in the shapes the old runs kept (test/fixtures): a single-question run and a criterion run with no
// request evidence (historical), and a binary run made by the evaluator with captured evidence.
const book = resolve(new URL('./fixtures', import.meta.url).pathname);
const b3file = path => blake3Hex(readFileSync(path));
const deepCopy = value => JSON.parse(JSON.stringify(value));
const baselineData = JSON.parse(readFileSync(join(book, 'baseline-challenge.json'), 'utf8'));
const baselineResult = JSON.parse(readFileSync(join(book, 'baseline-results.json'), 'utf8'));
const ITEMS = baselineData.items.length;

test('saved binary requests with omitted meanings survive a JSON round trip', () => {
  const dataPath = join(book, 'binary-challenge.json');
  const input = JSON.parse(readFileSync(dataPath, 'utf8'));
  const report = JSON.parse(readFileSync(join(book, 'binary-results.json'), 'utf8'));
  const expected = {input, model:report.model, endpoint:report.endpoint,
    dataPath:report.data, dataBlake3:b3file(dataPath), rubricBlake3:report.rubric_blake3,
    serving:report.serving, requestPolicy:report.request_policy,
    requestEvidenceVersion:report.request_evidence_version};
  const accepted = validateReport(report, expected, {requireServing:true});
  assert.equal(accepted.complete, true);
  assert.equal(accepted.items.length, input.items.length);
  for (const item of input.items) {
    assert.deepEqual(requestPlan(input, item), deepCopy(requestPlan(input, item)));
  }
  const changed = deepCopy(input);
  changed.criteria[0].means = {yes:'a different affirmative meaning', no:'a different negative meaning'};
  assert.throws(() => validateReport(report, {...expected, input:changed}, {requireServing:true}),
    /changed request state\/question\/context/);
});

function baselineExpected(input = baselineData, dataBlake3 = b3file(join(book, 'baseline-challenge.json'))) {
  return {input, model:baselineResult.model, endpoint:baselineResult.endpoint,
    dataPath:baselineResult.data, dataBlake3,
    rubricBlake3:null, serving:baselineResult.serving, requestPolicy:REQUEST_POLICY, requestEvidenceVersion:0};
}

test('current consumer accepts an intact historical single-question run', () => {
  const validated = validateReport(baselineResult, baselineExpected(), {requireServing:true});
  assert.equal(validated.complete, true);
  assert.equal(validated.identity_assurance, 'historical-unverified');
  assert.equal(validated.items.length, ITEMS);
  assert.equal(validated.coveredIds.size, baselineData.items.filter(item => item.split === 'eval').length);
});

test('current consumer accepts an intact historical criterion-based run', () => {
  const dataPath = join(book, 'criteria-challenge.json');
  const input = JSON.parse(readFileSync(dataPath, 'utf8'));
  const report = JSON.parse(readFileSync(join(book, 'criteria-results.json'), 'utf8'));
  const validated = validateReport(report, {input, model:report.model, endpoint:report.endpoint,
    dataPath:report.data, dataBlake3:b3file(dataPath), rubricBlake3:report.rubric_blake3,
    serving:report.serving, requestEvidenceVersion:0}, {requireServing:true});
  assert.equal(validated.complete, true);
  assert.equal(validated.items.length, input.items.length);
});

test('section chunk manifests bind complete ordered source text and local request policy', () => {
  const input = {schema:'book-voice-decider-challenge-v3', dataset_role:'unlabeled',
    document_blake3:'a'.repeat(64), criteria:[
      {id:'section-heading-fit', primitive:'one-of', question:'Whole-section criterion is not sent per chunk.',
        options:['pass','fail','uncertain'], reference_context:'Use source reference only.', applies_to:['heading'],
        section_chunk_request:{question:'Does this local chunk support the heading topic and scope?', options:['pass','fail','uncertain']}},
      {id:'body-check', primitive:'one-of', question:'Does this body block read clearly?', options:['pass','fail','uncertain'],
        reference_context:'Use clear language.', applies_to:['paragraph']},
    ], items:[
      {id:'h', family:'h', split:'unlabeled', source_kind:'manuscript', origin:{kind:'manuscript'}, block_kind:'heading', source_block_index:0,
        text:'# Topic', section_chunk_manifest:{source_blake3:'a'.repeat(64), heading_block_index:0, section_end_block_index:3,
          chunks:[{chunk_index:0, block_indices:[1], text:'First body.'},{chunk_index:1, block_indices:[2], text:'Second body.'}]}},
      {id:'p1', family:'p1', split:'unlabeled', source_kind:'manuscript', origin:{kind:'manuscript'}, block_kind:'paragraph', source_block_index:1, text:'First body.'},
      {id:'p2', family:'p2', split:'unlabeled', source_kind:'manuscript', origin:{kind:'manuscript'}, block_kind:'paragraph', source_block_index:2, text:'Second body.'},
    ]};
  const plan = requestPlan(input, input.items[0]);
  assert.equal(requestPolicyFor(input), 'typed-source-bound-section-chunks-v1');
  assert.equal(plan.chunk_requests.length, 2);
  assert.match(plan.chunk_requests[0].asking['section-heading-fit'].question, /local chunk/);
  assert.doesNotMatch(plan.chunk_requests[0].asking['section-heading-fit'].question, /whole-section criterion/i);
  assert.equal(JSON.parse(plan.chunk_requests[0].content).section_chunk.text, 'First body.');
  assert.equal(JSON.parse(plan.chunk_requests[0].content).section_chunk.source_blake3, input.document_blake3);
  assert.equal(Object.hasOwn(plan.chunk_requests[0].asking['section-heading-fit'], 'gold'), false);
  validateInput(input, {mode:'unlabeled'});

  for (const mutate of [
    copy => { copy.items[0].section_chunk_manifest.chunks[1].block_indices = [1]; },
    copy => { copy.items[0].section_chunk_manifest.chunks.reverse(); },
    copy => { copy.items[0].section_chunk_manifest.source_blake3 = 'b'.repeat(64); },
    copy => { copy.items[1].text = 'stale source text'; },
    copy => { copy.items[0].section_chunk_manifest.chunks[0].text = 'partial preview'; },
    copy => { copy.items[2].source_block_index = 7; },
  ]) {
    const bad = deepCopy(input); mutate(bad);
    assert.throws(() => validateInput(bad, {mode:'unlabeled'}), /section|source|chunk/i);
  }
  const alteredPolicy = deepCopy(input); alteredPolicy.criteria[0].section_chunk_request.question += ' changed';
  assert.notDeepEqual(requestPlan(alteredPolicy, alteredPolicy.items[0]), plan);
});

test('section chunk aggregation fails later contradictions and abstains on incomplete or weak chunks', () => {
  const confidentPass = {predicted:'pass',decision:'pass'};
  assert.equal(aggregateSectionChunkResults([confidentPass, confidentPass], 2), 'pass');
  assert.equal(aggregateSectionChunkResults([confidentPass, {predicted:'fail',decision:'fail'}], 2), 'fail');
  assert.equal(aggregateSectionChunkResults([confidentPass, {predicted:'pass',decision:'uncertain'}], 2), 'uncertain');
  assert.equal(aggregateSectionChunkResults([confidentPass], 2), 'uncertain');
  assert.equal(aggregateSectionChunkResults([confidentPass, confidentPass, {predicted:'fail',decision:'uncertain'}], 2), 'uncertain');
});

test('decision confidence comes from the selected option and still gates explicit uncertainty', () => {
  assert.equal(expectedDecision('pass', {pass:0.25, fail:0.65, uncertain:0.1}), 'uncertain');
  assert.equal(expectedDecision('fail', {pass:0.65, fail:0.25, uncertain:0.1}), 'uncertain');
  assert.equal(expectedDecision('pass', {pass:0.65, fail:0.25, uncertain:0.1}), 'pass');
  assert.equal(expectedDecision('fail', {pass:0.25, fail:0.65, uncertain:0.1}), 'fail');
  assert.equal(expectedDecision('uncertain', {pass:0.1, fail:0.1, uncertain:0.8}), 'uncertain');
  assert.equal(expectedDecision('uncertain', {pass:0.65, fail:0.25, uncertain:0.1}), 'uncertain');
});

test('legacy partial results are refused because their prior prompt policy is unknown', () => {
  const partial = deepCopy(baselineResult);
  partial.items.pop();
  partial.evaluated_items--;
  partial.complete = false;
  assert.throws(() => validateReport(partial, baselineExpected()), /legacy requests are unproved/);
});

test('challenge input rejects duplicate expected IDs and family split leakage', () => {
  const duplicate = deepCopy(baselineData);
  duplicate.items.push(deepCopy(duplicate.items[0]));
  assert.throws(() => validateInput(duplicate), /duplicate challenge item id/);
  const splitLeak = deepCopy(baselineData);
  const family = splitLeak.items.find(item => splitLeak.items.filter(other => other.family === item.family).length > 1).family;
  const sibling = splitLeak.items.find(item => item.family === family);
  const second = splitLeak.items.find(item => item.family === family && item.id !== sibling.id);
  const originalSplit = sibling.split;
  second.split = originalSplit === 'eval' ? 'validation' : 'eval';
  assert.throws(() => validateInput(splitLeak), /split leakage/);
});

test('baseline labels and diagnostic thresholds must be well formed', () => {
  const invalidGold = deepCopy(baselineData);
  invalidGold.items.find(item => item.split === 'eval').gold = 'maybe';
  assert.throws(() => validateInput(invalidGold), /invalid overall gold label/);
  const invalidThreshold = JSON.parse(readFileSync(join(book, 'criteria-challenge.json'), 'utf8'));
  invalidThreshold.criteria[0].diagnostic_min_probability = 1.5;
  assert.throws(() => validateInput(invalidThreshold), /invalid diagnostic minimum/);
});

test('resume rejects changed identity, duplicate rows, changed gold scope, and invalid decisions', () => {
  const cases = [
    report => { report.model = 'other-model'; },
    report => { report.endpoint = 'http://127.0.0.1:1/v1/systemone'; },
    report => { report.serving = 'other-serving'; },
    report => { report.rubric_blake3 = 'changed-rubric'; },
    report => { report.data_blake3 = 'changed-data'; },
    report => { report.items.push(deepCopy(report.items[0])); report.evaluated_items++; },
    report => { report.items[0].gold = report.items[0].gold === 'pass' ? 'fail' : 'pass'; },
    report => { report.items[0].origin.source_ref.lines = 'changed'; },
    report => { report.items[0].decision = 'fail'; },
    report => { report.complete = false; },
    report => { report.errors.push({id:'unknown', error:'lost row'}); },
  ];
  for (const mutate of cases) {
    const tampered = deepCopy(baselineResult);
    mutate(tampered);
    assert.throws(() => validateReport(tampered, baselineExpected(), {requireServing:true}));
  }
});

test('changed challenge text, context, criterion, or label scope cannot reuse prior results', () => {
  for (const change of [
    input => { input.items[0].text += ' changed'; },
    input => { input.items[0].context += ' changed'; },
    input => { input.question += ' changed'; },
    input => { input.items[0].gold = 'fail'; },
  ]) {
    const changed = deepCopy(baselineData);
    change(changed);
    const serialized = JSON.stringify(changed, null, 2) + '\n';
    const dir = mkdtempSync(join(tmpdir(), 'book-decider-data-'));
    try {
      const path = join(dir, 'challenge.json');
      writeFileSync(path, serialized);
      const expected = baselineExpected(changed, b3file(path));
      expected.dataPath = baselineResult.data;
      assert.throws(() => validateReport(baselineResult, expected));
    } finally { rmSync(dir, {recursive:true, force:true}); }
  }
});

test('coverage counts each expected row once and keeps failed rows explicit', () => {
  const partial = deepCopy(baselineResult);
  const missing = partial.items.pop();
  partial.evaluated_items--;
  partial.complete = false;
  assert.throws(() => validateReport(partial, baselineExpected()), /request policy/);
  const legacyShapeOnly = {...baselineExpected(), requestPolicy:null};
  const state = validateReport(partial, legacyShapeOnly);
  assert.equal(state.coveredIds.size, ITEMS - 1);
  assert.equal(state.coveredIds.has(missing.id), false);

  partial.errors.push({id:missing.id, error:'captured request failed'});
  partial.complete = true;
  assert.equal(validateReport(partial, legacyShapeOnly).coveredIds.size, ITEMS);
  partial.errors.push({id:missing.id, error:'duplicate'});
  assert.throws(() => validateReport(partial, legacyShapeOnly), /duplicate|overlapping/);
});

test('new request evidence binds neutral adapter input, exact wire body, response, and probabilities', () => {
  const sourceData = JSON.parse(readFileSync(join(book, 'criteria-challenge.json'), 'utf8'));
  const input = {...sourceData, items:[sourceData.items[0]]};
  const {evalItems, criteria} = validateInput(input);
  const item = evalItems[0];
  const plan = requestPlan(input, item, criteria);
  assert.equal(plan.content, `Passage: ${item.text}`);
  assert.equal(plan.content.includes(item.context), false);
  assert.doesNotMatch(plan.content, /much better/);
  assert.match(plan.asking['source-fidelity'].question, /Criterion-specific source context/);
  assert.doesNotMatch(plan.asking['voice-flow'].question, /Criterion-specific source context/);
  const asking = plan.asking;
  const options = Object.fromEntries(Object.entries(asking).map(([id, request]) => [id,
    {type:'choice', instructions:request.question, criteria:Object.fromEntries(request.shape.options.map(option => [option, null]))}]));
  const answers = Object.fromEntries(Object.keys(asking).map(id => [id, {choice:'uncertain', confidence:0.6,
    probabilities:{pass:0.2, fail:0.2, uncertain:0.6}}]));
  const rawResponse = JSON.stringify({model:'decider-v10', served_identity:'/fixture/model-snapshot', answers, usage:{input_tokens:999, output_tokens:0}});
  const wire = intoBatchRequest({content:plan.content, asking});
  wire.model = 'decider-v10';
  const requestEvidence = {adapter_input:plan, exchanges:[{
    url:'http://127.0.0.1:8099/v1/systemone', status:200, statusText:'OK', request:JSON.stringify(wire), response:rawResponse,
  }]};
  const checks = {};
  for (const criterion of criteria) {
    if (criterion.deterministic) {
      const prediction = item.role !== 'authored' ? 'uncertain' : item.text.includes('—') ? 'fail' : 'pass';
      checks[criterion.id] = {gold:item.checks[criterion.id], predicted:prediction, decision:prediction,
        confidence:null, probabilities:null, method:'deterministic local scan', criterion_context_used:Boolean(item.check_context?.[criterion.id]), elapsed_ms:0};
    } else {
      checks[criterion.id] = {gold:item.checks[criterion.id], predicted:'uncertain', raw_answer:'uncertain', decision:'uncertain', confidence:0.6,
        primitive:'choice', diagnostic_min_probability:0.5, probabilities:{pass:0.2,fail:0.2,uncertain:0.6},
        method:'Decider2B shared endpoint', criterion_context_used:Boolean(item.check_context?.[criterion.id]), elapsed_ms:1};
    }
  }
  const row = {id:item.id, family:item.family, axes:item.axis, origin:item.origin, gold_checks:item.checks, checks, request_evidence:requestEvidence,
    serving_identity_policy:SERVING_IDENTITY_POLICY};
  const route = 'http://127.0.0.1:8099/v1/systemone';
  const serving = '/fixture/model-snapshot';
  const expected = {input, model:'decider-v10', endpoint:route, dataPath:'/fixture/challenge.json', dataBlake3:'fixture-data',
    rubricBlake3:'fixture-rubric', serving, requestEvidenceVersion:1, requestPolicy:REQUEST_POLICY};
  const report = {schema:'book-voice-decider-evaluation-v2', model:expected.model, endpoint:route, data:expected.dataPath,
    route:'shared local classifier adapter -> /v1/systemone', data_blake3:expected.dataBlake3, rubric_blake3:expected.rubricBlake3, dataset_role:input.dataset_role,
    split:'eval', expected_items:1, evaluated_items:1, complete:true, question:null, criteria:reportCriteria(criteria),
    serving, errors:[], items:[row], request_evidence_version:1, request_policy:REQUEST_POLICY,
    serving_identity_policy:SERVING_IDENTITY_POLICY};
  expected.servingIdentityPolicy = SERVING_IDENTITY_POLICY;
  assert.equal(validateReport(report, expected, {requireServing:true}).complete, true);
  for (const servedIdentity of ['different-process', null]) {
    const tampered = deepCopy(report);
    const body = JSON.parse(tampered.items[0].request_evidence.exchanges[0].response);
    if (servedIdentity === null) delete body.served_identity;
    else body.served_identity = servedIdentity;
    tampered.items[0].request_evidence.exchanges[0].response = JSON.stringify(body);
    assert.throws(() => validateReport(tampered, expected, {requireServing:true}), /response serving identity/);
  }

  const badWire = deepCopy(report);
  badWire.items[0].request_evidence.exchanges[0].request = JSON.stringify({...wire, state:'tampered'});
  assert.throws(() => validateReport(badWire, expected), /request payload changed/);
  const badDecision = deepCopy(report);
  badDecision.items[0].checks['voice-flow'].predicted = 'pass';
  assert.throws(() => validateReport(badDecision, expected), /raw response|decision/);
  const missingCriterion = deepCopy(report);
  delete missingCriterion.items[0].checks['execution-gear'];
  assert.throws(() => validateReport(missingCriterion, expected), /missing or extra criterion/);
  assert.equal(Object.keys(options).length, 4);
});

const typedInput = () => ({
  schema:'book-voice-decider-challenge-v3',
  criteria:[
    {id:'voice',question:'Does the target meet the stated voice standard?',options:['pass','fail','uncertain'],
      reference_context:'Apply the same author-owned voice reference to every target.',applies_to:['paragraph','mixed']},
    {id:'heading',question:'Does the heading introduce its subject clearly?',options:['pass','fail','uncertain'],
      reference_context:'Headings identify the actual subject plainly.',applies_to:['heading','mixed']},
    {id:'flow',question:'Does the transition connect to the surrounding material?',options:['pass','fail','uncertain'],
      reference_context:'Keep transitions connected to the preceding thought.',applies_to:['paragraph']},
  ],
  items:[
    {id:'p1',family:'p1',split:'eval',text:'A paragraph target.',block_kind:'paragraph',reader_context:'Previous paragraph.',
      origin:{kind:'fixture'},role:'authored',checks:{voice:'fail'}},
    {id:'h1',family:'h1',split:'eval',text:'## A title',block_kind:'heading',origin:{kind:'fixture'},role:'authored'},
    {id:'m1',family:'m1',split:'eval',text:'## A title\nThis continues as prose.',block_kind:'mixed',origin:{kind:'fixture'},role:'authored'},
  ],
});

function typedReport(input) {
  const model='fixture-classifier', endpoint='http://127.0.0.1:8099/v1/systemone', serving='/fixture/model-snapshot';
  const items=input.items;
  const rows=items.map(item=>{
    const plan=requestPlan(input,item);
    const asking=plan.asking;
    const answers=Object.fromEntries(Object.keys(asking).map(id=>[id,{type:'choice',choice:'uncertain',confidence:0.6,certainty:0.2,
      probabilities:{pass:0.2,fail:0.2,uncertain:0.6}}]));
    const wire=intoBatchRequest({content:plan.content,asking}); wire.model=model;
    const checks=Object.fromEntries(Object.entries(asking).map(([id,request])=>[id,{
      gold:item.checks?.[id] ?? null,predicted:'uncertain',raw_answer:'uncertain',decision:'uncertain',confidence:0.6,
      primitive:'choice',diagnostic_min_probability:0.5,probabilities:{pass:0.2,fail:0.2,uncertain:0.6},
      method:'Decider2B shared endpoint',criterion_context_used:Boolean(input.criteria.find(c=>c.id===id).reference_context),elapsed_ms:1,
    }]));
    const evidence={adapter_input:plan,exchanges:[]};
    if(Object.keys(asking).length)evidence.exchanges.push({url:endpoint,status:200,statusText:'OK',request:JSON.stringify(wire),
      response:JSON.stringify({model,served_identity:serving,answers,usage:{input_tokens:2,output_tokens:0}})});
    return {id:item.id,family:item.family,axes:item.axis,origin:item.origin,block_kind:item.block_kind,gold_checks:item.checks ?? {},checks,
      request_evidence:evidence,serving_identity_policy:SERVING_IDENTITY_POLICY};
  });
  return {schema:'book-voice-decider-evaluation-v2',model,endpoint,data:'/fixture/data.json',route:'shared local classifier adapter -> /v1/systemone',
    data_blake3:'fixture-data',rubric_blake3:null,dataset_role:null,source_derivative:null,assembled_docx:null,split:'eval',expected_items:items.length,
    evaluated_items:items.length,complete:true,question:null,criteria:reportCriteria(input.criteria),serving,errors:[],items:rows,
    request_evidence_version:1,request_policy:TYPED_REQUEST_POLICY,serving_identity_policy:SERVING_IDENTITY_POLICY};
}

test('v3 types source blocks, pins shared references, and requests every applicable check', () => {
  assert.equal(classifyWritingBlock('## Name an idea'), 'heading');
  assert.equal(classifyWritingBlock('| A | B |\n| --- | --- |\n| x | y |'), 'table');
  assert.equal(classifyWritingBlock('- one\n- two'), 'list');
  assert.equal(classifyWritingBlock('> one\n> two'), 'quote');
  assert.equal(classifyWritingBlock('## Heading\nProse continues.'), 'mixed');

  const input=typedInput();
  validateInput(input);
  const plan=requestPlan(input,input.items[0]);
  assert.deepEqual(Object.keys(plan.asking).sort(), ['flow','voice']);
  const state=JSON.parse(plan.content);
  assert.deepEqual(Object.keys(state).sort(), ['reader_context','reference_text','target_kind','target_text']);
  assert.deepEqual(state.reference_text, {
    voice:'Apply the same author-owned voice reference to every target.',
    flow:'Keep transitions connected to the preceding thought.',
  });
  assert.equal(state.reader_context,'Previous paragraph.');
  assert.equal(state.target_kind,'paragraph');
  assert.equal(state.target_text,'A paragraph target.');
  assert.match(plan.asking.voice.question,/reference_text\.voice/);
  assert.match(plan.asking.flow.question,/reference_text\.flow/);
  assert.deepEqual(Object.keys(requestPlan(input,input.items[1]).asking), ['heading']);
  const headingPlan=requestPlan(input,input.items[1]);
  assert.equal(JSON.parse(headingPlan.content).reference_text,'Headings identify the actual subject plainly.');
  assert.equal(headingPlan.asking.heading.question,'Does the heading introduce its subject clearly? Use reference_text.');
  assert.deepEqual(Object.keys(requestPlan(input,input.items[2]).asking).sort(), ['heading','voice']);

  const report=typedReport(input);
  const expected={input,model:report.model,endpoint:report.endpoint,dataPath:report.data,dataBlake3:report.data_blake3,
    rubricBlake3:null,serving:report.serving,requestPolicy:TYPED_REQUEST_POLICY,requestEvidenceVersion:1,
    servingIdentityPolicy:SERVING_IDENTITY_POLICY};
  assert.equal(validateReport(report,expected,{requireServing:true}).complete,true);

  const badOverride=deepCopy(input); badOverride.items[0].check_context={voice:'row-specific override'};
  assert.throws(()=>validateInput(badOverride),/per-item criterion context/);
  const badReference=deepCopy(input); badReference.criteria[0].reference_context+=' changed';
  assert.throws(()=>validateReport(report,{...expected,input:badReference}),/criteria changed/);
  const badKind=deepCopy(report); badKind.items[0].block_kind='heading';
  assert.throws(()=>validateReport(badKind,expected),/block kind changed/);
  const badReaderContext=deepCopy(report); badReaderContext.items[0].request_evidence.adapter_input.content=JSON.stringify({
    ...JSON.parse(badReaderContext.items[0].request_evidence.adapter_input.content),reader_context:'different prior text',
  });
  assert.throws(()=>validateReport(badReaderContext,expected),/changed request state/);
  const badReferenceEvidence=deepCopy(report); badReferenceEvidence.items[0].request_evidence.adapter_input.content=JSON.stringify({
    ...JSON.parse(badReferenceEvidence.items[0].request_evidence.adapter_input.content),reference_text:{voice:'tampered'},
  });
  assert.throws(()=>validateReport(badReferenceEvidence,expected),/changed request state/);
  const malformedKind=deepCopy(input); malformedKind.items[0].block_kind='unknown';
  assert.throws(()=>validateInput(malformedKind),/invalid block kind/);
  const falseHeading=deepCopy(input); falseHeading.items[0].block_kind='heading';
  assert.throws(()=>validateInput(falseHeading),/does not match target structure/);
  const scopedGold=deepCopy(input); scopedGold.items[1].checks={voice:'fail'};
  assert.throws(()=>validateInput(scopedGold),/invalid gold checks/);
  const noCoverage=deepCopy(input); noCoverage.items[0].checks={}; noCoverage.criteria.forEach(c=>{c.applies_to=['heading'];});
  assert.throws(()=>validateInput(noCoverage),/no criterion applies/);
});

test('new overall evidence binds raw answer, response model, and requires an exchange', () => {
  const input = {...deepCopy(baselineData), items:[deepCopy(baselineData.items.find(item => item.split === 'eval'))]};
  const item = input.items[0];
  const plan = requestPlan(input, item);
  const wire = intoBatchRequest(plan);
  wire.model = baselineResult.model;
  const rawBody = {model:baselineResult.model, served_identity:'/fixture/model-snapshot', answers:{verdict:{choice:'pass', confidence:0.8, probabilities:{pass:0.8,fail:0.1,uncertain:0.1}}}};
  const evidence = {adapter_input:plan, exchanges:[{url:'http://127.0.0.1:8099/v1/systemone', status:200,
    request:JSON.stringify(wire), response:JSON.stringify(rawBody)}]};
  const expected = {...baselineExpected(input), dataPath:'/fixture/baseline.json', dataBlake3:'fixture-data', serving:'/fixture/model-snapshot',
    requestPolicy:REQUEST_POLICY, requestEvidenceVersion:1, servingIdentityPolicy:SERVING_IDENTITY_POLICY};
  const row = {id:item.id, family:item.family, axis:item.axis, origin:item.origin, gold:item.gold,
    predicted:'pass', decision:'pass', confidence:0.8, probabilities:{pass:0.8,fail:0.1,uncertain:0.1}, elapsed_ms:1, request_evidence:evidence,
    serving_identity_policy:SERVING_IDENTITY_POLICY};
  const report = {...deepCopy(baselineResult), data:expected.dataPath, data_blake3:expected.dataBlake3, serving:expected.serving,
    expected_items:1, evaluated_items:1, complete:true, items:[row], errors:[], request_policy:REQUEST_POLICY, request_evidence_version:1,
    serving_identity_policy:SERVING_IDENTITY_POLICY};
  assert.equal(validateReport(report, expected, {requireServing:true}).complete, true);
  for (const mutate of [
    copy => { copy.items[0].request_evidence.exchanges[0].response = JSON.stringify({...rawBody, answers:{verdict:{...rawBody.answers.verdict, choice:'fail'}}}); },
    copy => { copy.items[0].request_evidence.exchanges[0].response = JSON.stringify({...rawBody, model:'other-model'}); },
    copy => { copy.items[0].request_evidence.exchanges[0].response = JSON.stringify({...rawBody, served_identity:'other-serving'}); },
    copy => { const body={...rawBody}; delete body.served_identity; copy.items[0].request_evidence.exchanges[0].response=JSON.stringify(body); },
    copy => { copy.items[0].request_evidence.exchanges = []; },
    copy => { delete copy.serving_identity_policy; delete copy.items[0].serving_identity_policy; },
    copy => { copy.serving_identity_assurance = 'historical-unverified'; },
    copy => { copy.items[0].request_evidence.exchanges[0].response = JSON.stringify({...rawBody, answers:{verdict:{...rawBody.answers.verdict, probabilities:{pass:2,fail:0,uncertain:0}}}}); },
  ]) {
    const tampered = deepCopy(report);
    mutate(tampered);
    assert.throws(() => validateReport(tampered, expected, {requireServing:true}));
  }
  // A complete v0 record remains readable as history; a new marker cannot
  // manufacture response attribution when no raw response was captured.
  const legacy = deepCopy(report);
  delete legacy.request_policy; delete legacy.request_evidence_version;
  delete legacy.serving_identity_policy; delete legacy.items[0].serving_identity_policy;
  delete legacy.items[0].request_evidence;
  const legacyExpected = {...expected, requestPolicy:REQUEST_POLICY, requestEvidenceVersion:0, servingIdentityPolicy:null};
  assert.equal(validateReport(legacy, legacyExpected, {requireServing:true}).identity_assurance,'historical-unverified');
  legacy.serving_identity_policy = SERVING_IDENTITY_POLICY;
  legacy.items[0].serving_identity_policy = SERVING_IDENTITY_POLICY;
  assert.throws(() => validateReport(legacy,{...legacyExpected,servingIdentityPolicy:SERVING_IDENTITY_POLICY},{requireServing:true}),/no successful captured response|requires captured request evidence/);
  const nullIdentity = deepCopy(report); nullIdentity.serving = null;
  assert.throws(() => validateReport(nullIdentity,{...expected,serving:null},{requireServing:true}),/serving identity/);
});

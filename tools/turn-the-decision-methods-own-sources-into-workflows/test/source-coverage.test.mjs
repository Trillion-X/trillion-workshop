import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sourceCoverage, textIdentity, sweepAtoms } from '../read-data/source-coverage.mjs';
import { sweepAtoms as sharedSweep } from '../../check-against-a-persons-rules-and-verdicts/do-work/piece-sweep.mjs';
import { atomsOf } from '../../documents-as-list-rows/read-data/atoms.mjs';
import { recipeProblems, stepAnatomyProblems } from '../../workflows/read-data/recipe-problems.mjs';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';
import { rowOf, runRow } from '../../../test-helpers/run-a-row.mjs';
const source = { id: 'source:synthetic', text: 'Return the version.\nA story.', identity: textIdentity('Return the version.\nA story.') };
const piece = (id='piece:one',text='Return the version.') => ({id,source_id:source.id,source_identity:source.identity,text,identity:textIdentity(text),location:'synthetic.txt:1'});
const step = (p=piece()) => ({id:'step:one',when:'A version is required.',do:'Run node --version and submit stdout.',submit:{type:'object',properties:{stdout:{type:'string'}},required:['stdout']},done_when:'stdout contains the version.',good_answer:'Passes: stdout is v24.0.0. Fails: stdout is empty.',if_missing:'If node is absent, submit its command-not-found error.',why:'The executable readback identifies its current version.',came_from:[p.id],source_versions:{[p.id]:p.identity},part_of:['branch:synthetic'],position:0});
const fixture = () => ({sources:[structuredClone(source)],pieces:[piece()],steps:[step()]});
const kinds = report => report.gaps.map(gap => gap.kind);

test('current explicit source-linked step passes structural coverage without claiming semantic proof',()=>{
 const result=sourceCoverage(fixture());
 assert.equal(result.ok,true); assert.equal(result.with_step,1); assert.equal(result.sources[0].with_check,1);
 assert.equal(result.scope,'supplied_inventory'); assert.equal(result.inventory_completeness,'not_established');
 assert.equal(result.qualification,'structural'); assert.equal(result.semantic_verification,'not_established');
});
test('valid story reason is a first-class result; blank or stale reasons never count',()=>{
 const f=fixture(); f.steps=[]; f.pieces[0].no_check={reason:'A story with no instruction.',piece_identity:f.pieces[0].identity};
 assert.equal(sourceCoverage(f).with_reason,1); assert.equal(sourceCoverage(f).ok,true);
 for(const reason of [{reason:' '},{reason:'A story.',piece_identity:textIdentity('old')}]){
   f.pieces[0].no_check=reason; const r=sourceCoverage(f); assert.equal(r.ok,false); assert.equal(r.with_reason,0); assert.ok(kinds(r).includes('invalid_no_check'));
 }
});
test('reports exact uncovered piece, stale source and stale step pin',()=>{
 const f=fixture(); f.steps=[]; let r=sourceCoverage(f); assert.deepEqual(r.gaps.find(g=>g.kind==='uncovered'),{kind:'uncovered',source_id:source.id,piece_id:'piece:one',location:'synthetic.txt:1'});
 f.steps=[step()]; f.steps[0].source_versions['piece:one']=textIdentity('old'); assert.ok(kinds(sourceCoverage(f)).includes('stale_step_source'));
 f.steps=[step()]; f.pieces[0].source_identity=textIdentity('old'); r=sourceCoverage(f); assert.ok(kinds(r).includes('stale_piece_source')); assert.equal(r.with_step,0);
});
test('duplicate IDs, missing source, dangling piece and covered_by cannot be hidden by a good link',()=>{
 for(const mutate of [f=>f.pieces.push({...f.pieces[0]}),f=>f.pieces[0].source_id='missing',f=>f.steps[0].came_from.push('missing'),f=>f.pieces[0].no_check={reason:'Covered elsewhere',piece_identity:f.pieces[0].identity,covered_by:['missing']}]){
  const f=fixture(); mutate(f); assert.equal(sourceCoverage(f).ok,false);
 }
});
test('missing anatomy and modified exact bytes refuse coverage',()=>{
 for(const mutate of [f=>f.steps[0].do=' ',f=>f.steps[0].good_answer='Sounds good',f=>f.pieces[0].text+=' changed',f=>f.sources[0].text+=' changed']){
  const f=fixture(); mutate(f); assert.equal(sourceCoverage(f).ok,false);
 }
});
test('a mismatched source byte readback qualifies neither linked steps nor reasons',()=>{
 for(const withReason of [false,true]){
  const f=fixture();f.sources[0].text+=' changed';
  if(withReason){f.steps=[];f.pieces[0].no_check={reason:'A narrative.',piece_identity:f.pieces[0].identity};}
  const r=sourceCoverage(f);assert.equal(r.ok,false);assert.equal(r.with_step,0);assert.equal(r.with_reason,0);
  assert.ok(kinds(r).includes('invalid_source_reference'));
  assert.equal(r.sources[0].with_check,0);assert.equal(r.sources[0].with_reason,0);
 }
});
test('empty source inventory and sources without pieces never pass vacuously',()=>{
 assert.equal(sourceCoverage({sources:[],pieces:[],steps:[]}).ok,false);
 assert.ok(kinds(sourceCoverage({sources:[source],pieces:[],steps:[]})).includes('unexamined_source'));
});
test('many pieces can share a step, and a piece can link multiple steps',()=>{
 const f=fixture(); f.pieces.push(piece('piece:two','A story.')); f.steps[0].came_from.push('piece:two'); f.steps[0].source_versions['piece:two']=f.pieces[1].identity;
 f.steps.push({...step(),id:'step:two',position:1}); const r=sourceCoverage(f); assert.equal(r.ok,true); assert.equal(r.with_step,2); assert.equal(r.sources[0].pieces[0].step_ids.length,2);
});
test('cross-step machine checks use the matching branch prior submit schema',()=>{
 const f=fixture(); const second={...step(),id:'step:two',position:1,good_answer:undefined,checks:[{kind:'mentioned-in',path:['this','stdout'],in:['steps','step:one','stdout'],says:'The later stdout occurs in the earlier output.'}]};
 // Use the actual vocabulary shape; includes an earlier path and checks both schemas.
 second.checks=[{kind:'subset-of',path:['this','stdout'],of:['steps','step:one','stdout'],says:'Only earlier output is repeated.'}];
 f.steps.push(second); assert.deepEqual(sourceCoverage(f).gaps,[]);
 second.position=-1; assert.equal(sourceCoverage(f).ok,false);
});
test('existing atoms retain normalized provenance separately from exact coverage text identity',()=>{
 const atom=atomsOf('# Example\n\nKeep  exact words.')[0];
 assert.notEqual(atom.identity,textIdentity(atom.text));
 const f=fixture(); f.pieces=[{...piece('piece:atom',atom.text),upstream_identity:atom.identity}]; f.steps=[step(f.pieces[0])]; assert.equal(sourceCoverage(f).ok,true); assert.equal(f.pieces[0].upstream_identity,atom.identity);
});
test('coverage reuses the existing public sweep function without a second implementation',()=>{
 assert.equal(sweepAtoms,sharedSweep);
 const r=sweepAtoms({one:{identity:'pin'}},[{key:'one',identity:'pin'}],[{id:'check',source:{section:'one'}}],[{id:'check'}]); assert.equal(r.with_check,1); assert.deepEqual(r.uncovered,[]);
});
test('CLI returns JSON and nonzero for gaps and malformed input',()=>{
 const cli=new URL('../do-work/measure-source-coverage.mjs',import.meta.url);
 for(const input of [JSON.stringify({...fixture(),steps:[]}),'not json']){const r=spawnSync(process.execPath,[cli.pathname],{input,encoding:'utf8'});assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).ok,false);}
 const r=spawnSync(process.execPath,[cli.pathname],{input:JSON.stringify(fixture()),encoding:'utf8'});assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).with_step,1);
});
test('descriptor runs with its declared packaged dependencies only',async()=>{
 const file=JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json',import.meta.url),'utf8'));
 const row=rowOf(file,'tool:measure-source-coverage');
 const result=await runRow(row,fixture());
 assert.equal(result.cannot,undefined);assert.equal(result.code,0,JSON.stringify(result));
 assert.equal(result.last.ok,true);assert.equal(result.last.with_step,1);
});
test('canonical recipe anatomy and an actual run on the workflow engine, independent of semantic execution',async()=>{
 const recipe=JSON.parse(readFileSync(new URL('../../workflows/recipes/turn-a-source-into-steps.json',import.meta.url))).records[0].payload;
 assert.deepEqual(recipeProblems(recipe),[]);
 for(const step of recipe.steps) assert.deepEqual(stepAnatomyProblems(step),[]);
 const run=await runWorkflow({row:recipe.id,reader:{tool_id:'tool:synthetic-reader',input:{source:'synthetic'}}});
 assert.equal(run.status,'paused'); assert.equal(run.waiting[0].step_id,recipe.steps[0].id);
 assert.deepEqual(run.definition.steps.filter(step=>step.kind==='ask').map(step=>step.id),recipe.steps.map(step=>step.id));
 assert.equal(run.execution_context.start.input.reader.tool_id,'tool:synthetic-reader');
});

test('one persisted id cannot name both a piece and a derived step or source',()=>{
 for(const other of ['steps','sources']){
  const f=fixture();f[other][0].id=f.pieces[0].id;
  if(other==='steps')f.pieces[0].no_check={reason:'Covered by this step.',piece_identity:f.pieces[0].identity,covered_by:[f.steps[0].id]};
  const result=sourceCoverage(f);
  assert.equal(result.ok,false);assert.equal(result.with_step,0);assert.equal(result.with_reason,0);
  assert.ok(kinds(result).includes('colliding_record_id'));
 }
});

test('malformed submit contracts cannot qualify a source piece',()=>{
 const f=fixture();f.steps[0].submit={type:'object',required:'not-an-array',properties:{stdout:17}};
 assert.equal(sourceCoverage(f).ok,false);assert.equal(sourceCoverage(f).with_step,0);
});

test('one bad provenance reference disqualifies the entire step and its reason references',()=>{
 for(const bad of ['missing','stale','invalid-piece']){
  const f=fixture();
  if(bad==='missing') f.steps[0].came_from.push('piece:missing');
  else {
   const other=piece('piece:two','Other exact text.');f.pieces.push(other);f.steps[0].came_from.push(other.id);f.steps[0].source_versions[other.id]=bad==='stale'?textIdentity('old'):other.identity;
   if(bad==='invalid-piece')other.source_identity=textIdentity('old source');
  }
  const narrative=piece('piece:narrative','An unrelated story.');narrative.no_check={reason:'Covered by the derived step.',piece_identity:narrative.identity,covered_by:['step:one']};f.pieces.push(narrative);
  const r=sourceCoverage(f);assert.equal(r.ok,false);assert.equal(r.with_step,0);assert.equal(r.with_reason,0);assert.ok(r.gaps.some(g=>g.kind==='invalid_no_check'));
 }
});

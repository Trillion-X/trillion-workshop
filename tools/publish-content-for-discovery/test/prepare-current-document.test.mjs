import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareCurrentDocument} from '../do-work/prepare-current-document.mjs';

const doc='package::documents::documents::draft';
const ref=address=>({address,mode:'identity_text'});
const hash=`1f:${'a'.repeat(64)}`;
function environment({verdict={accepted:true},changePolicy=false,excerpt}={}) {
  const data = new Map([
    ['package::public-document-site::publication-config::default',{kind:'public-document-publication-config',composition_ref:ref('composition'),destination_ref:ref('destination'),policy_ref:ref('policy'),source_documents:[{citation_ref:'lesson:one',...(excerpt!==undefined?{preview_excerpt:excerpt}:{}),document_ref:ref('package::documents::documents::source')}]}],
    ['composition',{kind:'public-document-composition',route_prefix:'/article',layout:'article',brand_label:'School',navigation:[],related_cards:[]}],
    ['destination',{kind:'public-sales-page-destination',record_set_address:'pages',route_prefix:'/article',record_kind:'public-sales-page',id_prefix:'article:'}],
    ['policy',{gate_policy:{required_verdicts:['factual','writing'].map(id=>({id,role:id,target:'ask-a-small-model-for-a-verdict.judge-content',rubric:{id}}))}}],
    [doc,{children:[{kind:'Text',props:{text:'Contact point',custom:{heading_level:1}}},{kind:'Text',props:{text:'Match contact to the grip.',custom:{source_refs:['lesson:one']}}}]}],
    ['package::documents::documents::source',{children:[{kind:'Text',props:{text:'Match contact to the grip.'}}]}],
  ]);
  let reviews=0;
  const calls=[];
  return {calls,send:async({target,payload})=>{
    calls.push({target,payload});
    if(target==='ask-a-small-model-for-a-verdict.judge-content'){reviews++;return verdict;}
    assert.equal(target,'engine.operation.label-addressed');
    const value=data.get(payload.address_label);
    return {found:Boolean(value),payload:value,content_hash:changePolicy&&reviews&&payload.address_label==='policy'?`1f:${'b'.repeat(64)}`:hash};
  }};
}
test('real sender contract reads current policy and source before reviews and leaves publication closed',async()=>{
  const env=environment();
  const result=await prepareCurrentDocument({document_ref:doc},{runtime:{}},env);
  assert.equal(result.state,'render-review-required');
  assert.equal(result.publication.write_allowed,false);
  assert.equal(result.verdicts.length,2);
  assert.equal(result.input_bases.length,6);
  assert.equal(env.calls.filter(c=>c.target==='ask-a-small-model-for-a-verdict.judge-content').length,2);
});
test('missing, null, rejected, and open-finding reviews cannot prepare an accepted candidate',async()=>{
  for(const verdict of [undefined,null,{}, {accepted:false},{accepted:true,findings:[{resolved:false}]},{accepted:true,findings:null},{accepted:true,findings:{}}]){
    const env=environment({verdict:verdict??null});
    await assert.rejects(()=>prepareCurrentDocument({document_ref:doc},null,env),/Required review did not accept/);
  }
});
test('changed current policy invalidates the reviewed candidate',async()=>{
  await assert.rejects(()=>prepareCurrentDocument({document_ref:doc},null,environment({changePolicy:true})),/input changed during review: policy/);
});
test('caller verdicts and arbitrary policy are rejected before any owner read',async()=>{
  const env=environment();
  await assert.rejects(()=>prepareCurrentDocument({document_ref:doc,accepted:true},null,env),/Only a canonical/);
  assert.equal(env.calls.length,0);
});

test('preview excerpts must be verbatim while review retains the full source',async()=>{
  const env=environment({excerpt:'contact to the grip.'});
  const result=await prepareCurrentDocument({document_ref:doc},null,env);
  assert.equal(result.page.blocks[0].parts[1].source_preview.excerpt,'contact to the grip.');
  const review=env.calls.find(c=>c.target==='ask-a-small-model-for-a-verdict.judge-content');
  assert.equal(JSON.parse(review.payload.content).supplied_grounding[0].text,'Match contact to the grip.');
  await assert.rejects(()=>prepareCurrentDocument({document_ref:doc},null,environment({excerpt:'Invented source claim.'})),/verbatim/);
});

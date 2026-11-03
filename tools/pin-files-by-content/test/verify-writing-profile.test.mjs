import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyWritingProfile,writingBlocks} from '../do-work/verify-writing-profile.mjs';
import {hashBuffers} from '../do-work/verify-source-spans.mjs';
const hash=b=>hashBuffers([Buffer.from(b)])[0];
const text='# A heading\n\nYou exist: here and now.\nA connected second line.\n\nAn ordinary explanation.\n';
const profile=()=>({schema:'writing-profile-v1',document_role:'current_prose',rejections:[{id:'private-rejection-id',text:'Known rejected phrase',authority:'author_confirmed'}],protected_literals:['You exist: here and now.'],superseded_terms:[],required_components:[]});
const reviews=t=>({schema:'writing-review-v1',document_blake3:hash(t),blocks:writingBlocks(t).map((b,i)=>({block_index:i,block_blake3:hash(b.text),reviewer_role:'model',reviewer:'test model',reason:'Specific fixture review assertion.',decision:'retain'})),components:[]});
test('paragraph parsing preserves multi-line prose and UTF8 byte positions',()=>{
 const b=writingBlocks('Éxample\nsecond line\n\nNext.');assert.equal(b.length,2);assert.equal(b[0].text,'Éxample\nsecond line');assert.equal(b[1].byte_start,Buffer.byteLength('Éxample\nsecond line\n\n'));
});
test('indented and CRLF prose cannot disappear from review coverage',()=>{
 const t='    Indented content.\r\n\r\n\tMore content.\r\n';const b=writingBlocks(t);assert.equal(b.length,2);assert.equal(b[0].text,'Indented content.');assert.equal(b[1].text,'More content.');const p=profile();p.protected_literals=[];const r=reviews(t);r.blocks=[];const result=verifyWritingProfile(Buffer.from(t),p,r);assert.equal(result.status,'review_required');assert.equal(result.blocks,2);
});
test('BOM-prefixed prose still needs a review',()=>{
 const t='\ufeffOrdinary prose.';const p=profile();p.protected_literals=[];const r=reviews(t);r.blocks=[];const d=verifyWritingProfile(Buffer.from(t),p,r);assert.equal(d.blocks,1);assert.equal(d.status,'review_required');
});
test('known rejected wording fails with case punctuation and whitespace variants',()=>{
 const t=text+'\nＫＮＯＷＮ  rejected,\nPHRASE!';const d=verifyWritingProfile(Buffer.from(t),profile(),reviews(t));assert.equal(d.status,'known_failure');assert.ok(d.findings.some(x=>x.kind==='known_rejection'));
});
test('renderer-supported emphasis cannot split a rejected phrase or protected literal',()=>{
 const p=profile();p.rejections[0].text='Known rejected phrase';p.protected_literals=['You exist: here and now.'];
 const t=text+'\nKnown *rejected* phrase.';const d=verifyWritingProfile(Buffer.from(t),p,reviews(t));assert.equal(d.status,'known_failure');assert.ok(d.findings.some(x=>x.kind==='known_rejection'));
 const marked=text.replace('You exist: here and now.','You *exist*: here and now.');assert.ok(!verifyWritingProfile(Buffer.from(marked),p,reviews(marked)).findings.some(x=>x.kind==='protected_literal_changed_or_missing'));
});
test('a protected literal inside an HTML comment is not visible prose',()=>{
 const t='<!-- You exist: here and now. -->\n\nOrdinary prose.';const d=verifyWritingProfile(Buffer.from(t),profile(),reviews(t));assert.ok(d.findings.some(x=>x.kind==='protected_literal_changed_or_missing'));
});
test('substring inside a different word does not become a phrase rejection',()=>{
 const t=text+'\nUnknown rejected phrase.';assert.equal(verifyWritingProfile(Buffer.from(t),profile(),reviews(t)).status,'checks_satisfied');
});
test('heading-scoped rejection preserves ordinary prose and checks the whole heading',()=>{
 const p=profile();p.rejections[0].scope='heading';
 for(const suffix of ['\nKnown rejected phrase in an ordinary sentence.','\nThe words “Known rejected phrase” identify an earlier title.','\n### Why a known rejected phrase needs context\n','\n<!-- ### Known rejected phrase -->\n']){
  const t=text+suffix;assert.equal(verifyWritingProfile(Buffer.from(t),p,reviews(t)).status,'checks_satisfied');
 }
 for(const heading of ['# Known rejected phrase','   ### ＫＮＯＷＮ *rejected* phrase! ###','###### Known rejected phrase']){
  const t=text+'\n'+heading+'\n';assert.equal(verifyWritingProfile(Buffer.from(t),p,reviews(t)).status,'known_failure');
 }
 const t=text+'\nKnown rejected phrase in prose.';p.rejections[0].scope='document';assert.equal(verifyWritingProfile(Buffer.from(t),p,reviews(t)).status,'known_failure');
});
test('invalid rule scopes and multiline heading rejections fail closed',()=>{
 for(const scope of [null,'paragraph',42,{},['heading']]){
  const p=profile();p.rejections[0].scope=scope;assert.equal(verifyWritingProfile(Buffer.from(text),p,reviews(text)).status,'invalid');
 }
 const p=profile();p.rejections[0].scope='heading';p.rejections[0].text='Known rejected\nphrase';assert.equal(verifyWritingProfile(Buffer.from(text),p,reviews(text)).status,'invalid');
});
test('heading scope follows downstream bare-CR lines and comment-wrapped ATX lines',()=>{
 const p=profile();p.rejections[0].scope='heading';
 for(const suffix of ['\r### Known *rejected* phrase\rMore prose.','\n<!--\n### Known rejected phrase\n-->\n']){
  const t=text+suffix;assert.equal(verifyWritingProfile(Buffer.from(t),p,reviews(t)).status,'known_failure');
 }
});
test('actual CLI distinguishes a rejected heading from the same words in prose',()=>{
 const dir=mkdtempSync(join(tmpdir(),'writing-heading-cli-'));try{
  const tool=fileURLToPath(new URL('../do-work/verify-writing-profile.mjs',import.meta.url));
  for(const [name,suffix,status] of [['prose','\nKnown rejected phrase in ordinary prose.\n',0],['heading','\n### Known *rejected* phrase!\n',1],['bare-cr','\r### Known rejected phrase\rMore prose.',1],['comment-atx','\n<!--\n### Known rejected phrase\n-->\n',1]]){
   const t=text+suffix,p=profile();p.rejections[0].scope='heading';
   const doc=join(dir,name+'.md'),pr=join(dir,name+'-profile.json'),rev=join(dir,name+'-review.json'),out=join(dir,name+'-out.json');
   writeFileSync(doc,t);writeFileSync(pr,JSON.stringify(p));writeFileSync(rev,JSON.stringify(reviews(t)));
   const run=spawnSync(process.execPath,[tool,'--document',doc,'--profile',pr,'--reviews',rev,'--out',out]);assert.equal(run.status,status);
   const report=JSON.parse(readFileSync(out,'utf8'));assert.equal(report.status,status===0?'checks_satisfied':'known_failure');assert.equal(statSync(out).mode&0o777,0o600);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('soft hyphen and curly-quote differences cannot hide known rejection',()=>{
 const p=profile();p.rejections[0].text='a reader’s rejected phrase';const t=text+"\nA READER'S re\u00adjected phrase.";assert.equal(verifyWritingProfile(Buffer.from(t),p,reviews(t)).status,'known_failure');
});
test('legitimate you and colon are allowed and zero matches is never author approval',()=>{
 const d=verifyWritingProfile(Buffer.from(text),profile(),reviews(text));assert.equal(d.status,'checks_satisfied');assert.match(d.assurance,/not proof/);assert.match(d.assurance,/finished book/);assert.equal(d.author_approved,undefined);
});
test('caller-required sections must occur exactly once in their declared order',()=>{
 const p=profile();p.protected_literals=[];p.required_section_order=['## Opening','## Explanation','## Principles'];
 const correct='# Title\n\n## Opening\n\nContext.\n\n## Explanation\n\nConnected reasoning.\n\n## Principles\n\nDetails.\n';
 assert.equal(verifyWritingProfile(Buffer.from(correct),p,reviews(correct)).status,'checks_satisfied');
 for(const bad of [correct.replace('## Explanation\n\nConnected reasoning.\n\n',''),correct+'\n## Explanation\n',correct.replace('## Opening','## TEMP').replace('## Explanation','## Opening').replace('## TEMP','## Explanation'),correct.replace('## Explanation','### Explanation'),correct.replace('## Explanation','A paragraph naming ## Explanation')]){
  const result=verifyWritingProfile(Buffer.from(bad),p,reviews(bad));assert.equal(result.status,'known_failure');assert.ok(result.findings.some(x=>x.kind.startsWith('required_section_')));
 }
});
test('malformed section-order requirements are rejected without disclosing headings',()=>{
 for(const value of [null,{},['## Opening','## Opening'],['## Opening\n## Principles'],['No heading'],[42]]){
  const p=profile();p.required_section_order=value;const result=verifyWritingProfile(Buffer.from(text),p,reviews(text));assert.equal(result.status,'invalid');assert.equal(result.findings[0].kind,'invalid_required_section_order');
 }
 const p=profile();p.required_section_order=['## PRIVATE-SECTION'];const result=JSON.stringify(verifyWritingProfile(Buffer.from(text),p,reviews(text)));assert.ok(!result.includes('PRIVATE-SECTION'));
});
test('missing and empty current reviews require review rather than passing',()=>{
 assert.equal(verifyWritingProfile(Buffer.from(text),profile()).status,'review_required');const r=reviews(text);r.blocks=[];assert.equal(verifyWritingProfile(Buffer.from(text),profile(),r).current_block_reviews,0);
});
test('stale document and stale per-block hashes fail closed',()=>{
 const r=reviews(text);assert.equal(verifyWritingProfile(Buffer.from(text+' changed'),profile(),r).status,'invalid');r.blocks[1].block_blake3='0'.repeat(64);assert.equal(verifyWritingProfile(Buffer.from(text),profile(),r).status,'invalid');
});
test('duplicate block reviews and invented roles are invalid',()=>{
 const r=reviews(text);r.blocks.push(r.blocks[0]);assert.equal(verifyWritingProfile(Buffer.from(text),profile(),r).status,'invalid');const s=reviews(text);s.blocks[0].reviewer_role='automatically-author-approved';assert.equal(verifyWritingProfile(Buffer.from(text),profile(),s).status,'invalid');
});
test('protected literal changes fail even with all blocks approved by a model',()=>{
 const t=text.replace('You exist: here and now.','You might exist.');assert.ok(verifyWritingProfile(Buffer.from(t),profile(),reviews(t)).findings.some(x=>x.kind==='protected_literal_changed_or_missing'));
});
test('superseded name as current prose fails independently of generic rejection',()=>{
 const p=profile();p.superseded_terms=[{id:'old-term',text:'Earlier Named Method',authority:'author_confirmed'}];const t=text+'\nEarlier named method is a separate system.';assert.ok(verifyWritingProfile(Buffer.from(t),p,reviews(t)).findings.some(x=>x.kind==='superseded_current_term'));
});
test('empty or malformed profiles, duplicate rules and invalid UTF8 are invalid',()=>{
 const p=profile();p.rejections=[];assert.equal(verifyWritingProfile(Buffer.from(text),p).status,'invalid');const q=profile();q.rejections.push(q.rejections[0]);assert.equal(verifyWritingProfile(Buffer.from(text),q).status,'invalid');assert.equal(verifyWritingProfile(Buffer.from([0xff]),profile()).status,'invalid');assert.equal(verifyWritingProfile(Buffer.from(text),{...profile(),document_role:'comparison'}).status,'invalid');
});
test('uncovered named method component cannot be hidden by full prose review',()=>{
 const p=profile();p.required_components=['private-method-component'];const d=verifyWritingProfile(Buffer.from(text),p,reviews(text));assert.equal(d.status,'review_required');assert.equal(d.reviewed_source_components,0);
});
test('literal source/destination method evidence is required, with precise assurance limits',()=>{
 const dir=mkdtempSync(join(tmpdir(),'writing-component-'));try {
  const sp=join(dir,'source.txt'),dp=join(dir,'current.md'),st='Original method stage.';writeFileSync(sp,st);writeFileSync(dp,text);
  const p=profile();p.required_components=['c'];p.original_sources=[{blake3:hash(st),authority:'author_text'}];const r=reviews(text);r.source_bindings={schema:'synthetic-d245bc86d584',sources:[{id:'s',path:sp,blake3:hash(st)},{id:'d',path:dp,blake3:hash(text)}],quotes:[{id:'sq',source_id:'s',text:st,byte_start:0,byte_end:Buffer.byteLength(st)},{id:'dq',source_id:'d',text:'An ordinary explanation.',byte_start:Buffer.byteLength(text.slice(0,text.indexOf('An ordinary'))),byte_end:Buffer.byteLength(text.slice(0,text.indexOf('An ordinary')))+Buffer.byteLength('An ordinary explanation.')} ]};r.components=[{component_id:'c',source_quote_index:0,destination_quote_index:1,source_authority:'author_text',relationship_review:'Fixture claims correspondence; checker does not judge this.',reviewer_role:'root'}];
  const d=verifyWritingProfile(Buffer.from(text),p,r);assert.equal(d.status,'checks_satisfied');assert.match(d.component_assurance,/reviewer assertion/);
  r.source_bindings.quotes[0].text='Wrong excerpt';assert.equal(verifyWritingProfile(Buffer.from(text),p,r).status,'known_failure');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('explicit component disposition rejects partial or absent coverage while retaining reviewer limits',()=>{
 const dir=mkdtempSync(join(tmpdir(),'writing-component-disposition-'));try {
  const sp=join(dir,'source.txt'),dp=join(dir,'current.md'),st='Outcomes vary under specified conditions; choose a valued target band and test whether joint conditions shift the chance of landing inside it.';
  const partial='Two conditions can restrict each other, and use a range when evidence supports only that.';
  const direct='The target band is 80–90. Under the current setup, the predicted outcome distribution gives a 60% chance of landing inside it; changing the feed and rest conditions may shift that chance, so test the combined setup before claiming improved reliability.';
  const makeReview=(target,claim,disposition)=>{
   writeFileSync(dp,target);const r=reviews(target);const start=Buffer.byteLength(target.slice(0,target.indexOf(claim))),end=start+Buffer.byteLength(claim);
   r.source_bindings={schema:'synthetic-d245bc86d584',sources:[{id:'s',path:sp,blake3:hash(st)},{id:'d',path:dp,blake3:hash(target)}],quotes:[{id:'sq',source_id:'s',text:st,byte_start:0,byte_end:Buffer.byteLength(st)},{id:'dq',source_id:'d',text:claim,byte_start:start,byte_end:end}]};
   r.components=[{component_id:'outcome-distribution-operation',source_quote_index:0,destination_quote_index:1,source_authority:'author_text',relationship_review:'Scope assessment for this exact source mechanism and destination behavior.',reviewer_role:'root',coverage_disposition:disposition},{component_id:'existing-lineage-component',source_quote_index:0,destination_quote_index:1,source_authority:'author_text',relationship_review:'Existing freeform lineage review remains unchanged.',reviewer_role:'root'}];return r;
  };
  writeFileSync(sp,st);
  const p=profile();p.protected_literals=[];p.required_components=['existing-lineage-component','outcome-distribution-operation'];p.component_coverage_mode='explicit_disposition_v1';p.component_coverage_components=['outcome-distribution-operation'];p.component_requirements=[{id:'outcome-distribution-operation',source_mechanism:'Specified conditions can shape a distribution of possible outcomes relative to a valued target band.',destination_criterion:'Reader can distinguish the target band from predicted outcomes and describe how a tested condition may change the chance of landing inside it.'}];p.original_sources=[{blake3:hash(st),authority:'author_text'}];
  let r=makeReview(partial,partial,'partial');let d=verifyWritingProfile(Buffer.from(partial),p,r);assert.equal(d.status,'known_failure');assert.ok(d.findings.some(x=>x.kind==='required_source_component_not_represented'));assert.match(d.component_assurance,/does not establish semantic equivalence/);
  r=makeReview(direct,direct,'represented');d=verifyWritingProfile(Buffer.from(direct),p,r);assert.equal(d.status,'checks_satisfied');assert.match(d.component_assurance,/reviewer assertions/);
  assert.equal(d.explicitly_dispositioned_source_components,1);assert.equal(d.reviewed_source_components,2);
  r=makeReview(partial,partial,'not_represented');assert.equal(verifyWritingProfile(Buffer.from(partial),p,r).status,'known_failure');
  r=makeReview(partial,partial,'all-good');assert.equal(verifyWritingProfile(Buffer.from(partial),p,r).status,'invalid');
  r=makeReview(partial,partial,'partial');r.components[1].coverage_disposition='represented';assert.equal(verifyWritingProfile(Buffer.from(partial),p,r).status,'invalid');
  p.component_requirements[0].destination_criterion=' ';assert.equal(verifyWritingProfile(Buffer.from(partial),p,r).status,'invalid');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('two current-document quotes cannot pretend to be original-source coverage',()=>{
 const dir=mkdtempSync(join(tmpdir(),'writing-self-cite-'));try{
  const dp=join(dir,'doc.md');writeFileSync(dp,text);const p=profile();p.required_components=['c'];p.original_sources=[{blake3:hash(text),authority:'author_text'}];const r=reviews(text);const q={source_id:'d',text:'You exist: here and now.',byte_start:text.indexOf('You exist'),byte_end:text.indexOf('You exist')+Buffer.byteLength('You exist: here and now.')};r.source_bindings={schema:'synthetic-d245bc86d584',sources:[{id:'d',path:dp,blake3:hash(text)}],quotes:[{id:'q1',...q},{id:'q2',...q}]};r.components=[{component_id:'c',source_quote_index:0,destination_quote_index:1,source_authority:'author_text',relationship_review:'Trying to self-cite.',reviewer_role:'model'}];assert.equal(verifyWritingProfile(Buffer.from(text),p,r).status,'invalid');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('reports omit private bodies and caller-controlled names',()=>{
 const p=profile();p.rejections[0].id='SECRET-CALLER-ID';const t=text+'\nKnown rejected phrase';const r=reviews(t);r.blocks[0].reviewer='SECRET-REVIEWER';const result=JSON.stringify(verifyWritingProfile(Buffer.from(t),p,r));for(const secret of ['SECRET-CALLER-ID','SECRET-REVIEWER','Known rejected phrase','You exist:'])assert.ok(!result.includes(secret));
});
test('CLI creates private report and refuses to replace an existing report',()=>{
 const dir=mkdtempSync(join(tmpdir(),'writing-cli-'));try{
  const doc=join(dir,'doc.md'),p=join(dir,'profile.json'),r=join(dir,'review.json'),out=join(dir,'result.json');writeFileSync(doc,text);writeFileSync(p,JSON.stringify(profile()));writeFileSync(r,JSON.stringify(reviews(text)));const tool=fileURLToPath(new URL('../do-work/verify-writing-profile.mjs',import.meta.url));const args=[tool,'--document',doc,'--profile',p,'--reviews',r,'--out',out];assert.equal(spawnSync(process.execPath,args).status,0);assert.equal(statSync(out).mode&0o777,0o600);const before=readFileSync(out);assert.equal(spawnSync(process.execPath,args).status,2);assert.deepEqual(readFileSync(out),before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

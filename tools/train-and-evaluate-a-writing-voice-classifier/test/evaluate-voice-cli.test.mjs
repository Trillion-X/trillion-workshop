import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {validateInput,validateReport,REQUEST_POLICY,CHUNKED_TYPED_REQUEST_POLICY} from '../read-data/evaluation-integrity.mjs';
import {readFileSync} from 'node:fs';
import {blake3Hex} from '../do-work/evaluate-voice.mjs';

// Exercise the real CLI and shared adapter, including its busy-response retry
// branch. A source-string check would miss an omitted askMany option.
test('real CLI preserves categorical labels and single-attempt busy failures', {timeout:30000}, async () => {
  const folder=await mkdtemp(join(tmpdir(),'book-eval-attempt-'));
  const seen=[];let active=0,peak=0;
  const server=createServer(async(req,res)=>{
    if(req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({serving:'fixture-process',device:'fixture'}));return;}
    const chunks=[];for await(const x of req)chunks.push(x);
    const wire=JSON.parse(Buffer.concat(chunks).toString());seen.push(wire.state);active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,15));res.setHeader('content-type','application/json');
    if(wire.state.includes('busy-case')||(wire.state.includes('default-retry')&&seen.filter(x=>x===wire.state).length<3)){res.statusCode=429;res.end(JSON.stringify({error:'fixture busy'}));}
    else{res.end(JSON.stringify({model:'decider-v10',served_identity:'fixture-process',answers:Object.fromEntries(Object.entries(wire.questions).map(([id,q])=>{const names=Object.keys(q.criteria);return[id,{choice:names[0],confidence:1,probabilities:Object.fromEntries(names.map((n,i)=>[n,i===0?1:0]))}];})),usage:{input_tokens:8}}));}
    active--;
  });
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const endpoint=`http://127.0.0.1:${server.address().port}/v1/systemone`;
    const modes=['baseline','criterion','custom','custom-gold','custom-no-abstain','custom-prototype-labels'];
    for(const mode of modes){
      const data={schema:'book-voice-decider-challenge-v2',items:[{id:'normal',family:'one',split:'eval',text:'normal-case',origin:{kind:'synthetic'}},{id:'busy',family:'two',split:'eval',text:'busy-case',origin:{kind:'synthetic'}}]};
      if(mode==='baseline'){data.question='Is the claim retained?';data.options=['pass','fail','uncertain'];}
      else data.criteria=[{id:'retention',primitive:'one-of',question:'Is the claim retained?',options:mode.startsWith('custom')?['preserved','lost-content','uncertain']:['pass','fail','uncertain']}];
      if(mode==='custom-gold')data.items[0].checks={retention:'preserved'};
      if(mode==='custom-no-abstain')data.criteria[0].options=['preserved','lost-content'];
      if(mode==='custom-prototype-labels'){data.criteria[0].options=[{name:'__proto__',description:'First declared choice'},{name:'constructor',description:'Second declared choice'},'uncertain'];data.items[0].checks={retention:'__proto__'};}
      const input=join(folder,mode+'.json'),output=join(folder,mode+'-results.json');await writeFile(input,JSON.stringify(data));
      const child=spawn(process.execPath,['do-work/evaluate-voice.mjs','--data',input,'--out',output,'--endpoint',endpoint,'--model','decider-v10','--workers','1','--live','--single-attempt'],{cwd:new URL('..',import.meta.url),env:process.env,stdio:['ignore','pipe','pipe']});
      let diagnostics='';child.stdout.on('data',x=>diagnostics+=x);child.stderr.on('data',x=>diagnostics+=x);
      const [code]=await once(child,'exit');assert.equal(code,0,diagnostics);
      const result=JSON.parse(await readFile(output,'utf8'));
      assert.equal(result.complete,true);assert.equal(result.items.length,1);assert.equal(result.errors.length,1);
      assert.deepEqual(result.request_limits,{samples:1,attempts:1,workers:1});
      assert.equal(result.items[0].request_evidence.exchanges.length,1);assert.equal(result.errors[0].request_evidence.exchanges.length,1);
      assert.equal(result.errors[0].request_evidence.exchanges[0].status,429);
      const accepted=mode==='baseline'?result.items[0].predicted:result.items[0].checks.retention.predicted,expectedChoice=mode==='custom-prototype-labels'?'__proto__':mode.startsWith('custom')?'preserved':'pass';assert.equal(accepted,expectedChoice);
      if(mode.startsWith('custom')){assert.equal(result.items[0].checks.retention.decision,expectedChoice);assert.equal(result.summary.by_criterion.retention.prediction_counts[expectedChoice],1);}
      if(mode==='custom-gold'||mode==='custom-prototype-labels'){assert.equal(result.summary.by_criterion.retention.total,1);assert.equal(result.summary.by_criterion.retention.correct,1);}
      if(mode==='custom-no-abstain'){
        const tampered=structuredClone(result),row=tampered.items[0],saved=row.checks.retention;
        saved.predicted='uncertain';saved.decision='uncertain';saved.raw_answer='uncertain';
        const exchange=row.request_evidence.exchanges[0],body=JSON.parse(exchange.response);body.answers.retention.choice='uncertain';exchange.response=JSON.stringify(body);
        const expected={input:data,model:'decider-v10',endpoint,dataPath:input,dataBlake3:blake3Hex(readFileSync(input)),rubricBlake3:null,serving:'fixture-process',requestPolicy:REQUEST_POLICY,requestEvidenceVersion:1};
        assert.throws(()=>validateReport(tampered,expected,{requireServing:true}),/malformed criterion result/);
      }
    }
    // Default retry behavior and complete pre-limits v2 report resume remain usable.
    for(const mode of ['baseline','criterion']){
      const data={schema:'book-voice-decider-challenge-v2',items:[{id:'normal',family:'one',split:'eval',text:'default-retry-'+mode,origin:{kind:'synthetic'}}]};
      if(mode==='baseline'){data.question='Is the claim retained?';data.options=['pass','fail','uncertain'];}
      else data.criteria=[{id:'retention',primitive:'one-of',question:'Is the claim retained?',options:['pass','fail','uncertain']}];
      const input=join(folder,'default-'+mode+'.json'),output=join(folder,'default-'+mode+'-results.json');await writeFile(input,JSON.stringify(data));
      const invoke=async(flags=[])=>{const child=spawn(process.execPath,['do-work/evaluate-voice.mjs','--data',input,'--out',output,'--endpoint',endpoint,'--model','decider-v10','--workers','1','--live',...flags],{cwd:new URL('..',import.meta.url),env:process.env,stdio:['ignore','pipe','pipe']});let diagnostic='';child.stdout.on('data',x=>diagnostic+=x);child.stderr.on('data',x=>diagnostic+=x);const [code]=await once(child,'exit');assert.equal(code,0,diagnostic);return JSON.parse(await readFile(output,'utf8'));};
      const result=await invoke();assert.deepEqual(result.request_limits,{samples:1,attempts:3,workers:1});assert.equal(result.errors.length,0);assert.equal(result.items[0].request_evidence.exchanges.length,3);
      delete result.request_limits;await writeFile(output,JSON.stringify(result));const requestCount=seen.length;const resumed=await invoke(['--resume']);assert.equal(resumed.complete,true);assert.equal(resumed.items.length,1);assert.equal(seen.length,requestCount);
    }
    assert.equal(seen.filter(x=>x.includes('normal-case')).length,modes.length);
    assert.equal(seen.filter(x=>x.includes('busy-case')).length,modes.length);
    assert.equal(peak,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('unsupported prototype-sensitive criterion ids fail before request planning while labels remain legal',()=>{
  for(const id of Object.getOwnPropertyNames(Object.prototype)){
    const input={schema:'book-voice-decider-challenge-v2',criteria:[{id,primitive:'one-of',question:'Toy question',options:['pass','fail','uncertain']}],items:[{id:'toy',family:'toy',split:'eval',text:'Toy text',origin:{kind:'synthetic'}}]};
    assert.throws(()=>validateInput(input),/prototype-sensitive criterion id/);
  }
  const positive={schema:'book-voice-decider-challenge-v2',criteria:[{id:'ordinary',primitive:'one-of',question:'Toy question',options:['__proto__','constructor','uncertain']}],items:[{id:'toy',family:'toy',split:'eval',text:'Toy text',checks:{ordinary:'__proto__'},origin:{kind:'synthetic'}}]};
  assert.equal(validateInput(positive).evalItems.length,1);
});

test('v3 criteria require pinned reference context and explicit valid block applicability while v2 stays compatible',()=>{
  const input={schema:'book-voice-decider-challenge-v3',criteria:[{
    id:'voice',primitive:'one-of',question:'Does this fit the pinned voice?',options:['pass','fail','uncertain'],
    reference_context:'Use the supplied voice reference.',applies_to:['paragraph'],
  }],items:[{id:'one',family:'one',split:'eval',text:'A plain paragraph.',block_kind:'paragraph',origin:{kind:'synthetic'}}]};
  assert.equal(validateInput(input).evalItems.length,1);
  for(const mutate of [
    criterion=>{delete criterion.reference_context;},
    criterion=>{criterion.reference_context='  ';},
    criterion=>{delete criterion.applies_to;},
    criterion=>{criterion.applies_to=[];},
    criterion=>{criterion.applies_to=['unknown'];},
    criterion=>{criterion.applies_to=['paragraph','paragraph'];},
  ]){
    const invalid=structuredClone(input);mutate(invalid.criteria[0]);
    assert.throws(()=>validateInput(invalid),/pinned reference context|criterion applicability/);
  }
  const legacy={schema:'book-voice-decider-challenge-v2',criteria:[{
    id:'voice',primitive:'one-of',question:'Does this fit?',options:['pass','fail','uncertain'],
  }],items:[{id:'one',family:'one',split:'eval',text:'A plain paragraph.',origin:{kind:'synthetic'}}]};
  assert.equal(validateInput(legacy).evalItems.length,1);
});

test('real CLI evaluates every source-bound section chunk and derives pass or late contradiction', {timeout:30000}, async()=>{
  const folder=await mkdtemp(join(tmpdir(),'book-eval-section-chunks-'));
  const seen=[]; const model='decider-v10', serving='fixture-process';
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/health'){res.end(JSON.stringify({serving}));return;}
    const parts=[];for await(const part of req)parts.push(part);
    const wire=JSON.parse(Buffer.concat(parts).toString());seen.push(wire);
    const state=JSON.parse(wire.state), section=state.section_chunk?.text ?? '';
    const answers=Object.fromEntries(Object.entries(wire.questions).map(([id,q])=>{
      const names=Object.keys(q.criteria),weakPass=id==='section-heading-fit'&&section.includes('weak pass'),weakFail=id==='section-heading-fit'&&section.includes('weak fail');
      const choice=id!=='section-heading-fit'?'pass':section.includes('contradiction')?'fail':section.includes('ambiguous')?'uncertain':weakFail?'fail':'pass';
      const confidence=weakPass||weakFail?0.25:choice==='uncertain'?0.8:1;
      const probabilities=weakPass?{pass:0.25,fail:0.65,uncertain:0.1}:weakFail?{pass:0.65,fail:0.25,uncertain:0.1}
        :Object.fromEntries(names.map(name=>[name,name===choice?(choice==='uncertain'?0.8:1):choice==='uncertain'?0.1:0]));
      return[id,{choice,confidence,probabilities}];
    }));
    res.end(JSON.stringify({model,served_identity:serving,answers,usage:{input_tokens:12}}));
  });
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const endpoint=`http://127.0.0.1:${server.address().port}/v1/systemone`;
    const invoke=async(suffix,laterText)=>{
      const document='a'.repeat(64);
      const data={schema:'book-voice-decider-challenge-v3',document_blake3:document,dataset_role:'fixture',criteria:[
        {id:'section-heading-fit',primitive:'one-of',question:'Whole-section evaluation.',options:['pass','fail','uncertain'],
          reference_context:'Judge each local chunk; aggregate complete ordered coverage.',applies_to:['heading'],
          section_chunk_request:{question:'Does this local chunk support the heading topic or directly contradict it?',options:['pass','fail','uncertain']}},
        {id:'body-check',primitive:'one-of',question:'Is the prose clear?',options:['pass','fail','uncertain'],
          reference_context:'Use plain words.',applies_to:['paragraph']},
      ],items:[
        {id:'heading',family:'heading',split:'eval',source_kind:'fixture',origin:{kind:'fixture'},block_kind:'heading',source_block_index:0,text:'# Topic',
          checks:{'section-heading-fit':laterText.includes('contradiction')?'fail':laterText.includes('ambiguous')?'uncertain':'pass'},
          section_chunk_manifest:{source_blake3:document,heading_block_index:0,section_end_block_index:3,chunks:[
            {chunk_index:0,block_indices:[1],text:'First support.',gold:'pass'},
            {chunk_index:1,block_indices:[2],text:laterText,gold:laterText.includes('contradiction')?'fail':laterText.includes('ambiguous')?'uncertain':'pass'}]}},
        {id:'body-one',family:'body-one',split:'eval',source_kind:'fixture',origin:{kind:'fixture'},block_kind:'paragraph',source_block_index:1,text:'First support.'},
        {id:'body-two',family:'body-two',split:'eval',source_kind:'fixture',origin:{kind:'fixture'},block_kind:'paragraph',source_block_index:2,text:laterText},
      ]};
      const input=join(folder,suffix+'.json'),output=join(folder,suffix+'-result.json');await writeFile(input,JSON.stringify(data));
      const child=spawn(process.execPath,['do-work/evaluate-voice.mjs','--data',input,'--out',output,'--endpoint',endpoint,'--model','decider-v10','--workers','1','--live','--single-attempt'],
        {cwd:new URL('..',import.meta.url),env:process.env,stdio:['ignore','pipe','pipe']});
      let diagnostic='';child.stdout.on('data',x=>diagnostic+=x);child.stderr.on('data',x=>diagnostic+=x);
      const [code]=await once(child,'exit');assert.equal(code,0,diagnostic);
      const report=JSON.parse(await readFile(output,'utf8'));
      const expected={input:data,model,endpoint,dataPath:input,dataBlake3:blake3Hex(readFileSync(input)),rubricBlake3:null,
        serving,requestPolicy:CHUNKED_TYPED_REQUEST_POLICY,requestEvidenceVersion:1,servingIdentityPolicy:'observed-health-and-response-v1'};
      validateReport(report,expected,{requireServing:true});
      return {data,report,expected};
    };
    const complete=await invoke('complete','Second support.');
    assert.equal(complete.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].decision,'pass');
    assert.equal(complete.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].section_chunk_aggregate.chunk_results.length,2);
    const contradiction=await invoke('contradiction','This later section directly contains a contradiction.');
    assert.equal(contradiction.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].decision,'fail');
    assert.equal(contradiction.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].section_chunk_aggregate.chunk_results[1].gold,'fail');
    const tampered=structuredClone(contradiction.report);const check=tampered.items.find(row=>row.id==='heading').checks['section-heading-fit'];
    check.decision='pass';check.predicted='pass';check.section_chunk_aggregate.label='pass';
    assert.throws(()=>validateReport(tampered,contradiction.expected,{requireServing:true}),/aggregation|derived|raw response/i);
    const uncertain=await invoke('uncertain','This chunk leaves the heading scope ambiguous.');
    const uncertainChunk=uncertain.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].section_chunk_aggregate.chunk_results[1];
    assert.equal(uncertainChunk.gold,'uncertain');assert.equal(uncertainChunk.predicted,'uncertain');assert.ok(uncertainChunk.probabilities.uncertain>0.5);
    const weakPass=await invoke('weak-pass','This chunk has weak pass support but stronger fail evidence.');
    const weakPassChunk=weakPass.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].section_chunk_aggregate.chunk_results[1];
    assert.equal(weakPassChunk.predicted,'pass');assert.equal(weakPassChunk.decision,'uncertain');
    assert.deepEqual(weakPassChunk.probabilities,{pass:0.25,fail:0.65,uncertain:0.1});
    assert.equal(weakPass.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].decision,'uncertain');
    const weakFail=await invoke('weak-fail','This chunk has weak fail support but stronger pass evidence.');
    const weakFailChunk=weakFail.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].section_chunk_aggregate.chunk_results[1];
    assert.equal(weakFailChunk.predicted,'fail');assert.equal(weakFailChunk.decision,'uncertain');
    assert.deepEqual(weakFailChunk.probabilities,{pass:0.65,fail:0.25,uncertain:0.1});
    assert.equal(weakFail.report.items.find(row=>row.id==='heading').checks['section-heading-fit'].decision,'uncertain');
    assert.equal(seen.filter(wire=>JSON.parse(wire.state).section_chunk).length,10);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('CLI binds accepted responses to observed health identity and gates model requests on health', {timeout:30000}, async () => {
  const folder=await mkdtemp(join(tmpdir(),'book-eval-identity-'));
  let healthServing='health-process';let requests=0;
  const server=createServer(async(req,res)=>{
    if(req.url==='/health'){
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(healthServing === null ? {} : {serving:healthServing}));return;
    }
    requests++;
    const chunks=[];for await(const x of req)chunks.push(x);
    const wire=JSON.parse(Buffer.concat(chunks).toString());
    const mismatch=wire.state.includes('response-b');
    const missing=wire.state.includes('response-missing');
    const body={model:'decider-v10',answers:Object.fromEntries(Object.entries(wire.questions).map(([id,q])=>{const names=Object.keys(q.criteria);return[id,{choice:names[0],confidence:1,probabilities:Object.fromEntries(names.map((n,i)=>[n,i===0?1:0]))}];}))};
    if(!missing)body.served_identity=mismatch?'response-process':healthServing;
    res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
  });
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const endpoint=`http://127.0.0.1:${server.address().port}/v1/systemone`;
    const invoke=async(name,text,criteria)=>{
      const data={schema:'book-voice-decider-challenge-v2',criteria,items:[{id:'one',family:'one',split:'eval',text,origin:{kind:'synthetic'},role:'authored'}]};
      const input=join(folder,`${name}.json`),output=join(folder,`${name}-results.json`);await writeFile(input,JSON.stringify(data));
      const child=spawn(process.execPath,['do-work/evaluate-voice.mjs','--data',input,'--out',output,'--endpoint',endpoint,'--model','decider-v10','--workers','1','--live','--single-attempt'],{cwd:new URL('..',import.meta.url),env:process.env,stdio:['ignore','pipe','pipe']});
      let diagnostic='';child.stdout.on('data',x=>diagnostic+=x);child.stderr.on('data',x=>diagnostic+=x);
      const [code]=await once(child,'exit');assert.equal(code,0,diagnostic);return JSON.parse(await readFile(output,'utf8'));
    };
    const modelCriteria=[{id:'retention',primitive:'one-of',question:'Is it retained?',options:['pass','fail','uncertain']}];
    healthServing='health-process';
    const matching=await invoke('matching','matching-response',modelCriteria);
    assert.equal(matching.items.length,1);assert.equal(matching.errors.length,0);
    assert.equal(matching.serving_identity_assurance,'observed-health-and-response');
    for(const [name,text] of [['mismatch','response-b'],['missing-response','response-missing']]){
      const result=await invoke(name,text,modelCriteria);
      assert.equal(result.items.length,0);assert.equal(result.errors.length,1);
      assert.equal(result.errors[0].request_evidence.exchanges.length,1);
      assert.equal(result.errors[0].request_evidence.exchanges[0].status,200);
      assert.match(result.errors[0].error,/serving identity/);
      assert.equal(result.serving_identity_assurance,'no-accepted-model-results');
    }
    const before=requests;healthServing='  ';
    const noHealth=await invoke('missing-health','no-health',modelCriteria);
    assert.equal(requests,before);assert.equal(noHealth.items.length,0);assert.equal(noHealth.errors.length,1);
    assert.equal(noHealth.errors[0].request_evidence.exchanges.length,0);
    assert.equal(noHealth.serving_identity_assurance,'no-accepted-model-results');
    healthServing=null;
    const deterministic=await invoke('deterministic-only','deterministic',[
      {id:'dash',deterministic:true,question:'Has no em dash?',options:['pass','fail','uncertain']}]);
    assert.equal(deterministic.items.length,1);assert.equal(deterministic.errors.length,0);
    assert.equal(deterministic.serving_identity_policy,'observed-health-and-response-v1');
    assert.equal(deterministic.serving_identity_assurance,'no-accepted-model-results');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

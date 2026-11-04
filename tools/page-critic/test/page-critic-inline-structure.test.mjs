import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {launchChromium} from '../../headless-browser/launch.mjs';
import {collectControlNames} from '../do-work/collect-control-names.mjs';
import {demoFramesForRule} from '../do-work/frame-selection.mjs';
import {pageCraftMeasures} from '../do-work/measure-page-craft.mjs';
import {runMatrix,readViews} from '../../check-every-screen-at-every-width/check-screens.mjs';

const svg = size => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-7-7 7 7-7 7" fill="none" stroke="currentColor"/></svg>`;
const document = bad => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Structural check</title><style>body{margin:24px;font:20px/1.4 system-ui;background:white;color:black}h1,h2{font:40px/1.2 system-ui;margin:0}button{display:inline-flex;align-items:center;justify-content:center;vertical-align:baseline;width:44px;height:44px;background:white;color:black;border:1px solid black}p{margin:0 0 8px;font-size:16px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style></head><body><main>${bad ? `
<p>School of thought</p><h1>A complete explanation <button aria-label="Expand explanation">${svg(12)}</button></h1>
<p>An action <button><span class="sr-only">Expand detail</span>${svg(4)}</button></p>
<figure><div aria-hidden="true" style="height:80px;background:#ddd"></div><figcaption>The ball and strings deform together during contact. This is an <span>illustrative</span> model, with deformation exaggerated to make the interaction visible.</figcaption></figure>
<figure><div aria-hidden="true" style="height:80px;background:#ddd"></div><figcaption>Force transfers.</figcaption></figure>
<svg role="img" aria-label="Illustrative tennis point: the player reaches the ball after it passes the racket." viewBox="0 0 500 240"><title id="court-description">Four tennis capacities, shown on court</title><text x="20" y="30">TECHNIQUE</text><text x="20" y="60">Force transfers.</text><text x="20" y="90">The ball and strings deform together during contact. This is an <tspan>illustrative model</tspan>, with deformation exaggerated to make the interaction visible.</text><text x="20" y="120">STAGED EXAMPLE</text><text x="20" y="150">ILLUSTRATION</text><text x="20" y="180">ILLUSTRATIVE WORKFLOW</text><text x="20" y="210">ILLUSTRATIVE EXAMPLE</text></svg>
<h2>Contact deformation</h2><p>The ball and strings deform together during contact. This is an illustrative model, with deformation exaggerated to make the interaction visible.</p>
<h2>Learning goals</h2><p>Notice how the ball transfers force through each string and changes the shape of the surface it touches.</p><h2>Force transfer</h2><p>Force transfers.</p>
<h2>Simulation</h2><p class="subtitle">A closer look</p>
<button class="unnamed-control" data-unnamed></button><input type="text" class="empty-control" data-empty>` : `
<h1>A complete explanation <button aria-label="Expand explanation">${svg(24)}</button></h1>
<label for="account-name">Account name</label><input id="account-name">
<span id="hidden-control-label" hidden>Archive draft</span><button aria-labelledby="hidden-control-label">${svg(24)}</button>
<button role="button" aria-label="Open settings">${svg(24)}</button>
<div><p><span id="field-hint">Your full legal name</span></p><h1 aria-describedby="extra field-hint">Personal details</h1></div>
<div><p role="status">Two seats available</p><h1>Class size</h1></div>
<div><p><time datetime="2026-10-24">October 24, 2026</time></p><h1>Published date</h1></div>
<h2>Contact deformation</h2><p>The ball transfers force through each string, changing the surface shape during contact.</p>
<details open data-disclosure><summary>About this model</summary><p>This illustrative model uses exaggerated movement to show the contact point clearly.</p></details>
<p data-record-type>Illustration</p>
<svg role="img" aria-labelledby="court-title court-description" viewBox="0 0 500 160"><title id="court-title">Illustrative tennis court with four stages</title><desc id="court-description">The drawing simplifies court geometry to make the movement pattern clear.</desc><text x="20" y="40">TECHNIQUE</text><text x="20" y="90">Force transfers.</text></svg>
<h2>Account recovery</h2><p id="recovery-help">Use your recovery key to regain access if you lose your sign-in method.</p><input aria-describedby="recovery-help" aria-label="Recovery key">`}</main></body></html>`;

test('missing and ambiguous AX nodes stay explicitly unavailable', async () => {
 const collect = nodes => collectControlNames({selector:'button',roles:['button'],send:async(method)=>{
  if(method==='DOM.enable'||method==='Accessibility.enable')return {};
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='DOM.querySelectorAll')return {nodeIds:[2]};
  if(method==='DOM.describeNode')return {node:{backendNodeId:55}};
  if(method==='DOM.resolveNode')return {object:{objectId:'control'}};
  if(method==='Runtime.callFunctionOn')return {result:{value:{selector:'button',identitySelector:'html > body > button',shown:true,rect:{x:0,y:0,width:40,height:40}}}};
  if(method==='Accessibility.getFullAXTree')return {nodes};
  if(method==='Accessibility.getPartialAXTree')return {nodes};
  if(method==='Runtime.releaseObject')return {};
  throw new Error(`unexpected CDP call ${method}`);
 }});
 const missing=await collect([]);
 assert.equal(missing[0].state,'unavailable');
 assert.match(missing[0].reason,/no applicable/);
 const ambiguous=await collect([
  {backendDOMNodeId:55,role:{value:'button'},name:{value:'One'}},
  {backendDOMNodeId:55,role:{value:'button'},name:{value:'Two'}},
 ]);
 assert.equal(ambiguous[0].state,'unavailable');
 assert.match(ambiguous[0].reason,/ambiguous/);
});

test('an unresolved frame owner is skipped by demo matching without throwing', () => {
 const frames=[
  {frame:{url:'https://demo.example/one'},owner:null},
  {frame:{url:'https://demo.example/two'},owner:{shown:true,src:'https://demo.example/two',selector:'body > iframe',rect:{x:0,y:0,width:100,height:100}}},
 ];
 assert.deepEqual(demoFramesForRule(frames,{demo_url_patterns:['demo\\.example']}),[frames[1]]);
});

test('the release screen matrix rejects eyebrows, secondary captions and production commentary while preserving useful prose and accessible descriptions',async()=>{
 const ambiguousPath = '<h1>Repeated deep branches</h1><section><div class="repeat"><div class="branch"><div class="inner"><button aria-label="Named control"></button></div></div></div></section><section><div class="repeat"><div class="branch"><div class="inner"><button></button></div></div></div></section>';
 const server=createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/html'});
  if(req.url==='/frame-host')res.end('<!doctype html><button aria-label="Top frame control"></button><iframe src="/frame-controls"></iframe><iframe srcdoc="<!doctype html><button aria-label=\'Srcdoc frame control\'></button><button class=\'srcdoc-empty\'></button>"></iframe>');
  else if(req.url==='/frame-controls')res.end('<!doctype html><button aria-label="Inner frame control"></button><button class="frame-empty"></button>');
  else res.end(req.url==='/ambiguous-path' ? `<!doctype html><style>button{width:40px;height:40px}</style><body><main>${ambiguousPath}</main></body>` : document(req.url==='/bad'));
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const browser=await launchChromium({headless:true});
 try {
  const views=readViews();views.widths=views.widths.filter(w=>['phone','desktop'].includes(w.id));views.modes=views.modes.filter(m=>m.id==='light');views.pool=1;views.settle_ms=0;views.quiet_ms=50;views.animation_wait_ms=100;views.max_scroll_steps=3;
  const craft=JSON.parse(readFileSync(new URL(import.meta.resolve('../read-data/page-craft-rules.json')),'utf8'));
  const controlRule=craft.rules.find(row=>row.id==='control_name');
  const ambiguityPage=await browser.newPage();
  try{
   await ambiguityPage.goto(`http://127.0.0.1:${server.address().port}/ambiguous-path`);
   const ambiguitySession=await ambiguityPage.context().newCDPSession(ambiguityPage);
   const records=await collectControlNames({send:(method,params)=>ambiguitySession.send(method,params),selector:craft.selectors.control_name_candidates,roles:controlRule.roles});
   const branchRecords=records.filter(item=>item.selector?.includes('div.repeat'));
   assert.equal(branchRecords.length,2,'both controls in the repeated deep branches have AX records');
   assert.ok(branchRecords.every(item=>item.shown),`both same-path controls are rendered: ${JSON.stringify(branchRecords)}`);
   assert.equal(branchRecords[0].selector,branchRecords[1].selector,'the fixture reproduces pathOf’s four-level selector collision');
   assert.notEqual(branchRecords[0].identitySelector,branchRecords[1].identitySelector,'the full structural identity distinguishes repeated short diagnostic paths');
   const direct=await ambiguityPage.evaluate(async ({source,params})=>await eval(source)(params),{source:pageCraftMeasures,params:{rules:[controlRule],selectors:craft.selectors,freshDays:null,now:Date.now(),widthId:'390',controlNames:records}});
   const directCollision=direct.found.filter(item=>item.rule==='control_name');
   assert.equal(directCollision.length,1,`the exact structural identity reports only the unnamed control: ${JSON.stringify(directCollision)}`);
   assert.equal(directCollision[0].values.kind,'unnamed');
   assert.ok(directCollision[0].identitySelector && directCollision[0].displaySelector===branchRecords[0].selector,'the finding retains exact identity and the short human diagnostic path');
   await ambiguitySession.detach();
  }finally{await ambiguityPage.close();}
  const result=await runMatrix({target:{origin:`http://127.0.0.1:${server.address().port}`,newContext:options=>browser.newContext(options)},screens:{screens:[{id:'planted',route:'/bad',ready:{selector:'h1'}},{id:'clean',route:'/good',ready:{selector:'h1'}},{id:'ambiguous-path',route:'/ambiguous-path',ready:{selector:'h1'}}]},views,allowlist:[]});
  assert.ok(result.report.jobs>=3,'real release matrix opened all three states');
  for(const width of views.widths){
   const failed=result.failures.filter(f=>f.screen==='planted'&&f.width===width.id);
   assert.ok(failed.some(f=>f.probe==='eyebrow'),`${width.id}: sentence-case eyebrow was missed: ${JSON.stringify(failed)}`);
   const supporting=failed.filter(f=>f.probe==='repeated_supporting_text');
   assert.ok(supporting.some(f=>f.text?.includes('illustrative model')),`${width.id}: production commentary was missed`);
   assert.ok(supporting.some(f=>f.text?.includes('illustrative model') && f.selector?.includes('figcaption')),`${width.id}: production caption after a figure, split by inline markup, was missed`);
   assert.ok(supporting.some(f=>f.text?.includes('illustrative model') && f.selector?.includes('svg') && f.selector?.includes('text')),`${width.id}: production SVG text, split across a tspan, was missed`);
   for(const text of ['STAGED EXAMPLE','ILLUSTRATION','ILLUSTRATIVE WORKFLOW','ILLUSTRATIVE EXAMPLE'])assert.ok(supporting.some(f=>f.text===text),`${width.id}: retained rejected film label ${text} was missed`);
   assert.ok(supporting.some(f=>f.text==='A closer look'),`${width.id}: short secondary subtitle was missed`);
   assert.ok(!supporting.some(f=>f.text?.startsWith('Notice how')),`${width.id}: substantive teaching prose was incorrectly rejected`);
   assert.ok(!supporting.some(f=>f.text==='Force transfers.'),`${width.id}: a short complete teaching sentence was incorrectly rejected`);
   assert.ok(failed.filter(f=>f.probe==='inline_icon_scale').length >= 2,`${width.id}: small arrow was missed`);
   const unnamed=failed.filter(f=>f.probe==='control_name');
   assert.ok(unnamed.some(f=>f.selector?.includes('button')),`${width.id}: unnamed native button was missed`);
   assert.ok(unnamed.some(f=>f.selector?.includes('input')),`${width.id}: unnamed text input was missed`);
  }
  assert.deepEqual(result.failures.filter(f=>f.screen==='clean'),[],'native labels, aria-label, hidden aria-labelledby text, and role-based button names must remain accepted');
  for(const width of views.widths){
   const collisions=result.failures.filter(f=>f.screen==='ambiguous-path'&&f.width===width.id&&f.probe==='control_name');
   assert.equal(collisions.length,1,`${width.id}: the repeated selector yields one deduplicated fail-closed finding`);
   assert.ok(collisions[0].detail.includes('no accessible name'),`${width.id}: the exact structural identity still finds the unnamed branch: ${JSON.stringify(collisions[0])}`);
   assert.ok(collisions[0].selector.includes('html')&&!collisions[0].selector.includes('.repeat'),`${width.id}: the reported selector is the unique class-free structural identity`);
  }
  const framePage=await browser.newPage();
  try{
   await framePage.goto(`http://127.0.0.1:${server.address().port}/frame-host`);
   const session=await framePage.context().newCDPSession(framePage);
   await session.send('Page.enable');
   const {frameTree}=await session.send('Page.getFrameTree');
   const childFrameId=frameTree.childFrames?.[0]?.frame?.id;
   const srcdocFrameId=frameTree.childFrames?.[1]?.frame?.id;
   assert.ok(childFrameId,'the controlled same-origin iframe was opened');
   assert.ok(srcdocFrameId,'the controlled srcdoc iframe was opened');
   const rule=controlRule;
   const send=(method,params)=>session.send(method,params);
   const srcdocNames=await collectControlNames({send,selector:craft.selectors.control_name_candidates,roles:rule.roles,frameId:srcdocFrameId});
   const topNames=await collectControlNames({send,selector:craft.selectors.control_name_candidates,roles:rule.roles,frameId:frameTree.frame.id});
   const frameNames=await collectControlNames({send,selector:craft.selectors.control_name_candidates,roles:rule.roles,frameId:childFrameId});
   assert.ok(topNames.some(item=>item.name==='Top frame control'),'the top document retains its own AX names');
   assert.ok(frameNames.some(item=>item.name==='Inner frame control'),'the requested frame returns its own computed name');
   assert.ok(frameNames.some(item=>item.selector?.includes('frame-empty')&&item.state==='available'&&!item.name),'the empty inner-frame control is represented as unnamed');
   assert.ok(srcdocNames.some(item=>item.name==='Srcdoc frame control'),'the srcdoc frame document root is addressable');
   assert.ok(srcdocNames.some(item=>item.selector?.includes('srcdoc-empty')&&item.state==='available'&&!item.name),'the empty srcdoc control remains represented');
   const measured=await framePage.frames()[1].evaluate(async ({source,params})=>await eval(source)(params),{
    source:pageCraftMeasures,
    params:{rules:[rule],selectors:craft.selectors,freshDays:null,now:Date.now(),widthId:'390',controlNames:frameNames},
   });
   assert.deepEqual(measured.found.filter(item=>item.rule==='control_name').map(item=>item.values.kind),['unnamed'],'the same serialized measure flags only the unnamed inner-frame control');
   const srcdocFrame=framePage.frames().find(frame=>frame.url()==='about:srcdoc');
   assert.ok(srcdocFrame,'the nested srcdoc browsing context is visible to Playwright');
   const srcdocMeasured=await srcdocFrame.evaluate(async ({source,params})=>await eval(source)(params),{
    source:pageCraftMeasures,
    params:{rules:[rule],selectors:craft.selectors,freshDays:null,now:Date.now(),widthId:'390',controlNames:srcdocNames},
   });
   assert.deepEqual(srcdocMeasured.found.filter(item=>item.rule==='control_name').map(item=>item.values.kind),['unnamed'],'the shared measure flags only the unnamed srcdoc control');
   await session.detach();
  }finally{await framePage.close();}
  const unknown=await runMatrix({target:{origin:`http://127.0.0.1:${server.address().port}`,newContext:options=>browser.newContext(options)},screens:{screens:[{id:'unknown-rule',route:'/good',ready:{selector:'h1'}}]},views:{...views,widths:views.widths.slice(0,1),craft_rules:['unknown-rule']},allowlist:[]});
  assert.ok(unknown.failures.some(f=>f.detail.includes('Unknown shared page-craft rule')), 'an unknown rule must refuse, not silently pass');
 }finally{await browser.close();await new Promise(done=>server.close(done));}
});

test('the public critic reads named top-frame and empty same-origin iframe controls', {timeout:120000}, async()=>{
 const server=createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/html'});
  if(req.url==='/frame-host')res.end('<!doctype html><button aria-label="Top frame control"></button><iframe src="/frame-controls"></iframe><iframe srcdoc="<!doctype html><button aria-label=\'Srcdoc frame control\'></button><button class=\'srcdoc-empty\'></button>"></iframe>');
  else res.end('<!doctype html><button aria-label="Inner frame control"></button><button class="frame-empty"></button>');
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const out=mkdtempSync(join(tmpdir(),'page-craft-control-name-'));
 try{
  const stdout=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[fileURLToPath(new URL(import.meta.resolve('../do-work/critique-a-page.mjs'))),'--url',`http://127.0.0.1:${server.address().port}/frame-host`,'--out',out],{env:{...process.env,BROWSER_EXECUTABLE:chromium.executablePath()},stdio:['ignore','pipe','pipe']});
   let output='',errors='';
   const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('public critic did not finish within 110 seconds'));},110000);
   child.stdout.setEncoding('utf8').on('data',chunk=>output+=chunk);
   child.stderr.setEncoding('utf8').on('data',chunk=>errors+=chunk);
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('close',(code,signal)=>{clearTimeout(timer);if(code===0)resolve(output);else reject(new Error(`public critic exited ${code ?? signal}: ${errors}`));});
  });
  const report=JSON.parse(stdout.trim());
  assert.ok(report.findings.some(item=>item.rule==='control_name'&&item.selector?.includes('iframe:nth-of-type(1)')),'the ordinary critic finds the unnamed same-origin child-frame control');
  assert.ok(report.findings.some(item=>item.rule==='control_name'&&item.selector?.includes('iframe:nth-of-type(2)')),'the ordinary critic finds the unnamed srcdoc control');
  assert.ok(!report.findings.some(item=>item.rule==='control_name'&&!item.selector?.includes('iframe')),'the named top-frame control remains accepted');
 }finally{rmSync(out,{recursive:true,force:true});await new Promise(done=>server.close(done));}
});

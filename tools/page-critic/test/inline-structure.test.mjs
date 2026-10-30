import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {collectControlNames} from '../do-work/collect-control-names.mjs';
import {demoFramesForRule} from '../do-work/frame-selection.mjs';

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
   const child=spawn(process.execPath,[fileURLToPath(new URL('../do-work/critique-a-page.mjs',import.meta.url)),'--url',`http://127.0.0.1:${server.address().port}/frame-host`,'--out',out],{env:{...process.env,BROWSER_EXECUTABLE:chromium.executablePath()},stdio:['ignore','pipe','pipe']});
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

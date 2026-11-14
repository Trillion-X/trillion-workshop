import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {buildPremiereProjectHandoff} from '../premiere-project-handoff.mjs';
const input={id:'synthetic-cut',xmlPath:'/tmp/source.xml',outputPath:'/tmp/result.prproj',title:'Synthetic cut',fps:30,cuts:[{source:'/tmp/blue.mp4',in:2,out:4}]};
function host({open=false,badCut=false,existing=false,missing=false}={}){
 let saved=false,created=false,imported=false;
 const clip={projectItem:{getMediaPath:()=>'/tmp/blue.mp4'},inPoint:{seconds:badCut?0:2},outPoint:{seconds:4},start:{seconds:0},end:{seconds:2}};
 const clips={0:clip,numItems:1};const seq={name:input.title,sequenceID:'native-sequence',videoTracks:{0:{clips},numTracks:1}};
 function File(p){this.fsName=p;this.exists=p===input.outputPath?existing||saved:!missing;this.length=saved?100:0;}
 const app={isDocumentOpen:()=>open,newProject:p=>{created=true;app.project.path=p;return true;},project:{path:'',rootItem:{},importFiles:()=>{imported=true;app.project.sequences={0:seq,numSequences:1};return true;},save:()=>{saved=true;return 0;}}};
 return {context:{File,app,JSON,isFinite,Error},state:()=>({saved,created,imported})};
}
test('generated command imports and validates source cut before native save',()=>{
 const h=host(),cmd=buildPremiereProjectHandoff(input);const result=JSON.parse(vm.runInNewContext(cmd.script,h.context));
 assert.equal(result.saved,true);assert.equal(result.effects_verified,false);assert.equal(result.source_cuts[0].in,2);assert.deepEqual(h.state(),{saved:true,created:true,imported:true});assert.equal(cmd.support.native_execution_verified,false);
});
test('refuses an open customer project, an existing output, and missing media before mutation',()=>{
 for(const config of [{open:true},{existing:true},{missing:true}]){const h=host(config);assert.throws(()=>vm.runInNewContext(buildPremiereProjectHandoff(input).script,h.context));assert.equal(h.state().created,false);}
});
test('imported wrong source cut cannot be saved as successful handoff',()=>{const h=host({badCut:true});assert.throws(()=>vm.runInNewContext(buildPremiereProjectHandoff(input).script,h.context),/source cut/);assert.equal(h.state().saved,false);});
test('an existing project shell cannot disguise a failed save',()=>{const h=host();h.context.app.project.save=()=>1;assert.throws(()=>vm.runInNewContext(buildPremiereProjectHandoff(input).script,h.context),/could not save/);});
test('untrusted paths and titles remain data, never executable source',()=>{
 const cmd=buildPremiereProjectHandoff({...input,title:'name";throw Error("injected")//\u2028'});assert.doesNotThrow(()=>new vm.Script(cmd.script));assert.throws(()=>buildPremiereProjectHandoff({...input,outputPath:'../result.prproj'}));assert.throws(()=>buildPremiereProjectHandoff({...input,cuts:[{source:'/tmp/a',in:4,out:2}]}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWorkspaceRecordReader} from '../src/native-workspace-record-reader.mjs';

test('workspace record reads follow native selection when recordings occupy another resource',async()=>{
 const selected='work:recording-source',calls=[];let localReads=0;
 const reader=nativeWorkspaceRecordReader({resource:'work:share-source',consumer:{
  selectResource:async input=>{calls.push(['select',input]);return selected;},
  execute:async(...args)=>{calls.push(['execute',...args]);return {records:{'record-audio-recordings':[]}};},
 },localRead:async()=>{localReads++;return {records:{}};}});
 const selection=['record-audio-recordings','record-video-recordings'];
 const result=await reader(selection);
 assert.deepEqual(result.records,{'record-audio-recordings':[]});
 assert.deepEqual(calls[0],['select',{operation:'workspace:read',input:{selection},request_key:calls[0][1].request_key}]);
 assert.equal(calls[0][1].request_key.startsWith('workspace-read:'),true);
 assert.equal(calls[1][0],'execute');
 assert.equal(calls[1][1],selected);
 assert.equal(calls[1][2],'workspace:read');
 assert.deepEqual(calls[1][3],{selection});
 assert.equal(calls[1][4],calls[0][1].request_key);
 assert.equal(localReads,0,'a different selected owner is never bypassed by the local workspace instance');
});

test('workspace record reads use the local owner only when native selection names it',async()=>{
 let localInput,executions=0;
 const reader=nativeWorkspaceRecordReader({resource:'@own-records',consumer:{
  selectResource:async()=> '@own-records',execute:async()=>{executions++;throw Error('must stay local');},
 },localRead:async input=>{localInput=input;return {records:{current:true}};}});
 assert.deepEqual(await reader(['record-audio-recordings']),{records:{current:true}});
 assert.deepEqual(localInput,{selection:['record-audio-recordings']});
 assert.equal(executions,0);
});

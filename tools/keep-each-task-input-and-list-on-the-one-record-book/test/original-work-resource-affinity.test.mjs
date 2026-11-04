import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {bindOriginalWorkAffinity,readOriginalWorkAffinity,takeOriginalWorkAffinity,tombstoneOriginalWorkAffinity} from '../src/original-work-resource-affinity.mjs';
test('durable point affinity keeps immutable groups, current generation and tombstones',()=>{
 const h=sqliteHost(':memory:');const identity={kind:'input',id:'original'};const resource={owner:'person:7',resource:'work:a'};
 try{
  h.transaction(()=>bindOriginalWorkAffinity(h.sql,'person:7',{generation:'initial',identity,resource,group:'atomic'}));
  assert.deepEqual(readOriginalWorkAffinity(h.sql,'person:7',identity,'initial'),{generation:'initial',resource,group:'atomic'});
  assert.throws(()=>h.transaction(()=>bindOriginalWorkAffinity(h.sql,'person:7',{generation:'initial',identity,resource,group:'another'})),{code:'resource_selection_conflict'});
  h.transaction(()=>tombstoneOriginalWorkAffinity(h.sql,'person:7',{generation:'initial',identity,reason:'erased'}));
  assert.throws(()=>readOriginalWorkAffinity(h.sql,'person:7',identity,'initial'),{code:'resource_selection_tombstoned'});
  assert.equal(readOriginalWorkAffinity(h.sql,'person:7',identity,'fresh'),null);
  const newResource={owner:'person:7',resource:'work:new'};
  h.transaction(()=>bindOriginalWorkAffinity(h.sql,'person:7',{generation:'fresh',identity,resource:newResource}));
  assert.deepEqual(readOriginalWorkAffinity(h.sql,'person:7',identity,'fresh'),{generation:'fresh',resource:newResource});
 }finally{h.db.close();}
});
test('receiving affinity carry is idempotent and keeps the mapped resource and atomic group',()=>{
 const h=sqliteHost(':memory:'),identity={kind:'input',id:'carried-input'},resource={owner:'new-owner',resource:'moved:work-a'};
 try{
  const first=h.transaction(()=>takeOriginalWorkAffinity(h.sql,'new-owner',{generation:'initial',identity,resource,group:'related'}));
  const replay=h.transaction(()=>takeOriginalWorkAffinity(h.sql,'new-owner',{generation:'initial',identity,resource,group:'related'}));
  assert.equal(first.repeated,false);assert.equal(replay.repeated,true);
  assert.deepEqual(readOriginalWorkAffinity(h.sql,'new-owner',identity,'initial'),{generation:'initial',resource,group:'related'});
  assert.throws(()=>h.transaction(()=>takeOriginalWorkAffinity(h.sql,'new-owner',{generation:'initial',identity,resource:{owner:'new-owner',resource:'other'},group:'related'})),{code:'resource_selection_conflict'});
 }finally{h.db.close();}
});

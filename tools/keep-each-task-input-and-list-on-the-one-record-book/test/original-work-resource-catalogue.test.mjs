import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {originalWorkResourceCatalogue} from '../src/original-work-resource-catalogue.mjs';
test('native catalogue pages actual installations without whole-registry reads and isolates erased generations',()=>{
 const h=sqliteHost(':memory:');try{
  const catalogue=originalWorkResourceCatalogue(h.sql,h.transaction,'person:7');
  for(let i=0;i<203;i++)catalogue.install({generation:'initial',resource_key:String(i).padStart(4,'0'),resource:`work:${i}`});
  const first=catalogue.page('initial',{limit:100});assert.equal(first.resources.length,100);assert.equal(first.after,'0099');
  const second=catalogue.page('initial',{after:first.after,limit:100});assert.equal(second.resources.length,100);
  const last=catalogue.page('initial',{after:second.after,limit:100});assert.equal(last.resources.length,3);assert.equal(last.after,null);
  assert.deepEqual(catalogue.page('erased:2',{limit:100}).resources,[]);
  assert.throws(()=>catalogue.page('initial',{limit:101}),/at most100/);
  catalogue.carryPage({generation:'erased:2',resources:[{resource_key:'new',resource:'work:new'}],after:null});
  assert.equal(catalogue.carryState('erased:2').complete,1);
  assert.deepEqual(catalogue.page('erased:2').resources.map(row=>row.resource),['work:new']);
 }finally{h.db.close();}
});

test('legacy carry reuses a resource already registered under another key without losing key ownership',()=>{
 const h=sqliteHost(':memory:');try{
  const catalogue=originalWorkResourceCatalogue(h.sql,h.transaction,'person:7');
  catalogue.install({generation:'initial',resource_key:'derived-key',resource:'work:a'});
  const carried={generation:'initial',resources:[{resource_key:'legacy-key',resource:'work:a'}],after:null};
  catalogue.carryPage(carried);
  catalogue.carryPage(carried);
  assert.deepEqual(catalogue.page('initial').resources.map(row=>[row.resource_key,row.resource]),[['derived-key','work:a']]);
  assert.equal(catalogue.carryState('initial').complete,1);
  assert.throws(()=>catalogue.install({generation:'initial',resource_key:'derived-key',resource:'work:b'}),/different original resource/);
 }finally{h.db.close();}
});

// 2026-10-20: one resource that could never publish was the first every list read asked, so every list read of the
// founder account failed or answered "catching up" for hours. A read passes it over for held_ms, saying why.
test('a resource a read could not publish is passed over with its reason, asked again later, and cleared by its next page', async t => {
  const { default: heldRule } = await import('../../original-work-collection-held/src/original-work-collection-held.json', { with: { type: 'json' } });
  const h=sqliteHost(':memory:');try{
   const catalogue=originalWorkResourceCatalogue(h.sql,h.transaction,'person:7');
   for(const resource of ['@own-records','work:b'])catalogue.install({generation:'initial',resource_key:resource,resource});
   catalogue.publish('initial','work:b',{references:[{kind:'lists',id:'b',resource:'work:b',source_id:'list:b',sort_at:''}],removed:[],complete:true,asynchronous:true});
   assert.deepEqual(catalogue.collectionPage('initial',{kinds:['lists']}).needs_projection.map(row=>row.resource),['@own-records'],'the own records not ready keep every read waiting');
   catalogue.hold('initial','@own-records','A collection identity belongs to conflicting resources');
   const read=catalogue.collectionPage('initial',{kinds:['lists']});
   assert.deepEqual(read.needs_projection,[]);
   assert.deepEqual(read.references.map(row=>row.id),['b'],'the read answers from the rest');
   assert.deepEqual(read.held.map(row=>[row.resource,row.failures,row.reason]),[['@own-records',1,'A collection identity belongs to conflicting resources']]);
   t.mock.timers.enable({apis:['Date'],now:Date.now()+heldRule.held_ms+1});
   assert.deepEqual(catalogue.collectionPage('initial',{kinds:['lists']}).needs_projection.map(row=>row.resource),['@own-records'],'it is asked again after held_ms');
   t.mock.timers.reset();
   catalogue.hold('initial','@own-records','again');
   catalogue.publish('initial','@own-records',{references:[],removed:[],complete:true,asynchronous:true});
   const after=catalogue.collectionPage('initial',{kinds:['lists']});
   assert.deepEqual([after.needs_projection,after.held],[[],[]],'its own page clears it');
  }finally{h.db.close();}
});

// 2026-10-20: 168 work books and the own records answered a cold first call busy and were each passed over for 10 minutes,
// cold again by then. A busy answer is passed over for busy_held_ms only.
test('a resource that answered busy is passed over only briefly', async t => {
  const { default: heldRule } = await import('../../original-work-collection-held/src/original-work-collection-held.json', { with: { type: 'json' } });
  const h=sqliteHost(':memory:');try{
   const catalogue=originalWorkResourceCatalogue(h.sql,h.transaction,'person:7');
   catalogue.install({generation:'initial',resource_key:'@own-records',resource:'@own-records'});
   const {until}=catalogue.hold('initial','@own-records','These records are catching up. Try again in a moment.',{busy:true});
   assert.ok(until<=Date.now()+heldRule.busy_held_ms&&heldRule.busy_held_ms<heldRule.held_ms);
   assert.deepEqual(catalogue.collectionPage('initial',{kinds:['lists']}).needs_projection,[]);
   t.mock.timers.enable({apis:['Date'],now:Date.now()+heldRule.busy_held_ms+1});
   assert.deepEqual(catalogue.collectionPage('initial',{kinds:['lists']}).needs_projection.map(row=>row.resource),['@own-records'],'it is asked again after busy_held_ms');
  }finally{h.db.close();}
});

test('a resource whose lists are whole answers a lists read before the rest of its first carry', () => {
 const h=sqliteHost(':memory:');try{
  const catalogue=originalWorkResourceCatalogue(h.sql,h.transaction,'person:7');
  catalogue.install({generation:'initial',resource_key:'own',resource:'@own-records'});
  catalogue.publish('initial','@own-records',{references:[{kind:'lists',id:'waiting-on-you',resource:'@own-records',source_id:'list:waiting-on-you',sort_at:''}],removed:[],complete:false,asynchronous:true,complete_kinds:['lists']});
  const lists=catalogue.collectionPage('initial',{kinds:['lists']});
  assert.deepEqual([lists.needs_projection,lists.references.map(row=>row.id)],[[],['waiting-on-you']]);
  assert.deepEqual(catalogue.collectionPage('initial',{kinds:['messages']}).needs_projection.map(row=>row.resource),['@own-records'],'its messages still wait');
 }finally{h.db.close();}
});

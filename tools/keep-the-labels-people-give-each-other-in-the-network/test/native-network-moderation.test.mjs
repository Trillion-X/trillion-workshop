import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import rules from '../../introduce-two-people/src/network-settings.json' with {type:'json'};
import {nativeNetworkModeration,nativeNetworkModerationResource,hiddenFor,nativeModerationReporterIndex,nativeModerationReporterQuery} from '../src/native-network-moderation.mjs';

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const reads=[];
 const sql={exec(query,...args){const statement=db.prepare(query),rows=/^\s*(select|pragma|explain)/i.test(query)?statement.all(...args):(statement.run(...args),[]);if(/FROM labels\b/.test(query))reads.push(rows.length);return {toArray:()=>rows};}};
 const transaction=run=>{db.exec('BEGIN');try{const result=run();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
 const resource=nativeNetworkModerationResource('target');let accepted=true,adjacent=new Set(),duringTrust=()=>{};
 const actor={owner:'owner-a',claims:{sign_in:'key:a'},permit_id:'permit:a',shared_relay:'a',resource:'participant:moderation',commitment:{resource,address:resource}};
 const original={target:'target',resource,source:'source:target',generation:'one',fenced:true};
 const source={begin:async()=>original,page:async()=>({...original,rows:[],exhausted:true}),retire:async()=>({...original,retired:true})};
 const options={sql,transaction,target:'target',resource,context:()=>actor,relay:()=>actor.shared_relay,current:async()=>{if(!accepted)throw Object.assign(new Error('rights withdrawn'),{status:403});},source,
  neighbours:async()=>{duringTrust();return adjacent;}};
 const api=nativeNetworkModeration(options);
 return {api,actor,sql,reads,options,reopen:()=>nativeNetworkModeration(options),as:by=>{actor.shared_relay=by;actor.owner=`owner-${by}`;actor.claims.sign_in=`key:${by}`;actor.permit_id=`permit:${by}`;},adjacent:value=>{adjacent=new Set(value);},duringTrust:run=>{duringTrust=run;},revoke:()=>{accepted=false;}};
}
async function ready(api){assert.equal((await api.carry()).ready,false);assert.equal((await api.carry()).ready,true);}

test('target-local labels preserve distinct reporter and current one-step hiding semantics',async t=>{
 const f=fixture(t);await ready(f.api);
 await f.api.label({relay:'target',label:'unsafe',by:'forged'});
 await f.api.label({relay:'target',label:'unwanted-requests'});
 await f.api.label({relay:'target',label:'unsafe'});
 assert.equal(f.sql.exec('SELECT by_relay FROM labels WHERE label=?','unsafe').toArray()[0].by_relay,'a');
 assert.deepEqual(await f.api.hidden({relay:'target',asker:'a'}),{hidden:false},'two labels from one reporter count once');
 f.as('b');await f.api.label({relay:'target',label:'vouched'});
 f.as('reader');f.adjacent(['a']);assert.deepEqual(await f.api.hidden({relay:'target',asker:'reader'}),{hidden:true});
 f.adjacent(['b']);assert.deepEqual(await f.api.hidden({relay:'target',asker:'reader'}),{hidden:false},'non-hiding labels do not suppress neighbours');
 f.as('b');await f.api.label({relay:'target',label:'unsafe'});f.as('c');await f.api.label({relay:'target',label:'unsafe'});
 f.as('reader');f.adjacent([]);assert.deepEqual(await f.api.hidden({relay:'target',asker:'reader'}),{hidden:true});
 assert.ok(f.reads.every(rows=>rows<=3),'visibility returns at most threshold reporter rows and one local hit');
 const labels=f.sql.exec('SELECT relay,label,by_relay AS by FROM labels').toArray();assert.equal(hiddenFor(labels,'target',new Set()),true);
});

test('history and retraction belong to the original admitted reporter and survive restart',async t=>{
 const f=fixture(t);await ready(f.api);await f.api.label({relay:'target',label:'unsafe'});await f.api.label({relay:'target',label:'unsafe'});
 assert.equal((await f.api.ownHistory()).changes.length,1,'replay preserves one original change');
 f.as('b');assert.deepEqual((await f.api.ownHistory()).changes,[]);await f.api.retract({relay:'target',label:'unsafe',by:'a'});
 assert.equal(f.sql.exec('SELECT 1 FROM labels WHERE by_relay=?','a').toArray().length,1,'retraction cannot substitute an author');
 f.as('a');await f.reopen().retract({relay:'target',label:'unsafe'});
 assert.deepEqual((await f.api.ownHistory()).changes.map(row=>row.action),['label','retract']);
 assert.equal(f.sql.exec('SELECT 1 FROM labels LIMIT 1').toArray().length,0);
});

test('revocation, changed command actor and cross-target substitutions fail closed',async t=>{
 const f=fixture(t);await ready(f.api);
 await assert.rejects(f.api.label({relay:'another',label:'unsafe'}),/another target/);
 await assert.rejects(f.api.hidden({relay:'target',asker:'another'}),/substitute/);
 await assert.rejects(f.api.label({relay:'target',label:'unknown'}),/label is one of/);
 f.duringTrust(()=>f.as('changed'));await assert.rejects(f.api.hidden({relay:'target',asker:'a'}),/reader changed/);
 f.duringTrust(()=>{});f.revoke();await assert.rejects(f.api.label({relay:'target',label:'unsafe'}),/rights withdrawn/);
});

test('current moderation is evaluated after the asynchronous trust lookup',async t=>{
 const f=fixture(t);await ready(f.api);
 f.duringTrust(()=>{for(const by of ['a','b','c'])f.sql.exec('INSERT INTO labels VALUES(?,?,?,?)','target','unsafe',by,'2026-10-15');});
 assert.deepEqual(await f.api.hidden({relay:'target',asker:'a'}),{hidden:true});
 f.duringTrust(()=>f.revoke());await assert.rejects(f.api.hidden({relay:'target',asker:'a'}),/rights withdrawn/);
});

test('source pages require exact ordered target data and exhaustion before activation',async t=>{
 const f=fixture(t);f.options.source.page=async()=>({source:'source:target',generation:'one',rows:[],exhausted:false});
 await assert.rejects(f.api.carry(),/advance or prove/);assert.equal(f.api.status().rows,0);
 f.options.source.page=async()=>({source:'source:target',generation:'one',rows:[{relay:'other',label:'unsafe',by_relay:'a',at:'2026-10-15'}],exhausted:true});
 await assert.rejects(f.api.carry(),/exact ordered target/);
 await assert.rejects(f.api.label({relay:'target',label:'unsafe'}),/bounded carry/);
});

test('bounded reporter matching retains an opaque reader-bound continuation and never turns unfinished trust into false absence',async t=>{
 const f=fixture(t);let calls=0;f.options.trust={matching:async input=>{calls++;assert.deepEqual(input.candidates,['a']);return input.after===null?{matches:[],revision:4,next:{after:'space-16',revision:4},complete:false}:{matches:['a'],revision:4,next:null,complete:true};}};
 const api=f.reopen();await ready(api);await api.label({relay:'target',label:'unsafe'});
 const pending=await api.hidden({relay:'target',asker:'a'});assert.equal(pending.hidden,undefined);assert.equal(pending.pending,true);assert.match(pending.continuation,/^moderation-visibility:/);
 f.as('b');await assert.rejects(api.hidden({relay:'target',asker:'b',continuation:pending.continuation}),/another original reader/);
 f.as('a');assert.deepEqual(await api.hidden({relay:'target',asker:'a',continuation:pending.continuation}),{hidden:true});assert.equal(calls,2);
 assert.equal(f.sql.exec('SELECT 1 FROM native_moderation_visibility').toArray().length,0);
});


test('actual rules-derived reporter query seeks an ordered partial index without scanning non-hiding labels or sorting',t=>{
 const f=fixture(t),hiding=rules.labels.filter(row=>row.hides).map(row=>row.id),visible=rules.labels.find(row=>!row.hides).id;
 for(let i=0;i<256;i++)f.sql.exec('INSERT INTO labels VALUES(?,?,?,?)','target',visible,`non-hiding-${String(i).padStart(3,'0')}`,'2026-10-15');
 for(let i=0;i<5;i++)for(const label of hiding)f.sql.exec('INSERT INTO labels VALUES(?,?,?,?)','target',label,`reporter-${i}`,'2026-10-15');
 const index=f.sql.exec("SELECT sql FROM sqlite_master WHERE type='index' AND name=?",nativeModerationReporterIndex).toArray()[0].sql;
 assert.match(index,/ON labels\(relay,by_relay,label\) WHERE label IN\(/);
 for(const label of hiding)assert.ok(index.includes(`'${label}'`));assert.equal(index.includes(`'${visible}'`),false);
 const plan=f.sql.exec(`EXPLAIN QUERY PLAN ${nativeModerationReporterQuery}`,'target',rules.hide_after_labelers).toArray().map(row=>row.detail).join(' ');
 assert.ok(plan.includes(`SEARCH labels USING COVERING INDEX ${nativeModerationReporterIndex} (relay=?)`),plan);
 assert.equal(/TEMP B-TREE|SCAN /.test(plan),false,plan);
 const rows=f.sql.exec(nativeModerationReporterQuery,'target',rules.hide_after_labelers).toArray();
 assert.deepEqual(rows.map(row=>row.by_relay),Array.from({length:rules.hide_after_labelers},(_,i)=>`reporter-${i}`));
});

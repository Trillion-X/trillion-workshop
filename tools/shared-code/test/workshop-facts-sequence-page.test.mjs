// Ported from old trillion test/workshop-facts-sequence-page.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The tests are the old ones over src/workshop-facts.mjs here, on the store host and
// table generations of keep-and-wake-ai-sessions-on-this-computer. The physical-carry test used old src/resource-state-carry.mjs
// (resourceStateSource/Destination), which no repository keeps (searched those names in trillion-workshop tools/,
// trillion-rust src/, trillion-apps web/), so it is left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {dropTables} from '../../keep-and-wake-ai-sessions-on-this-computer/src/table-generation.mjs';
import {addWorkshopFact,forgetWorkshopFacts,forgetWorkshopSetup,workshopCurrentIndex,workshopValues,
 workshopValuesSequenceRevision,workshopValuesSequencePage} from '../src/workshop-facts.mjs';

const prefix='marketplace-install:',at='2026-10-15T16:48:00.000Z';
const entity=id=>`${prefix}${String(id).padStart(4,'0')}`;
const installation=(id,extra={})=>({id:`marketplace-install:private:fixture-${id}`,configuration_id:`fixture-${id}`,context:'private',...extra});
function fixture(t){
 const host=sqliteHost(':memory:');t.after(()=>host.db.close());
 host.sql.exec('CREATE TABLE workshop_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL)');
 host.sql.exec('CREATE INDEX workshop_facts_current ON workshop_facts(entity,seq)');
 const trace=[];let duringValues=null;
 const sql={exec(query,...params){
  const cursor=host.sql.exec(query,...params),entry={query,params};trace.push(entry);
  return {toArray(){const rows=cursor.toArray();entry.rows=rows;
   if(duringValues&&query.startsWith('SELECT seq,entity,value FROM workshop_facts')){const hook=duringValues;duringValues=null;hook();}
   return rows;
  }};
 }};
 const transaction=work=>{try{return host.transaction(work);}catch(error){forgetWorkshopSetup(sql);throw error;}};
 const raw=(key,value)=>host.sql.exec('INSERT INTO workshop_facts(at,entity,value) VALUES(?,?,?) RETURNING seq',at,key,JSON.stringify(value)).toArray()[0].seq;
 const add=(key,value)=>transaction(()=>addWorkshopFact(sql,key,value,at));
 return {host,sql,trace,transaction,raw,add,onValues:hook=>{duringValues=hook;}};
}
function oldCurrent(f,rows){
 f.host.sql.exec('CREATE TABLE workshop_current(entity TEXT PRIMARY KEY,seq INTEGER NOT NULL,kind TEXT,scope TEXT,due INTEGER,expires INTEGER) WITHOUT ROWID');
 f.host.sql.exec('CREATE TABLE workshop_current_filled(id INTEGER PRIMARY KEY CHECK(id=1),after TEXT NOT NULL,done INTEGER NOT NULL)');
 f.host.sql.exec('CREATE TABLE workshop_current_summaries_filled(kind TEXT PRIMARY KEY,after TEXT NOT NULL,done INTEGER NOT NULL) WITHOUT ROWID');
 for(const row of rows)f.host.sql.exec('INSERT INTO workshop_current(entity,seq,kind) VALUES(?,?,NULL)',row.entity,row.seq);
 f.host.sql.exec("INSERT INTO workshop_current_filled(id,after,done) VALUES(1,'',1)");
}
function finish(f,sql=f.sql){
 const owner=workshopCurrentIndex(sql,{transaction:f.transaction,now:()=>17});
 for(let wake=0;wake<200&&owner.nextAt()!==null;wake++)owner.step();
 assert.equal(owner.nextAt(),null,'the existing current-index source exhausts its bounded work');
 return owner;
}
function allPages(sql,limit=3){
 const values=[];let after_seq=0,revision;
 for(let pageNumber=0;pageNumber<200;pageNumber++){
  const page=workshopValuesSequencePage(sql,prefix,{after_seq,limit,revision});
  values.push(...page.rows.map(row=>row.value));
  assert.equal(page.complete,page.next_after_seq===null);
  if(page.complete)return values;
  assert.ok(page.next_after_seq>after_seq);after_seq=page.next_after_seq;revision=page.revision;
 }
 throw Error('A finite fixture did not exhaust its actual sequence.');
}

test('sequence pages preserve canonical latest-write order, tombstones, exact-prefix values and installation history',t=>{
 const f=fixture(t);
 f.add(entity('z'),installation('z'));f.add(entity('a'),installation('a'));
 f.add(prefix,{fixture:'literal prefix value'});
 f.add(entity('z'),installation('z',{without:['tool:fixture']}));
 f.add(entity('b'),installation('b',{removed_at:at}));
 f.add('unrelated:one',{secret:'unrelated fixture'});
 assert.deepEqual(allPages(f.sql,2),workshopValues(f.sql,prefix));
 const values=allPages(f.sql,2);assert.deepEqual(values.map(row=>row.id??row.fixture),[
  installation('a').id,'literal prefix value',installation('z').id,installation('b').id]);
 assert.equal(values.at(-1).removed_at,at,'raw advancement includes removed rows for the consumer to filter');
 assert.equal(f.host.sql.exec('SELECT COUNT(*) AS n FROM workshop_facts WHERE entity=?',entity('z')).toArray()[0].n,2);
 assert.equal(f.host.sql.exec('SELECT kind FROM workshop_current WHERE entity=?',entity('z')).toArray()[0].kind,prefix);
 assert.throws(()=>workshopValues(f.sql,prefix,{newest:1}),/not a kind/,'sequence registration does not alter timing KINDS');
});

test('sequence read uses the existing covering index and bounded selected bodies through unrelated growth',t=>{
 for(const count of [1000,4000]){
  const f=fixture(t);
  f.transaction(()=>{
   for(let i=0;i<count;i++)addWorkshopFact(f.sql,`unrelated:${String(i).padStart(5,'0')}`,{text:'Unrelated stored fixture.'},at);
   for(let i=0;i<8;i++)addWorkshopFact(f.sql,entity(i),installation(i),at);
  });
  f.trace.length=0;
  const page=workshopValuesSequencePage(f.sql,prefix,{limit:3});assert.equal(page.rows.length,3);assert.equal(page.complete,false);
  const picked=f.trace.find(row=>row.query.startsWith('SELECT entity,seq FROM workshop_current WHERE kind='));
  assert.equal(picked.rows.length,4);
  const plan=f.host.sql.exec(`EXPLAIN QUERY PLAN ${picked.query}`,...picked.params).toArray().map(row=>row.detail).join('\n');
  assert.match(plan,/SEARCH workshop_current USING COVERING INDEX workshop_current_newest \(kind=\? AND seq>\?\)/);
  assert.doesNotMatch(plan,/SCAN workshop_current|TEMP B-TREE/);
  const bodies=f.trace.filter(row=>row.query.startsWith('SELECT seq,entity,value FROM workshop_facts'));
  assert.equal(bodies.length,1);assert.equal(bodies[0].rows.length,3);
  assert.ok(bodies[0].rows.every(row=>row.entity.startsWith(prefix)));
  assert.equal(f.trace.some(row=>/MAX\(|COUNT\(|OFFSET|GROUP BY/.test(row.query)),false);
 }
});

test('old completed current index fills sequence classification one bounded page per existing wake across cold reopen',t=>{
 const f=fixture(t),rows=[];
 f.host.transaction(()=>{
  for(let i=0;i<130;i++){
   f.raw(entity(i),installation(i,{edition:'earlier'}));
   rows.push({entity:entity(i),seq:f.raw(entity(i),installation(i))});
  }
 });
 oldCurrent(f,rows);
 assert.throws(()=>workshopValuesSequencePage(f.sql,prefix,{limit:2}),error=>error.workshop_sequence_pending===true);
 const mark=()=>f.host.sql.exec('SELECT after,done,revision FROM workshop_current_summaries_filled WHERE kind=?',prefix).toArray()[0];
 assert.equal(mark().after,entity(63));assert.equal(mark().done,0);
 const revision=mark().revision;assert.ok(revision);
 assert.throws(()=>workshopValuesSequenceRevision(f.sql,prefix),error=>error.workshop_sequence_pending===true);
 assert.equal(f.trace.filter(row=>row.query.startsWith('SELECT seq,entity,value FROM workshop_facts')).length,0);
 f.add(entity(10),installation(10,{edition:'current concurrent write'}));
 f.transaction(()=>forgetWorkshopFacts(f.sql,{entity:entity(100)}));
 const changed=mark().revision;assert.notEqual(changed,revision);
 const coldSql={exec:(...args)=>f.host.sql.exec(...args)};
 const owner=workshopCurrentIndex(coldSql,{transaction:f.transaction,now:()=>17});
 assert.equal(owner.nextAt(),17);owner.step();assert.equal(mark().after,entity(128));assert.equal(mark().done,0);
 owner.step();assert.equal(owner.nextAt(),null);assert.equal(mark().revision,changed);
 assert.deepEqual(allPages(coldSql,7),workshopValues(coldSql,prefix));
 assert.equal(allPages(coldSql,7).length,129);
 assert.equal(f.host.sql.exec('SELECT COUNT(*) AS n FROM workshop_facts WHERE entity=?',entity(10)).toArray()[0].n,3,'classification never prunes original versions');
 assert.equal(workshopValues(coldSql,entity(100)).length,0,'a forgotten future row cannot return during backfill');
});

test('unfinished global fill never yields a false empty sequence and its scheduler retains bounded recovery',t=>{
 const f=fixture(t);
 for(let i=0;i<130;i++)f.raw(`earlier:${String(i).padStart(4,'0')}`,{old:true});
 f.raw(entity(1),installation(1));
 assert.throws(()=>workshopValuesSequencePage(f.sql,prefix),error=>error.workshop_current_pending===true);
 assert.throws(()=>workshopValuesSequenceRevision(f.sql,prefix),error=>error.workshop_sequence_pending===true);
 const fills=f.trace.filter(row=>row.query.includes('WITH RECURSIVE workshop_fill'));assert.equal(fills.length,1);assert.ok(fills[0].rows.length<=64);
 finish(f);assert.deepEqual(allPages(f.sql),[installation(1)]);
});

test('backfill rollback and cold retry retain only committed cursor/schema state',t=>{
 const f=fixture(t),rows=[];
 for(let i=0;i<70;i++)rows.push({entity:entity(i),seq:f.raw(entity(i),installation(i))});
 oldCurrent(f,rows);
 assert.throws(()=>f.transaction(()=>workshopValuesSequencePage(f.sql,prefix)),error=>error.workshop_sequence_pending===true);
 assert.equal(f.host.sql.exec('SELECT kind FROM workshop_current WHERE entity=?',entity(1)).toArray()[0].kind,null);
 assert.equal(f.host.sql.exec('PRAGMA table_info(workshop_current_summaries_filled)').toArray().some(row=>row.name==='revision'),false);
 finish(f);assert.equal(allPages(f.sql,9).length,70);
 const revision=workshopValuesSequenceRevision(f.sql,prefix);
 assert.throws(()=>f.transaction(()=>{f.add(entity(999),installation(999));forgetWorkshopFacts(f.sql,{entity:entity(0)});throw Error('fixture outer rollback');}),/outer rollback/);
 assert.equal(workshopValuesSequenceRevision(f.sql,prefix),revision);
 assert.equal(allPages(f.sql,9).length,70);
});

test('append, identical rewrite and exact or prefix forget invalidate old continuation revisions across cold handles',t=>{
 const f=fixture(t);for(let i=0;i<5;i++)f.add(entity(i),installation(i));
 let first=workshopValuesSequencePage(f.sql,prefix,{limit:2});
 f.add(entity(0),installation(0));
 assert.throws(()=>workshopValuesSequencePage(f.sql,prefix,{after_seq:first.next_after_seq,limit:2,revision:first.revision}),error=>error.workshop_sequence_changed===true);
 first=workshopValuesSequencePage(f.sql,prefix,{limit:2});
 f.transaction(()=>forgetWorkshopFacts(f.sql,{entity:entity(1)}));
 const cold={exec:(...args)=>f.host.sql.exec(...args)};
 assert.throws(()=>workshopValuesSequencePage(cold,prefix,{after_seq:first.next_after_seq,limit:2,revision:first.revision}),error=>error.status===409);
 const before=workshopValuesSequenceRevision(cold,prefix);
 f.add('unrelated:mutation',{ok:true});assert.equal(workshopValuesSequenceRevision(cold,prefix),before);
 f.transaction(()=>forgetWorkshopFacts(f.sql,{prefix}));
 assert.throws(()=>workshopValuesSequencePage(cold,prefix,{revision:before}),error=>error.status===409);
 const empty=workshopValuesSequencePage(cold,prefix);assert.equal(empty.complete,true);assert.deepEqual(empty.rows,[]);assert.notEqual(empty.revision,before);
});

test('mutation during value hydration withholds the whole source frame',t=>{
 const f=fixture(t);for(let i=0;i<3;i++)f.add(entity(i),installation(i));
 f.onValues(()=>f.add(entity(2),installation(2,{without:['tool:concurrent']})));
 assert.throws(()=>workshopValuesSequencePage(f.sql,prefix,{limit:2}),error=>error.status===409&&error.workshop_sequence_changed===true);
 assert.equal(allPages(f.sql).at(-1).without[0],'tool:concurrent');
});

test('bounded final revision fence composes after awaited rights and never grants authority itself',async t=>{
 const f=fixture(t);f.add(entity(1),installation(1));let allowed=true;
 // Caller protocol only: native admission remains the parent's actual owner.
 const frameAfterRights=async pending=>{
  const page=workshopValuesSequencePage(f.sql,prefix);
  await pending();
  if(!allowed)throw Object.assign(Error('Fixture current rights withdrawn.'),{status:403});
  if(workshopValuesSequenceRevision(f.sql,prefix)!==page.revision)throw Object.assign(Error('Fixture source changed after rights await.'),{status:409});
  return page;
 };
 await assert.rejects(frameAfterRights(async()=>{allowed=false;}),error=>error.status===403);
 allowed=true;await assert.rejects(frameAfterRights(async()=>{f.add(entity(2),installation(2));}),error=>error.status===409);
 assert.equal((await frameAfterRights(async()=>{})).rows.length,2);
});

test('physical reset cannot recreate an earlier revision even when values and seq repeat',t=>{
 const f=fixture(t);f.add(entity(1),installation(1));const before=workshopValuesSequencePage(f.sql,prefix);
 const tables=f.host.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray();
 for(const row of tables)f.host.sql.exec(`DROP TABLE "${row.name.replaceAll('"','""')}"`);
 dropTables(f.sql);
 f.host.sql.exec('CREATE TABLE workshop_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL)');
 f.host.sql.exec('CREATE INDEX workshop_facts_current ON workshop_facts(entity,seq)');
 f.add(entity(1),installation(1));const after=workshopValuesSequencePage(f.sql,prefix);
 assert.deepEqual(after.rows,before.rows);assert.notEqual(after.revision,before.revision);
 assert.throws(()=>workshopValuesSequencePage(f.sql,prefix,{revision:before.revision}),error=>error.status===409);
});

test('sequence cursors reject unsupported prefixes, missing revisions and invalid source bounds',t=>{
 const f=fixture(t);f.add(entity(1),installation(1));
 for(const query of [{limit:0},{limit:65},{limit:1.5},{after_seq:-1},{after_seq:1},{revision:''},{revision:3}])
  assert.throws(()=>workshopValuesSequencePage(f.sql,prefix,query),error=>error.status===400);
 assert.throws(()=>workshopValuesSequencePage(f.sql,'unregistered:'),error=>error.status===400);
 assert.throws(()=>workshopValuesSequenceRevision(f.sql,'task:'),error=>error.status===400);
});
